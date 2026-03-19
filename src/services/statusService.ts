import { Place, Status, NormalizedOpeningHours, TimeRange } from '../types';
import { normalizeOpeningHours } from '../utils/openingHours';

const DAY_INDEX_TO_KEY: (keyof NormalizedOpeningHours)[] = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
];

export interface StatusResult {
  confidenceScore: number;
  uiStatus: string;
  uiColor: string;
  reportCount?: number;
  reporterPhotos?: string[];
  lastUpdateMinutes?: number;
  confidenceLevel?: 'low' | 'medium' | 'high';
  secondaryMessage?: string;
}

/**
 * Calculates the real open status based on probabilistic heuristics.
 */
export function calculateRealOpenStatus(place: Place, currentTime: Date = new Date()): StatusResult {
  const currentHour = currentTime.getHours();
  const nowTimestamp = currentTime.getTime();

  const parseTimestamp = (ts: any): number | null => {
    if (!ts) return null;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'string') return new Date(ts).getTime();
    if (typeof ts === 'object' && ts.toDate) return ts.toDate().getTime();
    if (typeof ts === 'object' && 'seconds' in ts) return ts.seconds * 1000;
    return null;
  };

  // 1. Get Schedule Status
  const baseStatus = getBaseOpenStatus(place, currentTime);
  const minutesUntilClose = getMinutesUntilClose(place, currentTime);
  
  let scheduleStatus: 'OPEN' | 'CLOSING_SOON' | 'CLOSED' = 'CLOSED';
  if (baseStatus === 'open' || baseStatus === 'open_24h') {
    scheduleStatus = minutesUntilClose <= 60 ? 'CLOSING_SOON' : 'OPEN';
  } else if (baseStatus === 'closing_soon') {
    scheduleStatus = 'CLOSING_SOON';
  }

  // 2. Process Community Reports
  const allReports = (place.userReports || []);
  const validReports = allReports.filter(r => {
    const ts = parseTimestamp(r.timestamp);
    if (!ts) return false;
    const ageMinutes = (nowTimestamp - ts) / (1000 * 60);
    return ageMinutes >= 5 && ageMinutes <= 120; // 2h window
  });

  // Stale reports: older than 90 minutes
  const freshReports = validReports.filter(r => {
    const ts = parseTimestamp(r.timestamp);
    const ageMinutes = (nowTimestamp - (ts || 0)) / (1000 * 60);
    return ageMinutes <= 90;
  });

  const reportsToUse = freshReports;
  const openReports = reportsToUse.filter(r => r.status === 'open');
  const closedReports = reportsToUse.filter(r => r.status === 'closed');

  const uniqueUsers = new Set(reportsToUse.map(r => r.userId)).size;
  const totalCount = reportsToUse.length;

  let communityConfidence: 'low' | 'medium' | 'high' = 'low';
  if (totalCount >= 3 || (totalCount >= 2 && uniqueUsers >= 2)) {
    communityConfidence = 'high';
  } else if (totalCount >= 2) {
    communityConfidence = 'medium';
  } else if (totalCount === 1) {
    communityConfidence = 'low';
  }

  // Diversity factor: If all reports from same user, reduce confidence
  if (totalCount >= 2 && uniqueUsers === 1) {
    if (communityConfidence === 'high') communityConfidence = 'medium';
    else if (communityConfidence === 'medium') communityConfidence = 'low';
  }

  const dominantStatus = openReports.length > closedReports.length ? 'REPORTED_OPEN' : 
                         closedReports.length > openReports.length ? 'REPORTED_CLOSED' : 
                         totalCount > 0 ? 'MIXED' : 'UNCONFIRMED';

  // 3. Combine Logic
  let uiStatus = "";
  let uiColor = "";
  let secondaryMessage = "";

  // Default UI based on schedule
  if (scheduleStatus === 'OPEN') {
    uiStatus = "פתוח";
    uiColor = "green";
  } else if (scheduleStatus === 'CLOSING_SOON') {
    uiStatus = "נסגר בקרוב";
    uiColor = "yellow";
  } else {
    uiStatus = "סגור";
    uiColor = "red";
  }

  if (dominantStatus === 'MIXED') {
    uiStatus = "דיווחים מעורבים";
    uiColor = "orange"; // Yellow marker
    secondaryMessage = "משתמשים דיווחו דברים שונים";
  } else if (dominantStatus === 'REPORTED_OPEN') {
    if (scheduleStatus === 'CLOSED' && communityConfidence === 'high') {
      uiStatus = "דווח כפתוח על ידי הקהילה";
      uiColor = "orange"; // Yellow marker
    } else if (scheduleStatus === 'CLOSING_SOON') {
      uiStatus = "נסגר בקרוב";
      uiColor = "yellow";
      secondaryMessage = "משתמשים אישרו שהמקום עדיין פתוח";
    } else if (scheduleStatus === 'OPEN') {
      uiStatus = "פתוח";
      uiColor = "green";
      // Freshness update handled by lastUpdateMinutes
    }
  } else if (dominantStatus === 'REPORTED_CLOSED') {
    if ((scheduleStatus === 'OPEN' || scheduleStatus === 'CLOSING_SOON') && communityConfidence === 'high') {
      uiStatus = "דווח כסגור על ידי הקהילה";
      uiColor = "orange"; // Yellow marker
    } else if (scheduleStatus === 'CLOSED') {
      uiStatus = "סגור";
      uiColor = "red";
    }
  }

  // Metadata for UI
  const newestReport = reportsToUse.length > 0 
    ? Math.max(...reportsToUse.map(r => parseTimestamp(r.timestamp) || 0))
    : null;
  const lastUpdateMinutes = newestReport ? Math.round((nowTimestamp - newestReport) / (1000 * 60)) : undefined;
  
  const reporterPhotos = reportsToUse
    .filter(r => r.userPhoto)
    .map(r => r.userPhoto!)
    .slice(0, 3);

  return {
    confidenceScore: communityConfidence === 'high' ? 90 : communityConfidence === 'medium' ? 70 : 50,
    uiStatus,
    uiColor,
    reportCount: totalCount,
    reporterPhotos,
    lastUpdateMinutes,
    confidenceLevel: communityConfidence,
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
  const { uiStatus } = calculateRealOpenStatus(place);
  
  if (uiStatus === 'פתוח' || uiStatus === 'דווח כפתוח') return 'open';
  if (uiStatus === 'נסגר בקרוב') return 'closing_soon';
  if (uiStatus === 'לא ודאי') return 'unknown';
  return 'closed';
}
