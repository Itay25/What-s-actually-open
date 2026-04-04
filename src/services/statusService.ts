import { Place, Status, NormalizedOpeningHours, TimeRange } from '../types';
import { normalizeOpeningHours } from '../utils/openingHours';
import { isLiveCheckValid } from '../utils/liveCheck';

const DAY_INDEX_TO_KEY: (keyof NormalizedOpeningHours)[] = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

export interface StatusResult {
  isOpen: boolean;
  confidence: number; // 0-100
  source: "hours" | "users" | "mixed";
  uiStatus: string;
  uiColor: string;
  reportCount?: number;
  openReportsCount?: number;
  closedReportsCount?: number;
  openReporterPhotos?: string[];
  closedReporterPhotos?: string[];
  reporterPhotos?: string[];
  lastUpdateMinutes?: number;
  confidenceLevel?: 'low' | 'medium' | 'high';
  secondaryMessage?: string;
}

/**
 * Calculates the real open status based on a weighted consensus algorithm.
 * This system is designed to be more accurate than Google by prioritizing 
 * real-time community signals over static official hours.
 */
export function calculateRealOpenStatus(place: Place, currentTime: Date = new Date()): StatusResult {
  const nowTimestamp = currentTime.getTime();

  // --- 0. AI LIVE CHECK OVERRIDE ---
  if (isLiveCheckValid(place) && place.liveCheckResult && place.liveCheckResult.confidence >= 0.7) {
    const aiStatus = place.liveCheckResult.finalStatus;
    const lastUpdateMinutes = Math.round((nowTimestamp - place.liveCheckResult.checkedAt) / 60000);
    
    if (aiStatus === 'OPEN') {
      return {
        isOpen: true,
        confidence: place.liveCheckResult.confidence * 100,
        source: "mixed",
        uiStatus: "פתוח",
        uiColor: "green",
        secondaryMessage: "נבדק בזמן אמת על ידי בינה מלאכותית",
        lastUpdateMinutes
      };
    } else if (aiStatus === 'CLOSED') {
      return {
        isOpen: false,
        confidence: place.liveCheckResult.confidence * 100,
        source: "mixed",
        uiStatus: "סגור",
        uiColor: "red",
        secondaryMessage: "נבדק בזמן אמת על ידי בינה מלאכותית",
        lastUpdateMinutes
      };
    } else if (aiStatus === 'CLOSING_SOON') {
      return {
        isOpen: true,
        confidence: place.liveCheckResult.confidence * 100,
        source: "mixed",
        uiStatus: "נסגר בקרוב",
        uiColor: "yellow",
        secondaryMessage: "נבדק בזמן אמת על ידי בינה מלאכותית",
        lastUpdateMinutes
      };
    } else if (aiStatus === 'UNCERTAIN') {
      return {
        isOpen: false, // Fallback
        confidence: place.liveCheckResult.confidence * 100,
        source: "mixed",
        uiStatus: "לא ודאי",
        uiColor: "orange",
        secondaryMessage: "אין מספיק מידע עדכני",
        lastUpdateMinutes
      };
    }
  }

  const parseTimestamp = (ts: any): number | null => {
    if (!ts) return null;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'string') return new Date(ts).getTime();
    if (typeof ts === 'object' && ts.toDate) return ts.toDate().getTime();
    if (typeof ts === 'object' && 'seconds' in ts) return ts.seconds * 1000;
    return null;
  };

  // --- 1. BASELINE: Official Hours ---
  const baseStatus = getBaseOpenStatus(place, currentTime);
  const minutesUntilClose = getMinutesUntilClose(place, currentTime);
  
  let isScheduledOpen = false;
  let isClosingSoon = false;
  
  if (baseStatus === 'open' || baseStatus === 'open_24h') {
    isScheduledOpen = true;
    isClosingSoon = minutesUntilClose <= 60;
  } else if (baseStatus === 'closing_soon') {
    isScheduledOpen = true;
    isClosingSoon = true;
  }

  // Baseline score: 70 if open, 30 if closed. 50 if unknown.
  let score = baseStatus === 'unknown' ? 50 : (isScheduledOpen ? 70 : 30);
  let source: "hours" | "users" | "mixed" = "hours";

  // --- 2. COMMUNITY SIGNALS: User Reports ---
  const allReports = (place.userReports || []);
  
  // Filter reports from the last 3 hours
  const activeReports = allReports.filter(r => {
    const ts = parseTimestamp(r.timestamp);
    if (!ts) return false;
    const ageMinutes = (nowTimestamp - ts) / (1000 * 60);
    return ageMinutes >= 0 && ageMinutes <= 180; // 3h window
  });

  const openReports = activeReports.filter(r => r.status === 'open');
  const closedReports = activeReports.filter(r => r.status === 'closed');
  const uniqueUsers = new Set(activeReports.map(r => r.userId)).size;

  // Weighting Logic
  let reportInfluence = 0;
  activeReports.forEach(report => {
    const ts = parseTimestamp(report.timestamp);
    const ageMinutes = (nowTimestamp - (ts || 0)) / (1000 * 60);
    
    // Decay function: Fresh reports (<30m) have full weight, older reports decay
    let weight = 0;
    if (ageMinutes <= 30) weight = 40;
    else if (ageMinutes <= 90) weight = 25;
    else weight = 10;

    // Reliability boost (placeholder for future user-level trust scores)
    // if (report.userTrust > 0.8) weight *= 1.2;

    if (report.status === 'open') reportInfluence += weight;
    else reportInfluence -= weight;
  });

  // Apply influence to score
  score += reportInfluence;
  
  // Cap the score
  score = Math.max(0, Math.min(100, score));

  // Determine Source
  if (activeReports.length > 0) {
    const hoursAgree = (isScheduledOpen && reportInfluence > 0) || (!isScheduledOpen && reportInfluence < 0);
    source = hoursAgree ? "mixed" : "users";
  }

  // --- 3. CONFLICT & CONFIDENCE ---
  // If we have conflicting reports, penalize confidence
  let conflictPenalty = 0;
  if (openReports.length > 0 && closedReports.length > 0) {
    conflictPenalty = Math.min(30, Math.abs(openReports.length - closedReports.length) * 5);
  }

  // Confidence is based on the distance from the "uncertainty" center (50)
  // and boosted by the number of unique reporters.
  let confidence = Math.abs(score - 50) * 2; 
  confidence -= conflictPenalty;
  
  // Boost confidence for multiple unique users
  if (uniqueUsers >= 3) confidence += 20;
  else if (uniqueUsers >= 2) confidence += 10;

  confidence = Math.max(0, Math.min(100, confidence));

  // --- 4. FINAL STATUS MAPPING ---
  let isOpen = score > 50;
  let uiStatus = "";
  let uiColor = "";
  let secondaryMessage = "";

  if (score > 65) {
    uiStatus = isClosingSoon ? "נסגר בקרוב" : "פתוח";
    uiColor = isClosingSoon ? "yellow" : "green";
    if (source === 'users' && !isScheduledOpen) {
      uiStatus = "פתוח (מחוץ לשעות)";
      secondaryMessage = "דווח כפתוח על ידי הקהילה";
    }
  } else if (score < 35) {
    uiStatus = "סגור";
    uiColor = "red";
    if (source === 'users' && isScheduledOpen) {
      uiStatus = "דווח כסגור";
      uiColor = "orange";
      secondaryMessage = "משתמשים דיווחו שהמקום סגור כעת";
    }
  } else {
    uiStatus = "לא ודאי";
    uiColor = "orange";
    isOpen = isScheduledOpen; // Fallback to schedule for boolean
    secondaryMessage = activeReports.length > 0 ? "דיווחים סותרים מהשטח" : "אין מספיק מידע ודאי";
  }

  // Metadata for UI
  const newestReport = activeReports.length > 0 
    ? Math.max(...activeReports.map(r => parseTimestamp(r.timestamp) || 0))
    : null;
  const lastUpdateMinutes = newestReport ? Math.round((nowTimestamp - newestReport) / (1000 * 60)) : undefined;
  
  const reporterPhotos = activeReports
    .filter(r => r.userPhoto)
    .map(r => r.userPhoto!)
    .slice(0, 3);

  const openReporterPhotos = openReports
    .filter(r => r.userPhoto)
    .map(r => r.userPhoto!)
    .slice(0, 3);

  const closedReporterPhotos = closedReports
    .filter(r => r.userPhoto)
    .map(r => r.userPhoto!)
    .slice(0, 3);

  const confidenceLevel: 'low' | 'medium' | 'high' = 
    confidence > 80 ? 'high' : confidence > 40 ? 'medium' : 'low';

  return {
    isOpen,
    confidence,
    source,
    uiStatus,
    uiColor,
    reportCount: activeReports.length,
    openReportsCount: openReports.length,
    closedReportsCount: closedReports.length,
    openReporterPhotos,
    closedReporterPhotos,
    reporterPhotos,
    lastUpdateMinutes,
    confidenceLevel,
    secondaryMessage
  };
}

