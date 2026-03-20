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
async function getPlacesFromDB(bounds: { north: number; south: number; east: number; west: number }, categoryId?: string | null, center?: { lat: number, lng: number }): Promise<Place[]> {
  const precision = 3; // Use 3 decimal places for cache key (approx 110m)
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
      
      // To avoid requiring complex composite indexes, we use a single-field range query on 'lat'
      const q = query(
        placesRef,
        where('lat', '>=', bounds.south),
        where('lat', '<=', bounds.north),
        limit(100) // Reduced limit to save reads, still enough for viewport
      );
      
      const querySnapshot = await getDocs(q);
      const places: Place[] = [];
      const targetCategory = categoryId ? mapCategoryIdToHebrew(categoryId) : null;
      
      querySnapshot.forEach((doc) => {
        const data = doc.data() as any;
        
        // 1. Filter longitude in memory
        const isInLngBounds = data.lng >= bounds.west && data.lng <= bounds.east;
        
        // 2. Filter category in memory (if active)
        const matchesCategory = !targetCategory || data.category === targetCategory;

        if (isInLngBounds && matchesCategory) {
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
      
      // Update cache
      dbCache.set(cacheKey, { places, timestamp: Date.now() });
      if (dbCache.size > 100) {
        const firstKey = dbCache.keys().next().value;
        if (firstKey) dbCache.delete(firstKey);
      }

      return places;
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
 * Helper to fetch nearest available places to current map center.
 */
async function getNearestPlaces(center: { lat: number, lng: number }, limitCount: number = 15): Promise<Place[]> {
  try {
    const placesRef = collection(db, 'places');
    // Simple range query on lat to get candidates near the center
    const q = query(
      placesRef,
      where('lat', '>=', center.lat - 0.2),
      where('lat', '<=', center.lat + 0.2),
      limit(50)
    );
    const querySnapshot = await getDocs(q);
    const places: Place[] = [];
    querySnapshot.forEach((doc) => {
      places.push(sanitizePlace(doc.data()));
    });
    
    // Sort by distance and take top N
    places.sort((a, b) => {
      const distA = Math.pow(a.lat - center.lat, 2) + Math.pow(a.lng - center.lng, 2);
      const distB = Math.pow(b.lat - center.lat, 2) + Math.pow(b.lng - center.lng, 2);
      return distA - distB;
    });
    
    return places.slice(0, limitCount);
  } catch (error) {
    logger.error("Error fetching nearest places:", error);
    return [];
  }
}

/**
 * Service to discover businesses within map bounds using Google Places API (New).
 * Implements smart fallback logic and radius expansion to ensure the map is never empty.
 */
export async function discoverPlaces(bounds: { north: number; south: number; east: number; west: number }, categoryId?: string | null, userId?: string): Promise<Place[]> {
  const MIN_RESULTS = 3; // Only trigger fallback if results <= 3
  const MAX_RESULTS = 100;
  const center = {
    lat: (bounds.north + bounds.south) / 2,
    lng: (bounds.east + bounds.west) / 2
  };

  // Helper to deduplicate and limit results
  const mergeResults = (existing: Place[], newPlaces: Place[], isFallback: boolean = false) => {
    const seen = new Set(existing.map(p => p.id));
    const merged = [...existing];
    newPlaces.forEach(p => {
      if (!seen.has(p.id)) {
        merged.push({ ...p, isFallback });
        seen.add(p.id);
      }
    });
    return merged;
  };

  // --- STAGE 1: INITIAL DB FETCH (Exact match) ---
  let results = await getPlacesFromDB(bounds, categoryId, center);

  // --- STAGE 2: SMART FALLBACK LOGIC ---
  if (results.length <= MIN_RESULTS) {
    
    // Priority 2: Expanded bounds (same category)
    if (categoryId) {
      console.log("Fallback triggered: expanding bounds (same category)");
      const latDiff = bounds.north - bounds.south;
      const lngDiff = bounds.east - bounds.west;
      const expandedBounds = {
        north: center.lat + (latDiff * 1.5) / 2,
        south: center.lat - (latDiff * 1.5) / 2,
        east: center.lng + (lngDiff * 1.5) / 2,
        west: center.lng - (lngDiff * 1.5) / 2
      };
      const expandedResults = await getPlacesFromDB(expandedBounds, categoryId, center);
      results = mergeResults(results, expandedResults, true);
    }

    // Priority 3: No category (original bounds)
    if (results.length <= MIN_RESULTS && categoryId) {
      console.log("Fallback triggered: removing category filter");
      const unfiltered = await getPlacesFromDB(bounds, null, center);
      results = mergeResults(results, unfiltered, true);
    }

    // Priority 4: Nearby fallback (distance-based, regardless of bounds)
    if (results.length <= MIN_RESULTS) {
      console.log("Fallback triggered: fetching nearest available places");
      const nearby = await getNearestPlaces(center, 15);
      results = mergeResults(results, nearby, true);
    }
  }

  // Final sort by distance from center
  results.sort((a, b) => {
    const distA = Math.pow(a.lat - center.lat, 2) + Math.pow(a.lng - center.lng, 2);
    const distB = Math.pow(b.lat - center.lat, 2) + Math.pow(b.lng - center.lng, 2);
    return distA - distB;
  });

  // If we still have very few results and user is authenticated, try Google API (optional discovery)
  if (results.length < 3 && userId) {
    try {
      const googleResults = await fetchGoogleDiscovery(bounds, categoryId, center, userId);
      results = mergeResults(results, googleResults);
    } catch (e) {
      // Ignore Google API errors in fallback
    }
  }

  return results.slice(0, MAX_RESULTS);
}

/**
 * Extracted Google Discovery logic for cleaner fallback
 */
async function fetchGoogleDiscovery(bounds: { north: number; south: number; east: number; west: number }, categoryId: string | null | undefined, center: { lat: number, lng: number }, userId: string): Promise<Place[]> {
  const radius = Math.sqrt(
    Math.pow((bounds.north - bounds.south) * 111320, 2) +
    Math.pow((bounds.east - bounds.west) * 111320 * Math.cos(center.lat * Math.PI / 180), 2)
  ) / 2;

  const categoryTypeMap: Record<string, string[]> = {
    'super': ["supermarket", "grocery_store", "convenience_store", "market"],
    'cafe': ["cafe", "coffee_shop"],
    'restaurant': ["restaurant", "pizza_restaurant", "hamburger_restaurant", "sushi_restaurant"],
    'pharmacy': ["pharmacy", "drugstore"],
    'gas': ["gas_station"],
    'bakery': ["bakery"],
    'atm': ["atm"],
    'attractions': ["night_club", "bar", "movie_theater", "tourist_attraction", "museum", "park"]
  };

  let categoryGroups: string[][] = [];
  if (categoryId && categoryTypeMap[categoryId]) {
    categoryGroups = categoryTypeMap[categoryId].map(type => [type]);
  } else {
    categoryGroups = Object.values(categoryTypeMap).slice(0, 3); // Limit to first 3 groups to save quota
  }

  const fetchGroup = async (includedTypes: string[]) => {
    const response = await fetch('/api/places/nearby', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId,
        includedTypes,
        maxResultCount: 15,
        locationRestriction: {
          circle: {
            center: { latitude: center.lat, longitude: center.lng },
            radius: Math.min(radius, 5000)
          }
        }
      })
    });
    if (!response.ok) return [];
    const data = await response.json();
    return data.places || [];
  };

  const resultsFromGoogle = await Promise.all(categoryGroups.map(fetchGroup));
  const processed = await Promise.all(resultsFromGoogle.flat().map(async (p: any) => {
    const category = mapGoogleTypeToCategory(p.types, p.primaryType);
    const place: Place = {
      id: p.id,
      name: p.displayName?.text || "עסק",
      lat: p.location.latitude,
      lng: p.location.longitude,
      category,
      address: p.formattedAddress,
      status: 'maybe',
      peopleCount: Math.floor(Math.random() * 10),
      lastUpdate: 'מעודכן כעת',
      lastUpdateTimestamp: Date.now(),
      confirmations: 0,
      officialOpen: true,
      reportsOpen: 0,
      reportsClosed: 0
    };
    await savePlaceToDB(place);
    return place;
  }));

  return processed;
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
  
  // 2. Intelligent API Fallback
  // Only trigger Google if DB results are fewer than 5 and query is at least 3 chars
  if (dbResults.length >= 5 || queryStr.length < 3) {
    return dbResults;
  }

  // If no results in DB, we proceed to Google API via Backend
  if (!userId) {
    logger.warn("User not authenticated, skipping Google API search.");
    return dbResults;
  }

  try {
    const body: any = {
      userId,
      query: queryStr,
      maxResultCount: 10,
      languageCode: "he"
    };

    if (locationBias) {
      body.locationBias = {
        circle: {
          center: { latitude: locationBias.lat, longitude: locationBias.lng },
          radius: 10000
        }
      };
    }

    const response = await fetch('/api/places/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });

    if (response.status === 429) {
      return dbResults;
    }

    if (!response.ok) return dbResults;
    const data = await response.json();
    
    const googleResults = await Promise.all((data.places || []).map(async (p: any) => {
      // Check if place exists in DB first to avoid duplicates
      const docRef = doc(db, 'places', p.id);
      const docSnap = await getDoc(docRef);
      
      if (docSnap.exists()) {
        return { ...sanitizePlace(docSnap.data()), isLocal: true };
      }

      const category = mapGoogleTypeToCategory(p.types, p.primaryType);
      const name = p.displayName?.text || "עסק ללא שם";
      const isSuspicious = isPlaceSuspicious(name, category);
      
      const place: Place = {
        id: p.id,
        name,
        lat: p.location.latitude,
        lng: p.location.longitude,
        category,
        address: p.formattedAddress,
        place_id: p.id,
        photo_reference: p.photos?.[0]?.name,
        status: 'maybe',
        peopleCount: Math.floor(Math.random() * 20),
        lastUpdate: 'מעודכן כעת',
        lastUpdateTimestamp: Date.now(),
        confirmations: Math.floor(Math.random() * 15),
        officialOpen: p.regularOpeningHours?.openNow ?? true,
        photo_url: getPlacePhotoUrl(p.photos?.[0]?.name, category, p.id),
        openingHours: p.regularOpeningHours?.weekdayDescriptions,
        openingPeriods: p.regularOpeningHours?.periods,
        socialPulse: 'active',
        physicalPresence: 0.8,
        woltStatus: 'open',
        easyStatus: 'open',
        isSuspicious,
        isLocal: false
      };

      // Note: We don't upsert here automatically to save on writes for every suggestion.
      // We'll upsert when the user actually SELECTS the result in the UI.
      return place;
    }));

    // Merge results: DB first, then Google (deduplicated)
    const merged = [...dbResults];
    googleResults.forEach(gp => {
      if (!merged.find(dp => dp.id === gp.id)) {
        merged.push(gp);
      }
    });

    const finalResults = merged.filter(p => !isPlaceIncomplete(p));
    
    // Update cache
    searchCache.set(cacheKey, { results: finalResults, timestamp: Date.now() });
    if (searchCache.size > 50) {
      const firstKey = searchCache.keys().next().value;
      if (firstKey) searchCache.delete(firstKey);
    }

    return finalResults;
  } catch (error) {
    logger.error("Error searching places:", error);
    return dbResults;
  }
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
