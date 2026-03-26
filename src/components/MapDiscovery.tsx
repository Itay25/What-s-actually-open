import React, { useEffect, useCallback, useRef } from 'react';
import { useMap } from 'react-leaflet';
import logger from '../utils/logger';
import { discoverPlaces } from '../services/placesService';
import { Place } from '../types';

interface MapDiscoveryProps {
  onDiscovery: (places: Place[]) => void;
  onLoading: (loading: boolean) => void;
  onZoomChange?: (zoom: number) => void;
  activeCategory: string | null;
  refreshTrigger?: number;
  userProfile?: any;
}

const getDistance = (lat1: number, lng1: number, lat2: number, lng2: number) => {
  const R = 6371e3; // meters
  const φ1 = lat1 * Math.PI/180;
  const φ2 = lat2 * Math.PI/180;
  const Δφ = (lat2-lat1) * Math.PI/180;
  const Δλ = (lng2-lng1) * Math.PI/180;
  const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
          Math.cos(φ1) * Math.cos(φ2) *
          Math.sin(Δλ/2) * Math.sin(Δλ/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
};

export function MapDiscovery({ onDiscovery, onLoading, onZoomChange, activeCategory, refreshTrigger = 0, userProfile }: MapDiscoveryProps) {
  const map = useMap();
  const debounceTimer = useRef<NodeJS.Timeout | null>(null);
  const lastQueryLocation = useRef<{lat: number, lng: number} | null>(null);
  const lastZoom = useRef<number>(0);
  const lastCategory = useRef<string | null>(null);
  const lastRefresh = useRef<number>(0);
  const isRequestInProgress = useRef<boolean>(false);
  const dataCache = useRef<Map<string, { places: Place[], loadedAt: number }>>(new Map());
  
  const lastRequestTime = useRef<number>(0);
  
  const handleMove = useCallback(async (force: boolean = false) => {
    const bounds = map.getBounds();
    if (!bounds.isValid()) return;

    const center = map.getCenter();
    const currentLat = center.lat;
    const currentLng = center.lng;
    const currentZoom = map.getZoom();

    if (onZoomChange) onZoomChange(currentZoom);

    const maxZoom = map.getMaxZoom() === Infinity ? 18 : map.getMaxZoom();
    const minFetchZoom = maxZoom - 6; // Relaxed from -3 to -6 to show more places when zoomed out
    const isHighZoom = currentZoom >= minFetchZoom;

    // 1. Zoom level check (Primary condition)
    if (!isHighZoom && !activeCategory) {
      // Still restrict fetching when zoomed out too far UNLESS a category is selected
      return;
    }

    // 2. Movement/Zoom Change detection
    const zoomDiff = Math.abs(currentZoom - lastZoom.current);
    const isZoomingIn = currentZoom > lastZoom.current;
    const zoomChanged = zoomDiff >= 0.5;
    
    const distanceMoved = lastQueryLocation.current 
      ? getDistance(currentLat, currentLng, lastQueryLocation.current.lat, lastQueryLocation.current.lng)
      : Infinity;
    
    // Movement threshold: 300 meters as requested
    const movementThreshold = 300; 
    const movedSignificantly = distanceMoved > movementThreshold;
    const categoryChanged = activeCategory !== lastCategory.current;

    // Only trigger fetch on zoom if zooming IN (to restore density)
    // Zooming OUT should only trigger visual filtering (handled in App.tsx)
    const shouldFetchOnZoom = zoomChanged && isZoomingIn;

    // If nothing changed significantly and not forced, do nothing
    if (!force && lastQueryLocation.current && !categoryChanged && !shouldFetchOnZoom && !movedSignificantly) {
      return;
    }

    // 3. Rate Limit: Max 1 query per 1 second
    const now = Date.now();
    if (!force && now - lastRequestTime.current < 1000) {
      // If we're within the rate limit, schedule another check if we haven't already
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => handleMove(force), 1000 - (now - lastRequestTime.current));
      return;
    }
    
    // Field Explorer reward: expand bounds by 20%
    const hasExplorer = userProfile?.unlockedRewards?.includes('explorer-field');
    const latDiff = bounds.getNorth() - bounds.getSouth();
    const lngDiff = bounds.getEast() - bounds.getWest();
    const expansion = hasExplorer ? 0.2 : 0;

    const north = bounds.getNorth() + (latDiff * expansion);
    const south = bounds.getSouth() - (latDiff * expansion);
    const east = bounds.getEast() + (lngDiff * expansion);
    const west = bounds.getWest() - (lngDiff * expansion);

    // Round bounds for cache key
    const precision = 3; 
    const boundsKey = `${north.toFixed(precision)},${south.toFixed(precision)},${east.toFixed(precision)},${west.toFixed(precision)}`;
    const cacheKey = `${boundsKey}-${activeCategory || 'all'}`;
    
    // Viewport cache expiry: 60 seconds (as requested in previous turn, keeping it)
    const cachedData = dataCache.current.get(cacheKey);
    const isCacheExpired = cachedData ? (Date.now() - cachedData.loadedAt > 60000) : true;

    // 3. Cache check
    // If we have valid cache, use it instead of fetching from server
    // IGNORE cache if zooming in significantly or zoom changed
    if (!force && cachedData && !isCacheExpired && !isZoomingIn) {
      onDiscovery(cachedData.places);
      lastQueryLocation.current = { lat: currentLat, lng: currentLng };
      lastZoom.current = currentZoom;
      lastCategory.current = activeCategory;
      return;
    }

    // 4. Server Fetch
    if (isRequestInProgress.current) return;

    lastQueryLocation.current = { lat: currentLat, lng: currentLng };
    lastZoom.current = currentZoom;
    lastCategory.current = activeCategory;

    lastRequestTime.current = Date.now();
    
    onLoading(true);
    isRequestInProgress.current = true;
    
    try {
      // 2 & 3. Geospatial bounding box query for current viewport
      let discovered = await discoverPlaces({
        north,
        south,
        east,
        west
      }, activeCategory, userProfile?.uid, currentZoom);
      
      // Update cache
      dataCache.current.set(cacheKey, { places: discovered, loadedAt: Date.now() });
      if (dataCache.current.size > 50) {
        const firstKey = dataCache.current.keys().next().value;
        if (firstKey) dataCache.current.delete(firstKey);
      }

      onDiscovery(discovered);
    } catch (error) {
      // Only log critical errors
      if (error instanceof Error && !error.message.includes('Quota exceeded')) {
        logger.error("Discovery failed:", error);
      }
    } finally {
      onLoading(false);
      isRequestInProgress.current = false;
    }
  }, [map, onDiscovery, onLoading, activeCategory, userProfile]);

  const debouncedHandleMove = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(handleMove, 600); // Debounce delay of 600ms (as requested)
  }, [handleMove]);

  useEffect(() => {
    if (refreshTrigger > lastRefresh.current) {
      lastRefresh.current = refreshTrigger;
      handleMove(true);
    }
  }, [refreshTrigger, handleMove]);

  useEffect(() => {
    handleMove(); // Initial discovery or category change
  }, [activeCategory, handleMove]);

  useEffect(() => {
    map.on('moveend', debouncedHandleMove);
    return () => {
      map.off('moveend', debouncedHandleMove);
    };
  }, [map, debouncedHandleMove]);

  return null;
}
