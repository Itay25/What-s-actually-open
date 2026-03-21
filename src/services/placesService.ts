import { Place } from '../types';
import { db } from '../firebase';
import logger from '../utils/logger';
import { convertEnToHeLayout, hasEnglishLetters } from '../utils/keyboardLayout';
import { normalizeOpeningHours } from '../utils/openingHours';
import { computeOpenStatus } from './statusService';
import { isPlaceIncomplete } from '../utils/placeIncomplete';
import { 
  collection, 
  query, 
  where, 
  getDocs, 
  setDoc, 
  doc, 
  getDoc,
  limit
} from 'firebase/firestore';

// In-memory cache for Firestore queries
const dbCache = new Map<string, { places: Place[], timestamp: number }>();
const DB_CACHE_EXPIRY = 60 * 1000; // 60 seconds (as requested)

// Track in-flight requests to prevent duplicates
const inFlightRequests = new Map<string, Promise<Place[]>>();

// In-memory cache for search results
const searchCache = new Map<string, { results: Place[], timestamp: number }>();
const SEARCH_CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes

/**
 * Helper to extract all possible image URLs from various potential fields.
 * Returns them in priority order.
 */
function getAllPlaceImages(data: any): string[] {
  const priorityFields = [
    'photoUrl',
    'imageUrl',
    'image',
    'thumbnail',
    'serpapi_thumbnail',
    'photo_url'
  ];

  const images: string[] = [];
  const addImage = (url: any) => {
    if (typeof url === 'string' && url.trim() !== '' && url !== 'NO_IMAGE') {
      if ((url.startsWith('http') || url.startsWith('data:image')) && !images.includes(url)) {
        images.push(url);
      }
    }
  };

  // 1. Check direct fields
  for (const field of priorityFields) {
    addImage(data[field]);
  }

  // 2. Check photos array
  if (Array.isArray(data.photos)) {
    data.photos.forEach((item: any) => {
      if (typeof item === 'string') {
        addImage(item);
      } else if (item && typeof item === 'object') {
        const possibleSubFields = ['url', 'image', 'photoUrl', 'imageUrl', 'link'];
        for (const subField of possibleSubFields) {
          addImage(item[subField]);
        }
      }
    });
  }

  // 3. Check images array
  if (Array.isArray(data.images)) {
    data.images.forEach((item: any) => {
      if (typeof item === 'string') {
        addImage(item);
      } else if (item && typeof item === 'object') {
        const possibleSubFields = ['url', 'image', 'imageUrl', 'link'];
        for (const subField of possibleSubFields) {
          addImage(item[subField]);
        }
      }
    });
  }

  return images;
}

/**
 * Helper to sanitize data from Firestore, converting Timestamps to numbers.
 */
