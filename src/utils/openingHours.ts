import { NormalizedOpeningHours, TimeRange } from '../types';

const DAY_MAP: Record<string, keyof NormalizedOpeningHours> = {
  'יום ראשון': 'Sunday',
  'יום שני': 'Monday',
  'יום שלישי': 'Tuesday',
  'יום רביעי': 'Wednesday',
  'יום חמישי': 'Thursday',
  'יום שישי': 'Friday',
  'יום שבת': 'Saturday',
  'sunday': 'Sunday',
  'monday': 'Monday',
  'tuesday': 'Tuesday',
  'wednesday': 'Wednesday',
  'thursday': 'Thursday',
  'friday': 'Friday',
  'saturday': 'Saturday',
  'sun': 'Sunday',
  'mon': 'Monday',
  'tue': 'Tuesday',
  'wed': 'Wednesday',
  'thu': 'Thursday',
  'fri': 'Friday',
  'sat': 'Saturday',
};

/**
 * Converts time string to minutes since midnight
 * Supports: "8:00", "08:00", "8 AM", "10:00 PM", "10 PM"
 */
function timeToMinutes(timeStr: string): number | null {
  if (!timeStr) return null;
  
  const cleanTime = timeStr.trim().toLowerCase().replace(/[\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g, ' ');
  
  // Handle AM/PM
  const ampmMatch = cleanTime.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/);
  if (ampmMatch) {
    let hours = parseInt(ampmMatch[1], 10);
    const minutes = ampmMatch[2] ? parseInt(ampmMatch[2], 10) : 0;
    const isPm = ampmMatch[3] === 'pm';
    
    if (isPm && hours < 12) hours += 12;
    if (!isPm && hours === 12) hours = 0;
    
    return hours * 60 + minutes;
  }
  
  // Handle 24h format
  const h24Match = cleanTime.match(/(\d{1,2}):(\d{2})/);
  if (h24Match) {
    const hours = parseInt(h24Match[1], 10);
    const minutes = parseInt(h24Match[2], 10);
    return hours * 60 + minutes;
  }

  // Handle 24h format without minutes (e.g., "8", "22")
  const hOnlyMatch = cleanTime.match(/^(\d{1,2})$/);
  if (hOnlyMatch) {
    const hours = parseInt(hOnlyMatch[1], 10);
    if (hours >= 0 && hours <= 24) {
      return hours * 60;
    }
  }

  return null;
}

/**
 * Parses a single day's hours string into multiple TimeRanges
 */
function parseDayHours(hoursStr: string): TimeRange[] {
  const ranges: TimeRange[] = [];
  const cleanStr = hoursStr.trim().toLowerCase().replace(/[\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/g, ' ');
  
  // 24 Hours
  if (cleanStr.includes('24') || cleanStr.includes('פתוח 24 שעות') || cleanStr.includes('24/7')) {
    return [{ open: 0, close: 0 }]; // 0 to 0 is 24h in this context, or we can use 0 to 1440
  }
  
  // Closed
  if (cleanStr.includes('closed') || cleanStr.includes('סגור')) {
    return [];
  }
  
  // Split by comma or semicolon for multiple ranges
  const parts = cleanStr.split(/[,;]/);
  
  parts.forEach(part => {
    // Support various dashes: – (en dash), - (hyphen), — (em dash) and "to"
    const rangeMatch = part.match(/(.*?)(?:–|-|—|\s+to\s+)(.*)/);
    if (rangeMatch) {
      const open = timeToMinutes(rangeMatch[1]);
      const close = timeToMinutes(rangeMatch[2]);
      
      if (open !== null && close !== null) {
        ranges.push({ open, close });
      }
    }
  });
  
  return ranges;
}

/**
 * Robustly normalizes opening hours from various formats
 */
export function normalizeOpeningHours(input: any): NormalizedOpeningHours | undefined {
  if (!input) return undefined;
  
  const result: NormalizedOpeningHours = {};
  let successCount = 0;

  try {
    // Format: Array of strings ["Sunday: 8:00-22:00", ...] OR Array of objects [{day: "Sunday", hours: "8:00-22:00"}]
    if (Array.isArray(input)) {
      input.forEach((item) => {
        // Handle Array of strings
        if (typeof item === 'string') {
          // Split by first colon
          const parts = item.split(':');
          if (parts.length < 2) return;
          
          const dayPart = parts[0].trim().toLowerCase().replace(/\./g, '');
          const hoursPart = parts.slice(1).join(':').trim();
          
          const dayKey = DAY_MAP[dayPart];
          if (dayKey) {
            const parsed = parseDayHours(hoursPart);
            if (parsed.length > 0 || hoursPart.includes('סגור') || hoursPart.includes('closed')) {
              result[dayKey] = parsed;
              successCount++;
            }
          }
        }
        // Handle Array of objects {day: "...", hours: "..."}
        else if (item && typeof item === 'object' && item.day && item.hours) {
          const dayPart = String(item.day).trim().toLowerCase().replace(/\./g, '');
          const hoursPart = String(item.hours).trim();
          
          const dayKey = DAY_MAP[dayPart];
          if (dayKey) {
            const parsed = parseDayHours(hoursPart);
            if (parsed.length > 0 || hoursPart.includes('סגור') || hoursPart.includes('closed')) {
              result[dayKey] = parsed;
              successCount++;
            }
          }
        }
      });
    } 
    // Format: Object { "Sunday": "8:00-22:00", ... }
    else if (typeof input === 'object') {
      Object.entries(input).forEach(([day, hours]) => {
        const dayKey = DAY_MAP[day.toLowerCase().replace(/\./g, '')];
        if (dayKey && typeof hours === 'string') {
          const parsed = parseDayHours(hours);
          if (parsed.length > 0 || hours.includes('סגור') || hours.includes('closed')) {
            result[dayKey] = parsed;
            successCount++;
          }
        }
      });
    }

    if (successCount === 0) {
      return undefined;
    }

    return result;
  } catch (error) {
    console.error('Error normalizing opening hours:', error, 'Input:', input);
    return undefined;
  }
}