/**
 * Internal helper to get base open status from official hours
 */
function getBaseOpenStatus(place: Place, now: Date): 'open' | 'closed' | 'closing_soon' | 'unknown' | 'open_24h' {
  const currentDay = now.getDay();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentTimeInMinutes = currentHour * 60 + currentMinute;

  let normalized = place.normalizedOpeningHours;
  if (!normalized && place.openingHours) {
    normalized = normalizeOpeningHours(place.openingHours);
  }

  if (normalized) {
    const todayKey = DAY_INDEX_TO_KEY[currentDay];
    const yesterdayKey = DAY_INDEX_TO_KEY[(currentDay + 6) % 7];
    
    const todayRanges = normalized[todayKey] || [];
    const yesterdayRanges = normalized[yesterdayKey] || [];

    let isOpen = false;
    let is24h = false;
    let minutesUntilClose = Infinity;

    for (const range of todayRanges) {
      const { open, close } = range;
      if (open === close && open === 0) {
        isOpen = true;
        is24h = true;
        minutesUntilClose = Infinity;
        break;
      }

      if (close < open) {
        if (currentTimeInMinutes >= open || currentTimeInMinutes < close) {
          isOpen = true;
          const remaining = currentTimeInMinutes >= open 
            ? (1440 - currentTimeInMinutes) + close 
            : close - currentTimeInMinutes;
          minutesUntilClose = Math.min(minutesUntilClose, remaining);
        }
      } else {
        if (currentTimeInMinutes >= open && currentTimeInMinutes < close) {
          isOpen = true;
          minutesUntilClose = Math.min(minutesUntilClose, close - currentTimeInMinutes);
        }
      }
    }

    if (!isOpen) {
      for (const range of yesterdayRanges) {
        const { open, close } = range;
        if (close < open && currentTimeInMinutes < close) {
          isOpen = true;
          minutesUntilClose = Math.min(minutesUntilClose, close - currentTimeInMinutes);
        }
      }
    }

    if (is24h) return 'open_24h';
    if (isOpen) return minutesUntilClose <= 60 ? 'closing_soon' : 'open';
    return 'closed';
  }

  if (place.openingPeriods && place.openingPeriods.length > 0) {
    let isOpen = false;
    let is24h = false;
    let minutesUntilClose = Infinity;

    for (const period of place.openingPeriods) {
      const openDay = period.open.day;
      const closeDay = period.close ? period.close.day : openDay;
      const openTime = period.open.hour * 60 + period.open.minute;
      const closeTime = period.close ? period.close.hour * 60 + period.close.minute : openTime;

      // 24h case
      if (!period.close || (openDay === period.close.day && openTime === closeTime)) {
        // If it's 24/7 always (!period.close) or 24/7 today
        if (!period.close || openDay === currentDay) {
          isOpen = true;
          is24h = true;
          minutesUntilClose = Infinity;
          break;
        }
        continue;
      }

      if (openDay === currentDay) {
        if (closeDay !== openDay) {
          if (currentTimeInMinutes >= openTime) {
            isOpen = true;
            minutesUntilClose = Math.min(minutesUntilClose, (1440 - currentTimeInMinutes) + closeTime);
          }
        } else {
          if (currentTimeInMinutes >= openTime && currentTimeInMinutes < closeTime) {
            isOpen = true;
            minutesUntilClose = Math.min(minutesUntilClose, closeTime - currentTimeInMinutes);
          }
        }
      } else if (closeDay === currentDay && openDay === (currentDay + 6) % 7) {
        if (currentTimeInMinutes < closeTime) {
          isOpen = true;
          minutesUntilClose = Math.min(minutesUntilClose, closeTime - currentTimeInMinutes);
        }
      }
    }

    if (is24h) return 'open_24h';
    if (isOpen) return minutesUntilClose <= 60 ? 'closing_soon' : 'open';
    return 'closed';
  }

  return 'unknown';
}

