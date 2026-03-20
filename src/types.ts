import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export type Status = 'active' | 'maybe' | 'closed' | 'unknown' | 'closing_soon';

export interface VerificationLayers {
  google: boolean;
  social: boolean;
  users: boolean;
  presence: boolean;
  wolt: boolean;
  easy: boolean;
}

export interface PopularTimesDay {
  day: string;
  hours: number[];
}

export interface TimeRange {
  open: number; // minutes since midnight
  close: number; // minutes since midnight
}

export interface NormalizedOpeningHours {
  Sunday?: TimeRange[];
  Monday?: TimeRange[];
  Tuesday?: TimeRange[];
  Wednesday?: TimeRange[];
  Thursday?: TimeRange[];
  Friday?: TimeRange[];
  Saturday?: TimeRange[];
}

export interface Place {
  id: string;
  place_id?: string;
  name: string;
  lat: number;
  lng: number;
  status?: Status;
  peopleCount: number;
  lastUpdate: string;
  lastUpdateTimestamp: number; // For logic calculations
  category: string;
  confirmations: number;
  officialOpen: boolean;
  address?: string;
  rating?: number;
  userRatingsTotal?: number;
  photo_reference?: string;
  photo_url?: string;
  imageUrl?: string;
  potentialImages?: string[];
  openingHours?: string[] | Record<string, string>;
  normalizedOpeningHours?: NormalizedOpeningHours;
  openingPeriods?: any[];
  confidenceScore?: number;
  verificationLayers?: VerificationLayers;
  socialPulse?: 'active' | 'inactive' | 'closed_signal';
  physicalPresence?: number; // 0 to 1 scale
  woltStatus?: 'open' | 'closed' | 'resting' | 'paused';
  easyStatus?: 'open' | 'closed' | 'maybe';
  isSuspicious?: boolean;
  isLocal?: boolean;
  isFallback?: boolean;
  popularTimes?: PopularTimesDay[];
  reportsOpen?: number;
  reportsClosed?: number;
  lastReportedOpen?: number;
  lastReportedClosed?: number;
  lastReportTime?: number;
  _hasImage?: boolean;
  _hasHours?: boolean;
  userReports?: {
    status: 'open' | 'closed';
    timestamp: number;
    userId: string;
    userPhoto?: string;
  }[];
}

export interface Category {
  id: string;
  label: string;
  icon: string;
}

export interface UserState {
  isReporting: boolean;
  nearbyPlaceId: string | null;
  hasOnboarded: boolean;
}

export interface RewardSettings {
  preciseMarker: boolean;
  reportStatus: boolean;
  photoUpload: boolean;
  newPlace: boolean;
  hoursCorrection: boolean;
}

export interface UserProfile {
  uid: string;
  displayName: string;
  email: string;
  photoURL: string;
  reportsCount: number;
  createdAt: number;
  points?: number;
  contributions?: number;
  unlockedRewards?: string[];
  activeRewards?: string[];
  rewardSettings?: RewardSettings;
}

export interface CommunityReport {
  id: string;
  userId: string;
  latitude: number;
  longitude: number;
  timestamp: number;
  confirmations: number;
  status: 'pending' | 'confirmed';
}

export interface Reward {
  id: string;
  title: string;
  description: string;
  reportsRequired: number;
  icon: string;
  type: 'theme' | 'skin' | 'badge' | 'utility';
}
