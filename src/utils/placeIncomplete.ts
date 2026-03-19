import { Place } from '../types';
import { normalizeOpeningHours } from './openingHours';

/**
 * Checks if a place has any valid image URL in various possible fields.
 */
export function hasValidImage(place: Place): boolean {
  const possibleFields = [
    'photoUrl',
    'imageUrl',
    'image',
    'thumbnail',
    'serpapi_thumbnail',
    'photo_url'
  ];

  // 1. Check direct fields
  for (const field of possibleFields) {
    const value = (place as any)[field];
    if (value && typeof value === 'string' && value.trim().length > 0 && value !== 'NO_IMAGE') {
      return true;
    }
  }

  // 2. Check images[0]
  const rawPlace = place as any;
  if (rawPlace.images && Array.isArray(rawPlace.images) && rawPlace.images.length > 0) {
    const firstImage = rawPlace.images[0];
    if (typeof firstImage === 'string' && firstImage.trim().length > 0) return true;
    if (firstImage && typeof firstImage === 'object') {
      const url = firstImage.url || firstImage.link || firstImage.photoUrl || firstImage.imageUrl;
      if (url && typeof url === 'string' && url.trim().length > 0) return true;
    }
  }

  // 3. Check photos[0]
  if (rawPlace.photos && Array.isArray(rawPlace.photos) && rawPlace.photos.length > 0) {
    const firstPhoto = rawPlace.photos[0];
    if (typeof firstPhoto === 'string' && firstPhoto.trim().length > 0) return true;
    if (firstPhoto && typeof firstPhoto === 'object') {
      const url = firstPhoto.url || firstPhoto.link || firstPhoto.photoUrl || firstPhoto.imageUrl;
      if (url && typeof url === 'string' && url.trim().length > 0) return true;
    }
  }

  return false;
}

/**
 * Checks if a place has any valid opening hours information.
 */
export function hasValidOpeningHours(place: Place): boolean {
  // 1. Check normalizedOpeningHours
  if (place.normalizedOpeningHours && Object.keys(place.normalizedOpeningHours).length > 0) {
    return true;
  }

  // 2. Check openingPeriods
  if (place.openingPeriods && place.openingPeriods.length > 0) {
    return true;
  }

  // 3. Check raw openingHours field
  if (place.openingHours) {
    // If it's an array, check if it has content
    if (Array.isArray(place.openingHours) && place.openingHours.length > 0) {
      // Check if any string in the array has valid info
      return place.openingHours.some(h => {
        if (typeof h !== 'string') return false;
        const clean = h.trim().toLowerCase();
        if (clean.length === 0) return false;
        
        // Exclude generic "no info" strings
        const noInfoStrings = ['n/a', 'unknown', 'no hours', 'אין מידע', 'לא ידוע'];
        if (noInfoStrings.some(s => clean.includes(s))) return false;
        
        return true;
      });
    }
    // If it's an object, check if it has keys
    if (typeof place.openingHours === 'object' && Object.keys(place.openingHours).length > 0) {
      return true;
    }
  }

  // 4. Try to normalize and see if it works
  const normalized = normalizeOpeningHours(place.openingHours);
  if (normalized && Object.keys(normalized).length > 0) {
    return true;
  }

  return false;
}

/**
 * A place is incomplete (grey) ONLY if it has NO image AND NO opening hours.
 */
export function isPlaceIncomplete(place: Place): boolean {
  const hasImage = hasValidImage(place);
  const hasHours = hasValidOpeningHours(place);
  
  // Cache the results for potential UI use
  place._hasImage = hasImage;
  place._hasHours = hasHours;
  
  return !hasImage && !hasHours;
}