/**
 * Internal helper to get minutes until close
 */
function getMinutesUntilClose(place: Place, now: Date): number {
  const currentDay = now.getDay();
  const currentHour = now.getHours();
  const currentMinute = now.getMinutes();
  const currentTimeInMinutes = currentHour * 60 + currentMinute;

  let normalized = place.normalizedOpeningHours;
  if (!normalized && place.openingHours) {
    normalized = normalizeOpeningHours(place.openingHours);
  }

  if (normalized) {
    const todayKey = DAY_INDEX_TO_KEY[currentDay];
    const yesterdayKey = DAY_INDEX_TO_KEY[(currentDay + 6) % 7];
    const todayRanges = normalized[todayKey] || [];
    const yesterdayRanges = normalized[yesterdayKey] || [];

    let minRemaining = Infinity;

    for (const range of todayRanges) {
      const { open, close } = range;
      if (open === close && open === 0) return Infinity; // 24h TODAY
      
      if (close < open) {
        if (currentTimeInMinutes >= open || currentTimeInMinutes < close) {
          const remaining = currentTimeInMinutes >= open ? (1440 - currentTimeInMinutes) + close : close - currentTimeInMinutes;
          minRemaining = Math.min(minRemaining, remaining);
        }
      } else if (currentTimeInMinutes >= open && currentTimeInMinutes < close) {
        minRemaining = Math.min(minRemaining, close - currentTimeInMinutes);
      }
    }

    if (minRemaining === Infinity) {
      for (const range of yesterdayRanges) {
        const { open, close } = range;
        if (close < open && currentTimeInMinutes < close) {
          minRemaining = Math.min(minRemaining, close - currentTimeInMinutes);
        }
      }
    }
    return minRemaining;
  }

  if (place.openingPeriods && place.openingPeriods.length > 0) {
    let minRemaining = Infinity;

    for (const period of place.openingPeriods) {
      const openDay = period.open.day;
      const closeDay = period.close ? period.close.day : openDay;
      const openTime = period.open.hour * 60 + period.open.minute;
      const closeTime = period.close ? period.close.hour * 60 + period.close.minute : openTime;

      if (!period.close || (openDay === period.close.day && openTime === closeTime)) {
        if (!period.close || openDay === currentDay) return Infinity;
        continue;
      }

      if (openDay === currentDay) {
        if (closeDay !== openDay) {
          if (currentTimeInMinutes >= openTime) {
            minRemaining = Math.min(minRemaining, (1440 - currentTimeInMinutes) + closeTime);
          }
        } else if (currentTimeInMinutes >= openTime && currentTimeInMinutes < closeTime) {
          minRemaining = Math.min(minRemaining, closeTime - currentTimeInMinutes);
        }
      } else if (closeDay === currentDay && openDay === (currentDay + 6) % 7) {
        if (currentTimeInMinutes < closeTime) {
          minRemaining = Math.min(minRemaining, closeTime - currentTimeInMinutes);
        }
      }
    }
    return minRemaining;
  }

  return Infinity;
}

/**
 * Calculates the dynamic status of a place based on its opening hours and current time.
 */
export function computeOpenStatus(place: Place): 'open' | 'closed' | 'closing_soon' | 'unknown' {
  const { isOpen, uiStatus } = calculateRealOpenStatus(place);
  
  if (uiStatus === 'נסגר בקרוב') return 'closing_soon';
  if (uiStatus === 'לא ודאי') return 'unknown';
  return isOpen ? 'open' : 'closed';
}
