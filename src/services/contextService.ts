import axios from 'axios';
import Parser from 'rss-parser';
import logger from '../utils/logger';

const parser = new Parser();

/**
 * Fetches today's Jewish holiday context from Hebcal.
 */
async function getHolidayContext(): Promise<string> {
  try {
    const now = new Date();
    const israelTime = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
    const yyyy = israelTime.getFullYear();
    const mm = String(israelTime.getMonth() + 1).padStart(2, '0');
    const dd = String(israelTime.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}-${mm}-${dd}`;

    const response = await axios.get(`https://www.hebcal.com/converter?cfg=json&date=${dateStr}&g2h=1&strict=1`);
    const data = response.data;

    if (data.events && data.events.length > 0) {
      return `TODAY IS A JEWISH HOLIDAY/EVE: ${data.events.join(', ')}. Standard hours might be inaccurate today. The business might have special holiday hours, close early, or remain completely closed. DO NOT ASSUME closure without proof.`;
    }
    return "No special Jewish holidays today.";
  } catch (error) {
    logger.error("Error fetching holiday context:", error);
    return "Could not fetch holiday context.";
  }
}

/**
 * Fetches current security context from Ynet RSS feed.
 */
async function getSecurityContext(): Promise<string> {
  try {
    const feed = await parser.parseURL('http://www.ynet.co.il/Integration/StoryRss1854.xml');
    const items = feed.items.slice(0, 15);
    const keywords = ['פיקוד העורף', 'אזעק', 'יירוט', 'טילים', 'מחבל', 'הנחיות', 'מטח'];
    
    let alertCount = 0;
    for (const item of items) {
      const content = ((item.title || '') + ' ' + (item.contentSnippet || '')).toLowerCase();
      if (keywords.some(kw => content.includes(kw))) {
        alertCount++;
      }
    }

    if (alertCount >= 2) {
      return `HIGH SECURITY TENSION/WAR DETECTED: There are multiple security alerts in the latest news (${alertCount} relevant items found). AI MUST check for Home Front Command (Pikud HaOref) closures or restrictions. Businesses may be closed or operating under limited capacity.`;
    }
    return "Security situation appears standard.";
  } catch (error) {
    logger.error("Error fetching security context:", error);
    return "Could not fetch security context.";
  }
}

/**
 * Builds a combined dynamic context string for the AI.
 */
export async function buildDynamicIsraeliContext(): Promise<string> {
  const now = new Date();
  const israelTimeStr = now.toLocaleString('en-US', { timeZone: 'Asia/Jerusalem', hour12: false });
  
  const [holidayStatus, securityStatus] = await Promise.all([
    getHolidayContext(),
    getSecurityContext()
  ]);

  return `
=== DYNAMIC ISRAELI CONTEXT (REAL-TIME) ===
Current Israel Time: ${israelTimeStr}
Holiday Status: ${holidayStatus}
Security Status: ${securityStatus}

STRICT INSTRUCTIONS FOR AI:
1. You MUST check if this specific dynamic context affects the business TODAY.
2. DO NOT GUESS OR ASSUME the business is closed just because there is a holiday or security tension. You must actively search for PROOF (e.g., official Facebook/Instagram posts, municipal notices).
3. If the business is known to be open on weekends (Saturdays/Shabbat), there is a high chance it operates on holiday schedules rather than being completely closed.
4. If you cannot find explicitly verified holiday/emergency hours, base your decision on logical deduction from their standard weekend behavior, but explicitly state your uncertainty in the reason.
===========================================
`;
}
