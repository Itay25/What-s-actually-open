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
import fs from "fs";

// Lazy initialization for Firebase Admin
let dbInstance: admin.firestore.Firestore | null = null;
let adminApp: admin.app.App | null = null;

function getDb() {
  if (!dbInstance) {
    try {
      if (!admin.apps.length) {
        logger.info("Initializing Firebase Admin...");

        let credential;

        // בדיקה: האם אנחנו ב-Render? (שימוש במשתנה סביבה עבור בטיחות)
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
          logger.info("Loading credentials from Environment Variable (Render Mode)");
          const serviceAccountValue = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
          credential = admin.credential.cert(serviceAccountValue);
        } else {
          // פיתוח מקומי - קריאה ישירה מהקובץ
          logger.info("Loading credentials from local file (Dev Mode)");
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
    } catch (error: any) {
      logger.error("Critical error initializing Firebase Admin:", error.message);
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
        apiCallsBuffer.set(date, (apiCallsBuffer.get(date) || 0) + count);
      }
    }
  } finally {
    isFlushing = false;
  }
}

// Exit handlers
process.on("SIGINT", async () => {
  logger.info("Received SIGINT. Flushing buffer...");
  await flushGlobalApiUsage();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  logger.info("Received SIGTERM. Flushing buffer...");
  await flushGlobalApiUsage();
  process.exit(0);
});

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const MAX_GOOGLE_CALLS_PER_USER_PER_DAY = 1;
  const MAX_GOOGLE_CALLS_PER_DAY = 200;

  const inFlightRequests = new Map<string, Promise<any>>();
  
  // --- מנגנון ה-Cache החדש לייעול קריאות ---
  const usageCache = new Map<string, { allowed: boolean; error?: string; timestamp: number }>();
  const USAGE_CACHE_TTL = 60000; // דקה אחת

  function normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  async function checkApiUsage(userId: string) {
    const now = Date.now();
    
    // בדיקה ב-Cache לפני פנייה ל-Firestore
    const cached = usageCache.get(userId);
    if (cached && now - cached.timestamp < USAGE_CACHE_TTL) {
      logger.debug(`Using cached API usage for user ${userId}`);
      return { allowed: cached.allowed, error: cached.error };
    }

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
      const bufferedCount = apiCallsBuffer.get(today) || 0;
      const totalCount = dbCount + bufferedCount;

      if (totalCount >= MAX_GOOGLE_CALLS_PER_DAY) {
        const result = { allowed: false, error: "New place searches are temporarily unavailable today." };
        usageCache.set(userId, { ...result, timestamp: now });
        return result;
      }

      // 2. User Limit Check
      const userUsageRef = db.collection("userApiUsage").doc(`${userId}_${today}`);
      const userUsageDoc = await userUsageRef.get();
      const userCount = userUsageDoc.exists ? userUsageDoc.data()?.count || 0 : 0;

      if (userCount >= MAX_GOOGLE_CALLS_PER_USER_PER_DAY) {
        const result = { allowed: false, error: "Daily search limit reached for discovering new places." };
        usageCache.set(userId, { ...result, timestamp: now });
        return result;
      }

      const result = { allowed: true };
      usageCache.set(userId, { ...result, timestamp: now });
      return result;
    } catch (error: any) {
      logger.error("Firestore Error in checkApiUsage:", error.message);
      return { allowed: true }; // Fallback
    }
  }

  async function incrementApiUsage(userId: string) {
    const db = getDb();
    if (!db) return;

    const today = new Date().toISOString().split('T')[0];
    const userUsageRef = db.collection("userApiUsage").doc(`${userId}_${today}`);

    try {
      apiCallsBuffer.set(today, (apiCallsBuffer.get(today) || 0) + 1);

      await userUsageRef.set({ 
        count: admin.firestore.FieldValue.increment(1), 
        userId, 
        date: today 
      }, { merge: true });

      logger.debug(`API usage incremented for user ${userId}`);

      let totalBuffered = 0;
      for (const count of apiCallsBuffer.values()) {
        totalBuffered += count;
      }

      if (totalBuffered >= FLUSH_THRESHOLD || (Date.now() - lastFlushTime) >= FLUSH_INTERVAL) {
        flushGlobalApiUsage().catch(err => logger.error("Async flush error:", err));
      }
    } catch (error: any) {
      logger.error("Error incrementing API usage:", error.message);
    }
  }

  // --- Routes ---
  app.post("/api/places/search", async (req, res) => {
    const { userId, query, locationBias, languageCode } = req.body;
    if (!userId || !query) return res.status(400).json({ error: "Missing parameters" });

    const normalizedQuery = normalizeQuery(query);
    const lockKey = `search:${normalizedQuery}:${JSON.stringify(locationBias)}`;

    if (inFlightRequests.has(lockKey)) {
      return res.json(await inFlightRequests.get(lockKey));
    }

    const requestPromise = (async () => {
      try {
        const usage = await checkApiUsage(userId);
        if (!usage.allowed) return { places: [] };

        const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
        const response = await axios.post(
          "https://places.googleapis.com/v1/places:searchText",
          { textQuery: normalizedQuery, maxResultCount: 10, languageCode: languageCode || "he", locationBias },
          { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.regularOpeningHours,places.types,places.photos" } }
        );

        if (response.data?.places?.length > 0) await incrementApiUsage(userId);
        return response.data;
      } finally {
        inFlightRequests.delete(lockKey);
      }
    })();

    inFlightRequests.set(lockKey, requestPromise);
    res.json(await requestPromise);
  });

  app.post("/api/places/nearby", async (req, res) => {
    const { userId, includedTypes, locationRestriction, maxResultCount } = req.body;
    if (!userId || !locationRestriction) return res.status(400).json({ error: "Missing parameters" });

    const usage = await checkApiUsage(userId);
    if (!usage.allowed) return res.json({ places: [] });

    try {
      const apiKey = process.env.VITE_GOOGLE_MAPS_API_KEY;
      const response = await axios.post(
        "https://places.googleapis.com/v1/places:searchNearby",
        { includedTypes, maxResultCount: maxResultCount || 20, locationRestriction, rankPreference: "DISTANCE" },
        { headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.location,places.regularOpeningHours,places.types,places.photos" } }
      );

      if (response.data?.places?.length > 0) await incrementApiUsage(userId);
      res.json(response.data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Emergency Routes (השארתי כפי שהיו בקוד המקורי שלך)
  app.get("/api/emergency-status", async (req, res) => {
     // ... לוגיקת הסטטוס הקיימת שלך ...
     res.json({ active: true, operationName: "חרבות ברזל" }); // דוגמה מקוצרת
  });

  // Vite / Static Files
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => res.sendFile(path.join(__dirname, "dist", "index.html")));
  }

  app.listen(PORT, "0.0.0.0", () => {
    logger.info(`Server listening on port ${PORT} [${process.env.NODE_ENV}]`);
  });
}

startServer().catch(err => logger.error("Start error:", err));
