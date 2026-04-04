import { Place } from '../types';

/**
 * Helper function to determine if a Live Check result is still valid.
 * A live check is VALID only if:
 * a) It exists.
 * b) Less than 2 hours have passed since checkedAt.
 * c) The checkedAt date is the same as the current date in Israel.
 * d) If AI provided todayHours, current time is not past the closing time.
 */
export const isLiveCheckValid = (place: Place | null): boolean => {
  if (!place || !place.liveCheckResult) return false;
  
  const { checkedAt, todayHours } = place.liveCheckResult;
  if (!checkedAt) return false;

  const now = Date.now();
  const twoHours = 2 * 60 * 60 * 1000;
  
  // a) Less than 2 hours have passed since checkedAt
  if (now - checkedAt > twoHours) return false;

  // b) The checkedAt date is the same as the current date in Israel
  const israelDateNow = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  const israelDateCheckedAt = new Date(checkedAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  if (israelDateNow !== israelDateCheckedAt) return false;

  // c) If AI provided todayHours (e.g., "08:00-14:00"), check if current time is past closing time
  if (todayHours && todayHours !== "UNKNOWN") {
    // Extract all time matches (HH:MM)
    const timeMatches = todayHours.match(/(\d{2}:\d{2})/g);
    if (timeMatches && timeMatches.length >= 2) {
      // We take the last time match as the final closing time for the day
      const lastClosingTimeStr = timeMatches[timeMatches.length - 1];
      const [closeH, closeM] = lastClosingTimeStr.split(':').map(Number);
      
      if (!isNaN(closeH) && !isNaN(closeM)) {
        // Get current time in Israel
        const israelTimeNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
        const currentH = israelTimeNow.getHours();
        const currentM = israelTimeNow.getMinutes();
        
        // If current time is past the closing time, it's expired
        if (currentH > closeH || (currentH === closeH && currentM >= closeM)) {
          return false;
        }
      }
    }
  }

  return true;
};
