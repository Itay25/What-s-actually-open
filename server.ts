import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import axios from "axios";
import "dotenv/config";
import logger from "./src/utils/logger";
import firebaseConfig from "./firebase-applet-config.json" with { type: "json" };
//import serviceAccount from "./serviceAccountKey.json" with { type: "json" };

// Lazy initialization for Firebase Admin
let dbInstance: admin.firestore.Firestore | null = null;
let adminApp: admin.app.App | null = null;

function getDb() {
  if (!dbInstance) {
    try {
      if (!admin.apps.length) {
        logger.info("Initializing Firebase Admin...");

        let credential;

        // בדיקה: האם אנחנו ב-Render?
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
          logger.info("Loading credentials from Environment Variable (Render Mode)");
          // אנחנו הופכים את הטקסט מהמשתנה ל-JSON אמיתי
          const serviceAccountValue = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
          credential = admin.credential.cert(serviceAccountValue);
        } else {
          // אם אנחנו במחשב שלך (פיתוח מקומי)
          logger.info("Loading credentials from local file (Dev Mode)");
          const fs = require('fs');
          const rawData = fs.readFileSync('./serviceAccountKey.json', 'utf8');
          credential = admin.credential.cert(JSON.parse(rawData));
        }

        adminApp = admin.initializeApp({
          credential: credential
        });
      } else {
        adminApp = admin.apps[0]!;
      }

      dbInstance = getFirestore(adminApp);
      logger.info("Firestore connected successfully.");
    } catch (error) {
      logger.error("Critical error initializing Firebase Admin:", error);
    }
  }
  return dbInstance;
}

// --- Global API Usage Buffer Logic ---
const apiCallsBuffer = new Map<string, number>();
let lastFlushTime = Date.now();
const FLUSH_THRESHOLD = 10;
const FLUSH_INTERVAL = 60000;
let isFlushing = false;

async function flushGlobalApiUsage() {
  if (isFlushing) return;
  
  const db = getDb();
  if (!db) return;
  
  let totalToFlush = 0;
  for (const count of apiCallsBuffer.values()) {
    totalToFlush += count;
  }
  if (totalToFlush === 0) return;

  isFlushing = true;
  try {
    logger.info(`Flushing global API usage buffer: ${totalToFlush} calls total`);

    // Capture current state and clear buffer immediately to avoid double-counting
    const snapshot = new Map(apiCallsBuffer);
    apiCallsBuffer.clear();
    lastFlushTime = Date.now();

    for (const [date, count] of snapshot.entries()) {
      if (count <= 0) continue;
      try {
        const globalRef = db.collection("globalApiUsage").doc(date);
        await globalRef.set({ 
          count: admin.firestore.FieldValue.increment(count), 
          date 
        }, { merge: true });
        logger.debug(`Successfully flushed ${count} calls for ${date}`);
      } catch (error: any) {
        logger.error(`Error flushing globalApiUsage for ${date}:`, error.message);
        // Restore failed counts to buffer
        apiCallsBuffer.set(date, (apiCallsBuffer.get(date) || 0) + count);
      }
    }
  } finally {
    isFlushing = false;
  }
}

// Exit handlers to ensure data is not lost
process.on("SIGINT", async () => {
  logger.info("Received SIGINT. Flushing buffer before exit...");
  await flushGlobalApiUsage();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM. Flushing buffer before exit...");
  await flushGlobalApiUsage();
  process.exit(0);
});

