import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import admin from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import axios from "axios";
import OpenAI from "openai";
import Parser from "rss-parser";
import "dotenv/config";
import logger from "./src/utils/logger";
import { LiveCheckResult } from "./src/types";
import { buildDynamicIsraeliContext } from "./src/services/contextService";
import firebaseConfig from "./firebase-applet-config.json" with { type: "json" };
import serviceAccount from "./serviceAccountKey.json" with { type: "json" };
import fs from "fs"; // מנגנון קריאת הקובץ הלוקאלי

// Lazy initialization for Firebase Admin
let dbInstance: admin.firestore.Firestore | null = null;
let adminApp: admin.app.App | null = null;

function getDb() {
  if (!dbInstance) {
    try {
      if (!admin.apps.length) {
        logger.info("Initializing Firebase Admin...");

        let credential;

        // בדיקה: האם אנחנו ב-Render? (משתמשים במשתנה סביבה)
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
          logger.info("Loading credentials from Environment Variable (Render Mode)");
          const serviceAccountValue = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
          credential = admin.credential.cert(serviceAccountValue);
        } else {
          // אם אנחנו במחשב שלך (פיתוח מקומי)
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

      logger.debug("SERVER PROJECT ID:", adminApp.options.projectId);
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
  const usageCache = new Map<string, { allowed: boolean; error?: string; timestamp: number }>();
  const USAGE_CACHE_TTL = 60000; // 60 seconds

  const perplexityClient = new OpenAI({
    apiKey: process.env.PERPLEXITY_API_KEY,
    baseURL: "https://api.perplexity.ai",
  });

  const openaiClient = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const liveCheckCache = new Map<string, { data: any; timestamp: number }>();
  const LIVE_CHECK_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

  function calculateBaseStatus(openingHours: string[] | undefined, now: Date): "OPEN" | "CLOSED" | "CLOSING_SOON" | "UNCERTAIN" {
    if (!openingHours || !Array.isArray(openingHours) || openingHours.length === 0) {
      return "UNCERTAIN";
    }

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayNamesHebrew = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "יום שבת"];
    
    const currentDayIndex = now.getDay();
    const currentDayName = dayNames[currentDayIndex];
    const currentDayNameHebrew = dayNamesHebrew[currentDayIndex];

    const todayLine = openingHours.find(line => 
      typeof line === 'string' && (
        line.toLowerCase().includes(currentDayName.toLowerCase()) || 
        line.includes(currentDayNameHebrew)
      )
    );

    if (!todayLine) return "UNCERTAIN";
    if (todayLine.includes("Closed") || todayLine.includes("סגור")) return "CLOSED";
    if (todayLine.includes("Open 24 hours") || todayLine.includes("פתוח 24 שעות")) return "OPEN";

    const timeRangeRegex = /(\d{1,2}:\d{2})\s*(AM|PM)?\s*[–-]\s*(\d{1,2}:\d{2})\s*(AM|PM)?/gi;
    let match;
    let ranges: { start: number; end: number }[] = [];

    const parseTime = (timeStr: string, meridiem?: string) => {
      let [hours, minutes] = timeStr.split(':').map(Number);
      if (meridiem) {
        if (meridiem.toUpperCase() === 'PM' && hours < 12) hours += 12;
        if (meridiem.toUpperCase() === 'AM' && hours === 12) hours = 0;
      }
      return hours * 60 + minutes;
    };

    while ((match = timeRangeRegex.exec(todayLine)) !== null) {
      ranges.push({
        start: parseTime(match[1], match[2]),
        end: parseTime(match[3], match[4])
      });
    }

    if (ranges.length === 0) return "UNCERTAIN";

    const currentTime = now.getHours() * 60 + now.getMinutes();
    
    for (const range of ranges) {
      const { start, end } = range;
      const isOpen = end > start 
        ? (currentTime >= start && currentTime < end)
        : (currentTime >= start || currentTime < end);

      if (isOpen) {
        let minutesToClose;
        if (end > start) {
          minutesToClose = end - currentTime;
        } else {
          minutesToClose = currentTime >= start ? (1440 - currentTime + end) : (end - currentTime);
        }

        if (minutesToClose > 0 && minutesToClose <= 30) {
          return "CLOSING_SOON";
        }
        return "OPEN";
      }
    }

    return "CLOSED";
  }

  function normalizeQuery(query: string): string {
    return query.trim().toLowerCase().replace(/\s+/g, ' ');
  }

  async function checkApiUsage(userId: string) {
    const now = Date.now();
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
      
      // Account for buffered calls not yet in Firestore
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
          logger.warn(`API limit reached for user ${userId}: ${usage.error}`);
          return { places: [] };
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
          logger.warn(`API limit reached for user ${userId}: ${usage.error}`);
          return { places: [] };
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

  const parser = new Parser();

  let cachedEmergencyStatus: any = null;
  let lastEmergencyCheck = 0;
  const EMERGENCY_CACHE_TTL = 12 * 60 * 60 * 1000; // 12 hours

  // API Route for Emergency Status (Server-side to bypass CORS) - AI Improved version
  app.get("/api/emergency-status", async (req, res) => {
    try {
      const now = Date.now();
      if (cachedEmergencyStatus && (now - lastEmergencyCheck < EMERGENCY_CACHE_TTL)) {
        return res.json(cachedEmergencyStatus);
      }

      const feed = await parser.parseURL('http://www.ynet.co.il/Integration/StoryRss1854.xml');
      const items = feed.items.slice(0, 25);
      
      // מילות מפתח שמעידות על שיבוש שגרה ממשי
      const keywords = ['החמרת הנחיות', 'הגבלות התקהלות', 'סגירת עסקים', 'ביטול לימודים', 'מטח כבד', 'מתקפת טילים', 'הנחיות מיוחדות'];
      
      let keywordCount = 0;
      const combinedText = items.map(item => (item.title || '') + ' ' + (item.contentSnippet || '')).join(' ');
      
      keywords.forEach(keyword => {
        if (combinedText.includes(keyword)) {
          keywordCount++;
        }
      });

      // דורש לפחות מילה אחת של שיבוש שגרה ברור, או הרבה מילים כלליות
      const isActive = keywordCount >= 1 || (combinedText.match(/פיקוד העורף/g) || []).length >= 3;
      const operationName = process.env.CURRENT_OPERATION || "חרבות ברזל";

      cachedEmergencyStatus = {
        active: isActive,
        operationName: isActive ? operationName : null,
        message: isActive ? "בשל המצב הביטחוני הנוכחי, דיוק סטטוס המקומות עלול להיות מושפע." : null
      };
      lastEmergencyCheck = now;

      res.json(cachedEmergencyStatus);
    } catch (error) {
      logger.error("Emergency Status Error:", error);
      if (cachedEmergencyStatus) {
        return res.json(cachedEmergencyStatus);
      }
      res.json({ active: false });
    }
  });

  // API Route for Emergency Alerts (Server-side to bypass CORS) - Local version (Oref Proxy)
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

  // --- API Route for Live Check (Production: AI Separation of Concerns) ---
  app.post("/live-check", async (req, res) => {
    try {
      const { placeId, placeName, city, address, websiteUrl, openingHours, userId, email } = req.body;

      if (!placeName) return res.status(400).json({ error: "Missing placeName" });

      // 1. Cache Logic
      const cacheKey = `${placeName}-${address || city || ''}`.toLowerCase().trim();
      const now = Date.now();
      const cached = liveCheckCache.get(cacheKey);

      if (cached && (now - cached.timestamp < 30 * 60 * 1000)) {
        logger.info(`Cache hit for: ${placeName}`);
        return res.json(cached.data);
      }

      // 2. Time Logic & Constants (Calculated early for rate limiting)
      const israelTimeStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' });
      const israelTime = new Date(israelTimeStr);
      const currentDate = israelTime.toISOString().split('T')[0];
      const currentMinutes = israelTime.getHours() * 60 + israelTime.getMinutes();
      
      // Time Injection for Prompts
      const currentHour = israelTime.getHours().toString().padStart(2, '0');
      const currentMinuteStr = israelTime.getMinutes().toString().padStart(2, '0');
      const timeInjection = `The CURRENT LOCAL TIME in Israel is exactly ${currentHour}:${currentMinuteStr}. Evaluate the real-time status strictly based on this local time.`;

      // 2.5 Rate Limiting (Per User) - Admin Bypass
      const isAdmin = email === "itay8090100@gmail.com";
      if (userId && !isAdmin) {
        const db = getDb();
        if (db) {
          const usageRef = db.collection("userLiveCheckUsage").doc(`${userId}_${currentDate}`);
          const usageDoc = await usageRef.get();
          const count = usageDoc.exists ? usageDoc.data()?.count || 0 : 0;

          if (count >= 3) {
            logger.warn(`User ${userId} reached daily live-check limit.`);
            return res.status(429).json({ error: "DAILY_LIMIT_REACHED" });
          }

          await usageRef.set({
            count: admin.firestore.FieldValue.increment(1),
            lastChecked: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
        }
      }

      logger.info(`Performing fresh agentic live check for: ${placeName}`);

      let targetWebsite = "No official website provided.";
      let siteSearchCommand = "";
      if (websiteUrl) {
        try {
          const urlString = websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`;
          const hostname = new URL(urlString).hostname;
          targetWebsite = `PRIORITY TARGET: ${websiteUrl}`;
          siteSearchCommand = `CRITICAL: You MUST use the search operator 'site:${hostname}' in your internal search queries to explicitly search inside their official domain for holiday tables, branches ("סניפים"), or news.`;
        } catch (e) {
          logger.warn(`Failed to parse websiteUrl: ${websiteUrl}`);
        }
      }

      const dynamicContext = await buildDynamicIsraeliContext();

      // STEP 1: PERPLEXITY CALL (The Researcher)
      const perplexityResponse = await perplexityClient.chat.completions.create({
        model: "sonar",
        messages: [
          {
            role: "system",
            content: `You are an elite Israeli web data extractor. Search the web explicitly for the operating hours of the provided business for TODAY.
${timeInjection}
${dynamicContext}

YOUR MISSION:
1. ${targetWebsite}
2. ${siteSearchCommand}
3. If the official site yields no explicit results for today's specific date/holiday, expand your search to Facebook, Instagram, and local directories.
4. Extract raw text/rows if you find exact hours or an announcement for TODAY (or the specific holiday).
5. Find the Phone number and direct Google Maps Reviews URL.
6. If you cannot find explicit hours for today's holiday/date anywhere, DO NOT GUESS. Simply state: "NO_EXPLICIT_HOLIDAY_DATA_FOUND."
Write a 1-paragraph summary in Hebrew. DO NOT output JSON.`
          },
          {
            role: "user",
            content: `Name: ${placeName}, Address: ${address || city}, City: ${city}. Today is ${currentDate}.`
          }
        ]
      });

      const rawResearchText = perplexityResponse.choices?.[0]?.message?.content || "";
      logger.info("=== RAW RESEARCH TEXT ===");
      logger.info(rawResearchText);
      logger.info("=========================");

      // STEP 2: OPENAI CALL (The Judge)
      const judgeResponse = await openaiClient.chat.completions.create({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content: `You are a logic engine (The Judge). You receive raw web research (which may include extracted structured schedules/tables) from an AI Hunter.
${timeInjection} 
${dynamicContext} 
Your job is to output a STRICT JSON object representing the real-time status.

CRITICAL RULES:
1. STRUCTURED DATA FIRST: If the research contains a row from an official schedule table, treat this as the absolute ground truth.
2. UNCERTAINTY OVER GUESSING: If the research explicitly says "NO_EXPLICIT_HOLIDAY_DATA_FOUND" during a holiday or emergency, you MUST set "finalStatus" to "UNCERTAIN". Do NOT guess "OPEN" or "CLOSED" without real proof.
3. URLs MUST be absolute (starting with https://). If you don't have a valid Google Maps review link, return null.

Output schema:
{
  "finalStatus": "OPEN" | "CLOSED" | "CLOSING_SOON" | "UNCERTAIN",
  "confidence": number (0.0 to 1.0),
  "specialCase": "NONE" | "HOLIDAY_OR_EVENT" | "SECURITY" | "VERIFIED_ONLINE",
  "reason": "1 short, natural-sounding, native Hebrew sentence explaining the decision. If UNCERTAIN, explain that there is no official info for the holiday.",
  "todayHours": "string representing the hours strictly in 'HH:MM - HH:MM' format using a hyphen (e.g., '10:00 - 15:00'), or null if unknown",
  "enrichedData": { 
    "phoneNumber": string|null, 
    "websiteUrl": string|null, 
    "googleMapsUrl": string|null, 
    "reviewsUrl": string|null, 
    "ontopoUrl": string|null, 
    "todayHours": string|null,
    "rating": number|null
  }
}`
          },
          {
            role: "user",
            content: `
              Research Text: ${rawResearchText}
              Current Date: ${currentDate}
              Current Time (minutes from midnight): ${currentMinutes}
              Static Opening Hours: ${JSON.stringify(openingHours)}
              
              Do the math and return the JSON.`
          }
        ]
      });

      // STEP 3: PARSING & FALLBACK
      let result;
      try {
        const judgeContent = judgeResponse.choices?.[0]?.message?.content || "{}";
        const parsed = JSON.parse(judgeContent);
        
        // Safeguard: Replace " to " or " עד " with " - "
        let formattedHours = parsed.todayHours || null;
        if (formattedHours) {
          formattedHours = formattedHours.replace(/\s*to\s*/gi, ' - ').replace(/\s*עד\s*/gi, ' - ');
        }
        
        result = {
          finalStatus: parsed.finalStatus || "UNCERTAIN",
          confidence: parsed.confidence || 0,
          specialCase: parsed.specialCase || "NONE",
          reason: (parsed.reason || "לא ניתן לקבוע סטטוס ודאי").replace(/([*#])/g, '').trim(),
          todayHours: formattedHours,
          checkedAt: now,
          aiUsed: true,
          enrichedData: parsed.enrichedData || { 
            phoneNumber: null, 
            websiteUrl: null, 
            googleMapsUrl: null, 
            reviewsUrl: null, 
            ontopoUrl: null, 
            todayHours: null,
            rating: null
          }
        };
      } catch (e) {
        logger.error("Error parsing Judge response:", e);
        const fallbackStatus = calculateBaseStatus(openingHours, israelTime);
        result = {
          finalStatus: fallbackStatus,
          confidence: 0.5,
          specialCase: "NONE",
          reason: "שגיאה בניתוח המידע, מסתמך על שעות רגילות.",
          todayHours: null, // Changed to null
          checkedAt: now,
          aiUsed: false,
          enrichedData: { 
            phoneNumber: null, 
            websiteUrl: null, 
            googleMapsUrl: null, 
            reviewsUrl: null, 
            ontopoUrl: null, 
            todayHours: null,
            rating: null
          }
        };
      }

      // 7. Global DB Sync (Affects all users) - Dual Update Strategy
      if (placeId && result.confidence >= 0.9) {
        const db = getDb();
        if (db) {
          (async () => {
            try {
              const placeRef = db.collection("places").doc(placeId);
              const placeDoc = await placeRef.get();
              const placeData = placeDoc.data() || {};
              
              const currentAiHours = result.enrichedData?.todayHours || result.todayHours;
              const daysHe = ["יום ראשון", "יום שני", "יום שלישי", "יום רביעי", "יום חמישי", "יום שישי", "יום שבת"];
              const todayHe = daysHe[israelTime.getDay()];
              
              let existingHoursArray = placeData.openingHours || [];
              if (!Array.isArray(existingHoursArray)) existingHoursArray = [];
              
              const todayLineIndex = existingHoursArray.findIndex((line: string) => line && typeof line === 'string' && line.startsWith(todayHe));
              const existingTodayHours = todayLineIndex !== -1 ? existingHoursArray[todayLineIndex].split(': ')[1] : null;
              
              const hoursConflict = currentAiHours && currentAiHours !== existingTodayHours;

              const updateObj: any = {
                liveCheckResult: {
                  ...result,
                  lastUpdated: admin.firestore.FieldValue.serverTimestamp()
                }
              };

              // Branch A vs Branch B Logic
              if (hoursConflict) {
                if (result.specialCase === "NONE") {
                  // BRANCH A: Permanent Fix (Static hours were wrong or missing)
                  const newArray = [...existingHoursArray];
                  if (todayLineIndex !== -1) {
                    newArray[todayLineIndex] = `${todayHe}: ${currentAiHours}`;
                  } else {
                    // Day missing from array, add it
                    newArray.push(`${todayHe}: ${currentAiHours}`);
                  }
                  updateObj.openingHours = newArray;
                  // Clear override if we fixed the source
                  updateObj.temporaryHoursOverride = admin.firestore.FieldValue.delete();
                } else {
                  // BRANCH B: Temporary Mask (Holiday/Security/Special Event)
                  updateObj.temporaryHoursOverride = {
                    date: currentDate,
                    todayHours: currentAiHours,
                    finalStatus: result.finalStatus,
                    reason: result.reason
                  };
                }
              }

              // Smart Enrichment: Only update missing fields
              const enriched = result.enrichedData || {};
              const fieldsToSync = ['phoneNumber', 'websiteUrl', 'googleMapsUrl', 'reviewsUrl', 'ontopoUrl', 'rating'];
              
              fieldsToSync.forEach(field => {
                if (enriched[field] !== undefined && enriched[field] !== null && (!placeData[field] || placeData[field] === "")) {
                  // Special handling for rating to ensure it's a valid number
                  if (field === 'rating') {
                    const r = parseFloat(enriched[field]);
                    if (!isNaN(r) && r >= 0 && r <= 5) {
                      updateObj[field] = r;
                    }
                  } else {
                    updateObj[field] = enriched[field];
                  }
                }
              });

              await placeRef.set(updateObj, { merge: true });
            } catch (err) {
              logger.error("Global DB Sync Error:", err);
            }
          })();
        }
      }

      liveCheckCache.set(cacheKey, { data: result, timestamp: now });
      
      const tempOverride = {
        date: currentDate,
        todayHours: result.enrichedData?.todayHours || result.todayHours,
        finalStatus: result.finalStatus,
        reason: result.reason
      };

      res.json({
        ...result,
        temporaryHoursOverride: tempOverride
      });

    } catch (error) {
      logger.error("Critical error in /live-check:", error);
      res.json({ finalStatus: "UNCERTAIN", reason: "שגיאה בבדיקה בזמן אמת", checkedAt: Date.now(), aiUsed: false });
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
