import { Place } from '../types';
import logger from '../utils/logger';

export interface EmergencyStatus {
  active: boolean;
  operationName?: string;
  message?: string;
  lastChecked?: number;
}

const EMERGENCY_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const LOCAL_STORAGE_KEY = 'emergency_status_cache';

/**
 * Service to automatically detect emergency situations in Israel.
 * Uses public alert history to determine if there's an active security situation.
 */
export async function checkEmergencyStatus(): Promise<EmergencyStatus> {
  // 1. Check cache first
  const cached = localStorage.getItem(LOCAL_STORAGE_KEY);
  if (cached) {
    const parsed = JSON.parse(cached) as EmergencyStatus;
    const now = Date.now();
    if (parsed.lastChecked && (now - parsed.lastChecked < EMERGENCY_CHECK_INTERVAL)) {
      logger.debug("Using cached emergency status:", parsed);
      return parsed;
    }
  }

  try {
    // 2. Fetch alert history from our server proxy
    const response = await fetch('/api/emergency-status').catch(() => null);

    if (response && response.ok) {
      const status = await response.json();
      status.lastChecked = Date.now();
      
      // Cache the result
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(status));
      return status;
    }
    
    // Fallback if server is down
    return { active: false, lastChecked: Date.now() };
  } catch (error) {
    logger.error("Error checking emergency status:", error);
    return { active: false, lastChecked: Date.now() };
  }
}