function sanitizePlace(data: any): Place {
  const sanitized = { ...data };
  
  // Convert Firestore Timestamps to numbers
  if (sanitized.lastUpdateTimestamp && typeof sanitized.lastUpdateTimestamp === 'object' && 'seconds' in sanitized.lastUpdateTimestamp) {
    sanitized.lastUpdateTimestamp = sanitized.lastUpdateTimestamp.seconds * 1000;
  }
  
  if (sanitized.createdAt && typeof sanitized.createdAt === 'object' && 'seconds' in sanitized.createdAt) {
    sanitized.createdAt = sanitized.createdAt.seconds * 1000;
  }

  // Handle lastUpdate if it's a Timestamp (should be a string)
  if (sanitized.lastUpdate && typeof sanitized.lastUpdate === 'object' && 'seconds' in sanitized.lastUpdate) {
    sanitized.lastUpdate = new Date(sanitized.lastUpdate.seconds * 1000).toLocaleString('he-IL');
  }

  if (sanitized.lastReportTime && typeof sanitized.lastReportTime === 'object' && 'seconds' in sanitized.lastReportTime) {
    sanitized.lastReportTime = sanitized.lastReportTime.seconds * 1000;
  }

  if (sanitized.lastReportedOpen && typeof sanitized.lastReportedOpen === 'object' && 'seconds' in sanitized.lastReportedOpen) {
    sanitized.lastReportedOpen = sanitized.lastReportedOpen.seconds * 1000;
  }

  if (sanitized.lastReportedClosed && typeof sanitized.lastReportedClosed === 'object' && 'seconds' in sanitized.lastReportedClosed) {
    sanitized.lastReportedClosed = sanitized.lastReportedClosed.seconds * 1000;
  }

  // Handle userReports timestamps
  if (Array.isArray(sanitized.userReports)) {
    sanitized.userReports = sanitized.userReports.map((report: any) => ({
      ...report,
      timestamp: (report.timestamp && typeof report.timestamp === 'object' && 'seconds' in report.timestamp) 
        ? report.timestamp.seconds * 1000 
        : report.timestamp
    }));
  }

  // Image Normalization
  const detectedImages = getAllPlaceImages(sanitized);
  if (detectedImages.length > 0) {
    sanitized.imageUrl = detectedImages[0];
    sanitized.potentialImages = detectedImages;
  }

  // Robust Opening Hours Normalization (Cache result in memory)
  if (sanitized.openingHours && !sanitized.normalizedOpeningHours) {
    sanitized.normalizedOpeningHours = normalizeOpeningHours(sanitized.openingHours);
    
    // If openingHours was an object, convert it to an array of strings for UI compatibility
    if (sanitized.openingHours && !Array.isArray(sanitized.openingHours) && typeof sanitized.openingHours === 'object') {
      sanitized.openingHours = Object.entries(sanitized.openingHours).map(([day, hours]) => `${day}: ${hours}`);
    }
  }

  // Dynamic Status Refresh
  // We recompute the status on load to ensure it's accurate based on current time
  // and the newly normalized opening hours.
  const computedStatus = computeOpenStatus(sanitized as Place);
  const isIncomplete = isPlaceIncomplete(sanitized as Place);
  
  if (isIncomplete) {
    sanitized.status = 'unknown';
  } else if (computedStatus !== 'unknown' || !sanitized.status) {
    sanitized.status = computedStatus;
  }

  return sanitized as Place;
}

/**
 * Helper to get places from Firestore based on bounds and category.
 */
