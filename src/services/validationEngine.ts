import { Place, Status, VerificationLayers } from '../types';
import { calculateRealOpenStatus } from './statusService';
import { isPlaceIncomplete } from '../utils/placeIncomplete';

export interface ValidationResult {
  business_id: string;
  status: 'GREEN' | 'RED' | 'GRAY' | 'ORANGE' | 'YELLOWGREEN';
  confidence_score: number;
  reasoning_hebrew: string;
  secondary_message?: string;
  layers: VerificationLayers;
  reportCount?: number;
  reporterPhotos?: string[];
  lastUpdateMinutes?: number;
  confidenceLevel?: 'low' | 'medium' | 'high';
  isFaded?: boolean;
}

/**
 * Validation Engine for 'Open?' app.
 * Processes raw data from 4 major layers to output a definitive Confidence Score.
 */
export function validateBusinessStatus(place: Place): ValidationResult {
  const layers: VerificationLayers = {
    google: true,
    social: false,
    users: !!(place.reportsOpen || place.reportsClosed),
    presence: !!place.physicalPresence,
    wolt: place.woltStatus === 'open',
    easy: place.easyStatus === 'open'
  };

  // 1. Check if incomplete (no image AND no hours)
  if (isPlaceIncomplete(place)) {
    return {
      business_id: place.id,
      status: 'GRAY',
      confidence_score: 0,
      reasoning_hebrew: 'סטטוס לא ידוע - אין מידע על שעות פתיחה ואין תמונה',
      layers
    };
  }

  // 2. Use the new probabilistic model
  const result = calculateRealOpenStatus(place);
  const { confidenceScore, uiStatus, uiColor, secondaryMessage } = result;

  // Map statusType to UI status and reasoning
  let status: 'GREEN' | 'RED' | 'GRAY' | 'ORANGE' | 'YELLOWGREEN' = 'GRAY';
  let reasoning = uiStatus;
  let isFaded = false;

  if (uiColor.includes('green')) status = 'GREEN';
  else if (uiColor.includes('yellow')) status = 'YELLOWGREEN';
  else if (uiColor.includes('orange')) status = 'ORANGE';
  else if (uiColor.includes('red')) status = 'RED';

  if (uiColor.includes('/70')) isFaded = true;

  return {
    business_id: place.id,
    status,
    confidence_score: confidenceScore,
    reasoning_hebrew: reasoning,
    secondary_message: secondaryMessage,
    layers,
    reportCount: result.reportCount,
    reporterPhotos: result.reporterPhotos,
    lastUpdateMinutes: result.lastUpdateMinutes,
    confidenceLevel: result.confidenceLevel,
    isFaded
  };
}

export function mapValidationToStatus(vStatus: 'GREEN' | 'RED' | 'GRAY' | 'ORANGE' | 'YELLOWGREEN'): Status {
  switch (vStatus) {
    case 'GREEN': return 'active';
    case 'YELLOWGREEN': return 'closing_soon';
    case 'ORANGE': return 'maybe';
    case 'RED': return 'closed';
    case 'GRAY': return 'unknown';
  }
}