process.on("beforeExit", async () => {
  await flushGlobalApiUsage();
});
// --------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const MAX_GOOGLE_CALLS_PER_USER_PER_DAY = 1;
  const MAX_GOOGLE_CALLS_PER_DAY = 200;

  const inFlightRequests = new Map<string, Promise<any>>();

  function normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  async function checkApiUsage(userId: string) {
    const db = getDb();
    if (!db) {
      logger.warn("Database not initialized. Skipping API usage check.");
      return { allowed: true };
    }

    const today = new Date().toISOString().split('T')[0];

    try {
      // 1. Global Limit Check
      const globalRef = db.collection("globalApiUsage").doc(today);
      const globalDoc = await globalRef.get();
      const dbCount = globalDoc.exists ? globalDoc.data()?.count || 0 : 0;
      
      // Account for buffered calls not yet in Firestore
      const bufferedCount = apiCallsBuffer.get(today) || 0;
      const totalCount = dbCount + bufferedCount;

      if (totalCount >= MAX_GOOGLE_CALLS_PER_DAY) {
        return { allowed: false, error: "New place searches are temporarily unavailable today." };
      }

      // 2. User Limit Check
      const userUsageRef = db.collection("userApiUsage").doc(`${userId}_${today}`);
      const userUsageDoc = await userUsageRef.get();
      const userCount = userUsageDoc.exists ? userUsageDoc.data()?.count || 0 : 0;

      if (userCount >= MAX_GOOGLE_CALLS_PER_USER_PER_DAY) {
        return { allowed: false, error: "Daily search limit reached for discovering new places." };
      }

      return { allowed: true };
    } catch (error: any) {
      logger.error("Firestore Error in checkApiUsage:", error.message);
      // If Firestore is misconfigured, we allow the request but log the error
      if (error.message.includes("PERMISSION_DENIED") || error.message.includes("API has not been used")) {
        logger.warn("Firestore is misconfigured or API is disabled. Proceeding without usage limits.");
        return { allowed: true };
      }
      throw error;
    }
  }

  async function incrementApiUsage(userId: string) {
    const db = getDb();
    if (!db) {
      logger.warn("Database not initialized. Skipping usage increment.");
      return;
    }

    const today = new Date().toISOString().split('T')[0];
    const userUsageRef = db.collection("userApiUsage").doc(`${userId}_${today}`);

    try {
      // Increment local buffer for global usage
      apiCallsBuffer.set(today, (apiCallsBuffer.get(today) || 0) + 1);

      // Update user usage immediately (per-user sharding)
      await userUsageRef.set({ 
        count: admin.firestore.FieldValue.increment(1), 
        userId, 
        date: today 
      }, { merge: true });

      logger.debug(`API usage incremented for user ${userId}`);

      // Check if we should flush the global buffer
      let totalBuffered = 0;
      for (const count of apiCallsBuffer.values()) {
        totalBuffered += count;
      }

      if (totalBuffered >= FLUSH_THRESHOLD || (Date.now() - lastFlushTime) >= FLUSH_INTERVAL) {
        flushGlobalApiUsage().catch(err => logger.error("Async flush error:", err));
      }
    } catch (error: any) {
      logger.error("Error incrementing API usage:", error.message);
      // Just log the error, don't crash the request
    }
  }

  // API Route for Google Places Search (Text Search)
  app.post("/api/places/search", async (req, res) => {
    const { userId, query, locationBias, languageCode } = req.body;

    if (!userId || !query) {
      return res.status(400).json({ error: "Missing userId or query" });
    }

    const normalizedQuery = normalizeQuery(query);
    const lockKey = `search:${normalizedQuery}:${JSON.stringify(locationBias)}:${languageCode || 'he'}`;

    // In-flight lock
    if (inFlightRequests.has(lockKey)) {
      try {
        const result = await inFlightRequests.get(lockKey);
        return res.json(result);
      } catch (error: any) {
        return res.status(error.response?.status || 500).json({ error: "Internal server error" });
      }
    }

    const requestPromise = (async () => {
      try {
        // Protection Layer - Check only
        const usage = await checkApiUsage(userId);
        if (!usage.allowed) {
          throw { status: 429, message: usage.error };
        }

        const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
        if (!apiKey) {
          throw { status: 500, message: "Server configuration error" };
        }

        const body: any = {
          textQuery: normalizedQuery,
          maxResultCount: 10,
          languageCode: languageCode || "he"
        };

        if (locationBias) {
          body.locationBias = locationBias;
        }

        const response = await axios.post(
          "https://places.googleapis.com/v1/places:searchText",
          body,
          {
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": apiKey,
              "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.regularOpeningHours,places.types,places.photos"
            }
          }
        );

        const data = response.data;
        
        // Safe Increment: Only after success and valid results
        if (data && data.places && data.places.length > 0) {
          await incrementApiUsage(userId);
        }

        return data;
      } catch (error: any) {
        if (error.status) throw error;
        throw { status: error.response?.status || 500, message: error.message };
      } finally {
        inFlightRequests.delete(lockKey);
      }
    })();

    inFlightRequests.set(lockKey, requestPromise);

    try {
      const result = await requestPromise;
      res.json(result);
    } catch (error: any) {
      logger.error("Places Search Error:", error.message);
      if (error.status === 403) {
        return res.status(403).json({ 
          error: "Access Denied (403). Please ensure 'Places API (New)' is enabled in your Google Cloud Console and that your API key has no restrictions preventing this request." 
        });
      }
      res.status(error.status || 500).json({ error: error.message || "Internal server error" });
    }
  });

  // API Route for Google Places Nearby Search
  app.post("/api/places/nearby", async (req, res) => {
    const { userId, includedTypes, locationRestriction, maxResultCount, rankPreference } = req.body;

    if (!userId || !locationRestriction) {
      return res.status(400).json({ error: "Missing userId or locationRestriction" });
    }

    const lockKey = `nearby:${JSON.stringify(includedTypes)}:${JSON.stringify(locationRestriction)}:${maxResultCount}:${rankPreference}`;

    // In-flight lock
    if (inFlightRequests.has(lockKey)) {
      try {
        const result = await inFlightRequests.get(lockKey);
        return res.json(result);
      } catch (error: any) {
        return res.status(error.response?.status || 500).json({ error: "Internal server error" });
      }
    }

    const requestPromise = (async () => {
      try {
        // Protection Layer - Check only
        const usage = await checkApiUsage(userId);
        if (!usage.allowed) {
          throw { status: 429, message: usage.error };
        }

        const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
        if (!apiKey) {
          throw { status: 500, message: "Server configuration error" };
        }

        const response = await axios.post(
          "https://places.googleapis.com/v1/places:searchNearby",
          {
            includedTypes,
            maxResultCount: maxResultCount || 20,
            rankPreference: rankPreference || "DISTANCE",
            locationRestriction
          },
          {
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": apiKey,
              "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.regularOpeningHours,places.types,places.photos"
            }
          }
        );

        const data = response.data;

        // Safe Increment: Only after success and valid results
        if (data && data.places && data.places.length > 0) {
          await incrementApiUsage(userId);
        }

        return data;
      } catch (error: any) {
        if (error.status) throw error;
        throw { status: error.response?.status || 500, message: error.message };
      } finally {
        inFlightRequests.delete(lockKey);
      }
    })();

    inFlightRequests.set(lockKey, requestPromise);

    try {
      const result = await requestPromise;
      res.json(result);
    } catch (error: any) {
      logger.error("Places Nearby Error:", error.message);
      if (error.status === 403) {
        return res.status(403).json({ 
          error: "Access Denied (403). Please ensure 'Places API (New)' is enabled in your Google Cloud Console and that your API key has no restrictions preventing this request." 
        });
      }
      res.status(error.status || 500).json({ error: error.message || "Internal server error" });
    }
  });

  // API Route for Emergency Status (Server-side to bypass CORS)
  app.get("/api/emergency-status", async (req, res) => {
    try {
      // 1. Check for current active alerts
      const activeResponse = await axios.get('https://www.oref.org.il/WarningMessages/alert/alerts.json', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://www.oref.org.il/',
          'X-Requested-With': 'XMLHttpRequest'
        },
        validateStatus: () => true // Don't throw on non-2xx
      });
      
      let isActive = false;
      let operationName = "חרבות ברזל"; // Default for current context

      if (activeResponse.status !== 204 && activeResponse.status >= 200 && activeResponse.status < 300) {
        const activeData = activeResponse.data;
        if (Array.isArray(activeData) && activeData.length > 0) {
          isActive = true;
        }
      }

      // 2. If no active alerts, check history for recent activity (last 24h)
      if (!isActive) {
        const historyResponse = await axios.get('https://www.oref.org.il/WarningMessages/History/AlertsHistory.json', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': 'https://www.oref.org.il/',
            'X-Requested-With': 'XMLHttpRequest'
          },
          validateStatus: () => true
        });

        if (historyResponse.status >= 200 && historyResponse.status < 300) {
          const historyData = historyResponse.data;
          if (Array.isArray(historyData)) {
            const now = new Date();
            const twentyFourHoursAgo = new Date(now.getTime() - (24 * 60 * 60 * 1000));
            
            // Count alerts in the last 24 hours
            const recentAlerts = historyData.filter((alert: any) => {
              const alertDate = new Date(alert.alertDate);
              return alertDate > twentyFourHoursAgo;
            });

            if (recentAlerts.length > 10) {
              isActive = true;
            }
          }
        }
      }

      // 3. Fallback: If we are in a known conflict period (e.g. 2023-2026)
      // This ensures the app stays in emergency mode during prolonged conflicts even if quiet for 24h.
      const currentYear = new Date().getFullYear();
      if (currentYear >= 2023 && currentYear <= 2026) {
        isActive = true;
      }

      res.json({
        active: isActive,
        operationName: isActive ? operationName : null,
        message: isActive ? "בשל המצב הביטחוני הנוכחי, דיוק סטטוס המקומות עלול להיות מושפע." : null
      });
    } catch (error) {
      logger.error("Emergency Status Error:", error);
      res.json({ active: false });
    }
  });

  // API Route for Emergency Alerts (Server-side to bypass CORS)
  app.get("/api/emergency-alerts", async (req, res) => {
    try {
      // Using the official Home Front Command (Oref) API
      // This endpoint returns current active alerts.
      const response = await axios.get('https://www.oref.org.il/WarningMessages/alert/alerts.json', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Referer': 'https://www.oref.org.il/',
          'X-Requested-With': 'XMLHttpRequest',
          'Content-Type': 'application/json;charset=utf-8'
        },
        validateStatus: () => true
      });
      
      // Oref API returns 204 No Content when there are no active alerts
      if (response.status === 204) {
        return res.json([]);
      }

      if (response.status < 200 || response.status >= 300) {
        // Fallback to empty if the service is temporarily unavailable
        return res.json([]);
      }
      
      const data = response.data;
      if (!data) {
        return res.json([]);
      }

      if (typeof data === 'string') {
        try {
          res.json(JSON.parse(data));
        } catch (e) {
          res.json([]);
        }
      } else {
        res.json(data);
      }
    } catch (error) {
      // Log the error but return an empty array to the frontend to prevent UI crashes
      logger.error("Emergency Proxy Error:", error);
      res.json([]);
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server is listening on port ${PORT}`);
    logger.info(`Environment: ${process.env.NODE_ENV}`);
  });
}

logger.info("Starting server process...");
startServer().catch(err => {
  logger.error("Failed to start server:", err);
  process.exit(1);
});