async function getPlacesFromDB(bounds: { north: number; south: number; east: number; west: number }, categoryId?: string | null, center?: { lat: number, lng: number }, zoom: number = 15): Promise<Place[]> {
  const precision = 3; // Use 3 decimal places for cache key (approx 110m) as requested
  const cacheKey = `${bounds.north.toFixed(precision)},${bounds.south.toFixed(precision)},${bounds.east.toFixed(precision)},${bounds.west.toFixed(precision)}-${categoryId || 'all'}`;
  
  // 1. Check cache first
  const cached = dbCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < DB_CACHE_EXPIRY) {
    return cached.places;
  }

  // 2. Check if a request for this key is already in flight
  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey)!;
  }

  // 3. Create new request
  const fetchPromise = (async () => {
    try {
      const placesRef = collection(db, 'places');
      
      // Determine limit based on zoom level
      let maxResults = 50;
      if (zoom >= 17) maxResults = 50;
      else if (zoom >= 15) maxResults = 35;
      else if (zoom >= 13) maxResults = 20;
      else maxResults = 10;

      // Viewport-only query: Filter by latitude AND longitude range in DB
      // Note: This requires a composite index on (lat, lng)
      const q = query(
        placesRef,
        where('lat', '>=', bounds.south),
        where('lat', '<=', bounds.north),
        where('lng', '>=', bounds.west),
        where('lng', '<=', bounds.east),
        limit(maxResults)
      );
      
      const querySnapshot = await getDocs(q);
      const places: Place[] = [];
      const targetCategory = categoryId ? mapCategoryIdToHebrew(categoryId) : null;
      
      querySnapshot.forEach((doc) => {
        const data = doc.data() as any;
        
        // Filter category in memory (if active)
        const matchesCategory = !targetCategory || data.category === targetCategory;

        if (matchesCategory) {
          places.push(sanitizePlace(data));
        }
      });

      // Sort by distance if center is provided
      if (center) {
        places.sort((a, b) => {
          const distA = Math.pow(a.lat - center.lat, 2) + Math.pow(a.lng - center.lng, 2);
          const distB = Math.pow(b.lat - center.lat, 2) + Math.pow(b.lng - center.lng, 2);
          return distA - distB;
        });
      }
      
      // Apply the final zoom-based limit
      const limitedPlaces = places.slice(0, maxResults);

      // Update cache
      dbCache.set(cacheKey, { places: limitedPlaces, timestamp: Date.now() });
      if (dbCache.size > 100) {
        const firstKey = dbCache.keys().next().value;
        if (firstKey) dbCache.delete(firstKey);
      }

      return limitedPlaces;
    } catch (error) {
      logger.error("Error fetching from DB:", error);
      return [];
    } finally {
      // Remove from in-flight map once finished
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

function mapCategoryIdToHebrew(categoryId: string): string {
  const map: Record<string, string> = {
    'super': 'סופרים',
    'cafe': 'בתי קפה',
    'restaurant': 'מסעדות',
    'pharmacy': 'בתי מרקחת',
    'gas': 'תחנות דלק',
    'bakery': 'מאפיות',
    'atm': 'כספומטים'
  };
  return map[categoryId] || 'עסק';
}

// Cache for individual place details
const placeDetailsCache = new Map<string, { place: Place, timestamp: number }>();
const PLACE_DETAILS_CACHE_EXPIRY = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch a single place by ID from Firestore.
 */
export async function getPlaceById(id: string): Promise<Place | null> {
  // Check cache first
  const cached = placeDetailsCache.get(id);
  if (cached && (Date.now() - cached.timestamp < PLACE_DETAILS_CACHE_EXPIRY)) {
    return cached.place;
  }

  try {
    const placeRef = doc(db, 'places', id);
    const placeSnap = await getDoc(placeRef);
    if (placeSnap.exists()) {
      const place = sanitizePlace(placeSnap.data());
      // Update cache
      placeDetailsCache.set(id, { place, timestamp: Date.now() });
      // Manage cache size
      if (placeDetailsCache.size > 200) {
        const firstKey = placeDetailsCache.keys().next().value;
        if (firstKey) placeDetailsCache.delete(firstKey);
      }
      return place;
    }
    return null;
  } catch (error) {
    logger.error("Error fetching place by ID:", error);
    return null;
  }
}

/**
 * Helper to save a place to Firestore.
 */
async function savePlaceToDB(place: Place) {
  try {
    const placeRef = doc(db, 'places', place.id);
    
    // Create a clean object for Firestore (no undefined values)
    const data: any = {
      id: place.id,
      name: place.name || 'עסק ללא שם',
      lat: place.lat,
      lng: place.lng,
      location: { latitude: place.lat, longitude: place.lng },
      peopleCount: place.peopleCount,
      lastUpdate: place.lastUpdate,
      lastUpdateTimestamp: place.lastUpdateTimestamp,
      category: place.category || 'עסק',
      confirmations: place.confirmations,
      officialOpen: place.officialOpen,
      address: place.address || '',
    };

    // Add optional fields only if they are defined
    if (place.place_id !== undefined) data.place_id = place.place_id;
    if (place.rating !== undefined) data.rating = place.rating;
    if (place.userRatingsTotal !== undefined) data.userRatingsTotal = place.userRatingsTotal;
    if (place.photo_reference !== undefined) data.photo_reference = place.photo_reference;
    if (place.photo_url !== undefined) data.photo_url = place.photo_url;
    if (place.imageUrl !== undefined) data.imageUrl = place.imageUrl;
    if (place.potentialImages !== undefined) data.potentialImages = place.potentialImages;
    if (place.openingHours !== undefined) data.openingHours = place.openingHours;
    if (place.normalizedOpeningHours !== undefined) data.normalizedOpeningHours = place.normalizedOpeningHours;
    if (place.openingPeriods !== undefined) data.openingPeriods = place.openingPeriods;
    if (place.confidenceScore !== undefined) data.confidenceScore = place.confidenceScore;
    if (place.verificationLayers !== undefined) data.verificationLayers = place.verificationLayers;
    if (place.socialPulse !== undefined) data.socialPulse = place.socialPulse;
    if (place.physicalPresence !== undefined) data.physicalPresence = place.physicalPresence;
    if (place.woltStatus !== undefined) data.woltStatus = place.woltStatus;
    if (place.easyStatus !== undefined) data.easyStatus = place.easyStatus;
    if (place.isSuspicious !== undefined) data.isSuspicious = place.isSuspicious;
    if (place.isLocal !== undefined) data.isLocal = place.isLocal;
    if (place.popularTimes !== undefined) data.popularTimes = place.popularTimes;
    if (place.userReports !== undefined) data.userReports = place.userReports;
    if (place.reportsOpen !== undefined) data.reportsOpen = place.reportsOpen;
    if (place.reportsClosed !== undefined) data.reportsClosed = place.reportsClosed;
    if (place.lastReportedOpen !== undefined) data.lastReportedOpen = place.lastReportedOpen;
    if (place.lastReportedClosed !== undefined) data.lastReportedClosed = place.lastReportedClosed;
    if (place.lastReportTime !== undefined) data.lastReportTime = place.lastReportTime;

    await setDoc(placeRef, data, { merge: true });
  } catch (error) {
    logger.error("Error saving to DB:", error);
  }
}

/**
 * Service to discover businesses within map bounds.
 * Strictly viewport-based queries with no fallback logic.
 * Implements minimal empty-state protection by expanding bounds once if results are low.
 */
export async function discoverPlaces(bounds: { north: number; south: number; east: number; west: number }, categoryId?: string | null, userId?: string, zoom: number = 15): Promise<Place[]> {
  const center = {
    lat: (bounds.north + bounds.south) / 2,
    lng: (bounds.east + bounds.west) / 2
  };

  // 1. Initial fetch
  let results = await getPlacesFromDB(bounds, categoryId, center, zoom);

  // 2. Minimal empty-state protection: If results < 5, expand bounds by 1.2x ONLY ONCE
  if (results.length < 5) {
    const latDiff = bounds.north - bounds.south;
    const lngDiff = bounds.east - bounds.west;
    const expandedBounds = {
      north: center.lat + (latDiff * 1.2) / 2,
      south: center.lat - (latDiff * 1.2) / 2,
      east: center.lng + (lngDiff * 1.2) / 2,
      west: center.lng - (lngDiff * 1.2) / 2
    };
    
    // Fetch again with expanded bounds
    const expandedResults = await getPlacesFromDB(expandedBounds, categoryId, center, zoom);
    
    // Merge and deduplicate
    const seen = new Set(results.map(p => p.id));
    expandedResults.forEach(p => {
      if (!seen.has(p.id)) {
        results.push(p);
        seen.add(p.id);
      }
    });
  }

  return results;
}


/**
 * Helper to get suggestions from DB using prefix search.
 */
async function getSuggestionsFromDB(searchTerm: string): Promise<Place[]> {
  const cacheKey = `suggestion-${searchTerm.toLowerCase()}`;
  
  // 1. Check cache
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_EXPIRY) {
    return cached.results;
  }

  // 2. Check in-flight
  if (inFlightRequests.has(cacheKey)) {
    return inFlightRequests.get(cacheKey)!;
  }

  const fetchPromise = (async () => {
    try {
      const placesRef = collection(db, 'places');
      // Prefix search query
      const q = query(
        placesRef,
        where('name', '>=', searchTerm),
        where('name', '<=', searchTerm + '\uf8ff'),
        limit(10)
      );
      
      const querySnapshot = await getDocs(q);
      const places: Place[] = [];
      querySnapshot.forEach((doc) => {
        places.push({ ...sanitizePlace(doc.data()), isLocal: true });
      });

      // Update cache
      searchCache.set(cacheKey, { results: places, timestamp: Date.now() });
      return places;
    } catch (error) {
      logger.error("Error fetching suggestions from DB:", error);
      return [];
    } finally {
      inFlightRequests.delete(cacheKey);
    }
  })();

  inFlightRequests.set(cacheKey, fetchPromise);
  return fetchPromise;
}

/**
 * Search for a specific place by text query.
 */
export async function searchPlaces(queryStr: string, locationBias?: { lat: number; lng: number }, userId?: string): Promise<Place[]> {
  if (!queryStr) return [];

  // 1. Try original query
  let results = await internalSearchPlaces(queryStr, locationBias, userId);

  // 2. If no results and contains English letters, try Hebrew layout conversion
  if (results.length === 0 && hasEnglishLetters(queryStr)) {
    const convertedQuery = convertEnToHeLayout(queryStr);
    if (convertedQuery !== queryStr) {
      results = await internalSearchPlaces(convertedQuery, locationBias, userId);
    }
  }

  return results;
}

async function internalSearchPlaces(queryStr: string, locationBias?: { lat: number; lng: number }, userId?: string): Promise<Place[]> {
  if (!queryStr) return [];

  const cacheKey = `${queryStr.toLowerCase()}-${locationBias ? `${locationBias.lat.toFixed(2)},${locationBias.lng.toFixed(2)}` : 'none'}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < SEARCH_CACHE_EXPIRY) {
    return cached.results;
  }

  // 1. Check DB First (Prefix Search)
  const dbResults = await getSuggestionsFromDB(queryStr);
  
  // 2. Intelligent API Fallback - REMOVED to prevent external API calls and save quota/DB writes
  return dbResults;
}

/**
 * Helper to upsert a place to DB (used when selecting a Google result).
 */
export async function upsertPlaceToDB(place: Place) {
  if (place.isLocal) return; // Already in DB
  await savePlaceToDB(place);
}

function mapGoogleTypeToCategory(types: string[], primaryType?: string): string {
  const typeMap: Record<string, string> = {
    'restaurant': 'מסעדות',
    'cafe': 'בתי קפה',
    'bakery': 'מאפיות',
    'supermarket': 'סופרים',
    'grocery_store': 'סופרים',
    'convenience_store': 'סופרים',
    'pharmacy': 'בתי מרקחת',
    'gas_station': 'תחנות דלק',
    'atm': 'כספומטים',
    'coffee_shop': 'בתי קפה',
    'pizza_restaurant': 'מסעדות',
    'hamburger_restaurant': 'מסעדות',
    'sushi_restaurant': 'מסעדות',
    'night_club': 'אטרקציות',
    'bar': 'אטרקציות',
    'movie_theater': 'אטרקציות',
    'bowling_alley': 'אטרקציות',
    'amusement_park': 'אטרקציות',
    'tourist_attraction': 'אטרקציות',
    'museum': 'אטרקציות',
    'park': 'אטרקציות',
    'concert_hall': 'אטרקציות',
    'event_venue': 'אטרקציות',
    'video_arcade': 'אטרקציות',
    'sports_complex': 'אטרקציות',
    'stadium': 'אטרקציות',
    'zoo': 'אטרקציות',
    'aquarium': 'אטרקציות'
  };

  if (primaryType && typeMap[primaryType]) return typeMap[primaryType];
  
  for (const type of types) {
    if (typeMap[type]) return typeMap[type];
  }

  return 'עסק';
}

/**
 * Constructs a Google Places Photo URL or a stylized fallback illustration.
 */
export function getPlacePhotoUrl(photoName?: string, category?: string, id?: string): string {
  const apiKey = (import.meta as any).env.VITE_GOOGLE_MAPS_API_KEY;
  
  // If we have a photo reference and an API key, use it
  if (apiKey && photoName) {
    return `https://places.googleapis.com/v1/${photoName}/media?maxHeightPx=800&maxWidthPx=800&key=${apiKey}`;
  }
  
  // Final fallback: A "No Image" placeholder
  return 'NO_IMAGE';
}

/**
 * Detects if a business name is suspicious or low quality.
 */
function isPlaceSuspicious(name: string, category: string): boolean {
  if (!name) return true;
  
  // 1. Check for phone numbers or only numbers (e.g. "097660788")
  const onlyNumbers = /^[0-9\s\-+]+$/.test(name);
  if (onlyNumbers && name.length > 3) return true;

  // 2. Extremely short names
  if (name.trim().length < 2) return true;

  // 3. ATM specific filtering
  if (category === 'כספומטים') {
    const recognizedBanks = ["לאומי", "פועלים", "דיסקונט", "מזרחי", "בינלאומי", "ירושלים", "מרכנתיל", "מסד", "יהב", "אגוד", "דואר", "בנק"];
    const recognizedNetworks = ["כספונט", "casponet", "atm", "כספומט"];
    
    const lowerName = name.toLowerCase();
    const isRecognized = recognizedBanks.some(bank => lowerName.includes(bank)) || 
                         recognizedNetworks.some(net => lowerName.includes(net));
    
    // If it's an ATM but doesn't have a recognized bank or network name, it's likely invalid
    if (!isRecognized) return true;
  }

  return false;
}
