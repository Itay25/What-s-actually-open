import { Place } from '../types';
import Fuse from 'fuse.js';

/**
 * Normalizes Hebrew text for better matching.
 * Removes punctuation, extra spaces, and converts to lowercase.
 */
export function normalizeText(text: string): string {
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/[.,\-"']/g, '') // Remove punctuation
    .replace(/\s+/g, ' ')     // Remove extra spaces
    .trim();
}

/**
 * Smart local search with ranking.
 */
export function localSearch(query: string, places: Place[]): Place[] {
  const normalizedQuery = normalizeText(query);
  if (!normalizedQuery) return [];

  const queryWords = normalizedQuery.split(' ');

  // 1. Exact/Prefix/Includes matching with ranking
  const matchedPlaces = places.map(place => {
    const normalizedName = normalizeText(place.name);
    const normalizedCity = normalizeText(place.city || '');
    const normalizedAddress = normalizeText(place.address || '');
    const combinedText = `${normalizedName} ${normalizedCity} ${normalizedAddress}`.trim();

    let score = 0;

    // Exact match on name
    if (normalizedName === normalizedQuery) {
      score += 100;
    } 
    // Starts with query
    else if (normalizedName.startsWith(normalizedQuery)) {
      score += 80;
    }
    // Includes query
    else if (normalizedName.includes(normalizedQuery)) {
      score += 60;
    }

    // Word-based matching for combined queries (e.g. "Super Pharm Kfar Saba")
    const allWordsMatch = queryWords.every(word => 
      normalizedName.includes(word) || 
      normalizedCity.includes(word) ||
      normalizedAddress.includes(word)
    );
    if (allWordsMatch) {
      score += 40;
    }

    // City/Address match bonus
    if ((normalizedCity && normalizedQuery.includes(normalizedCity)) ||
        (normalizedAddress && normalizedQuery.includes(normalizedAddress))) {
      score += 20;
    }

    return { place, score };
  })
  .filter(item => item.score > 0)
  .sort((a, b) => b.score - a.score)
  .map(item => item.place);

  // 2. Fuzzy search fallback if no direct matches or to supplement
  if (matchedPlaces.length < 5) {
    const fuse = new Fuse(places, {
      keys: ['name', 'city', 'address'],
      threshold: 0.4,
      distance: 100,
      ignoreLocation: true,
      minMatchCharLength: 2
    });

    const fuzzyResults = fuse.search(query)
      .map(result => result.item)
      .filter(item => !matchedPlaces.some(p => p.id === item.id));

    return [...matchedPlaces, ...fuzzyResults].slice(0, 10);
  }

  return matchedPlaces.slice(0, 10);
}
