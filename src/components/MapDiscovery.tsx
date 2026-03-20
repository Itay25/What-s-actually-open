import React, { useEffect, useCallback, useRef } from 'react';
import { useMap } from 'react-leaflet';
import logger from '../utils/logger';
import { discoverPlaces } from '../services/placesService';
import { Place } from '../types';

interface MapDiscoveryProps {
  onDiscovery: (places: Place[]) => void;
  onLoading: (loading: boolean) => void;
  onZoomChange: (zoom: number) => void;
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
  
  const handleMove = useCallback(async (force: boolean = false) => {
    const bounds = map.getBounds();
    if (!bounds.isValid()) return;

    const center = map.getCenter();
    const currentLat = center.lat;
    const currentLng = center.lng;
    const currentZoom = map.getZoom();

    const maxZoom = map.getMaxZoom() === Infinity ? 18 : map.getMaxZoom();
    const minFetchZoom = maxZoom - 6; // Relaxed from -3 to -6 to show more places when zoomed out
    const isHighZoom = currentZoom >= minFetchZoom;

    // 1. Zoom level check (Primary condition)
    if (!isHighZoom && !activeCategory) {
      // Still restrict fetching when zoomed out too far UNLESS a category is selected
      return;
    }

    // 2. Movement/Zoom Change detection
    const zoomChanged = currentZoom !== lastZoom.current;
    
    const distanceMoved = lastQueryLocation.current 
      ? getDistance(currentLat, currentLng, lastQueryLocation.current.lat, lastQueryLocation.current.lng)
      : Infinity;
    
    // Relaxed movement threshold for high zoom: 100 meters (was 300)
    const movementThreshold = 100; 
    const movedSignificantly = distanceMoved > movementThreshold;
    const categoryChanged = activeCategory !== lastCategory.current;

    // If nothing changed significantly and not forced, do nothing
    if (!force && lastQueryLocation.current && !categoryChanged && !zoomChanged && !movedSignificantly) {
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
    
    // Viewport cache expiry: 300 seconds (5 minutes)
    const cachedData = dataCache.current.get(cacheKey);
    const isCacheExpired = cachedData ? (Date.now() - cachedData.loadedAt > 300000) : true;

    // 3. Cache check
    // If we have valid cache, use it instead of fetching from server
    if (!force && cachedData && !isCacheExpired) {
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

    onZoomChange(currentZoom);
    
    onLoading(true);
    isRequestInProgress.current = true;
    
    try {
      // 2 & 3. Geospatial bounding box query for current viewport
      let discovered = await discoverPlaces({
        north,
        south,
        east,
        west
      }, activeCategory, userProfile?.uid);
      
      // Update cache
      dataCache.current.set(cacheKey, { places: discovered, loadedAt: Date.now() });
      if (dataCache.current.size > 50) {
        const firstKey = dataCache.current.keys().next().value;
        if (firstKey) dataCache.current.delete(firstKey);
      }

      onDiscovery(discovered);
    } catch (error) {
      logger.error("Discovery failed:", error);
    } finally {
      onLoading(false);
      isRequestInProgress.current = false;
    }
  }, [map, onDiscovery, onLoading, onZoomChange, activeCategory, userProfile]);

  const debouncedHandleMove = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(handleMove, 300); // Debounce delay of 300ms
  }, [handleMove]);

  const debouncedHandleZoom = useCallback(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      onZoomChange(map.getZoom());
    }, 300);
  }, [map, onZoomChange]);

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
    onZoomChange(map.getZoom());
  }, []);

  useEffect(() => {
    map.on('moveend', debouncedHandleMove);
    map.on('zoomend', debouncedHandleZoom);
    return () => {
      map.off('moveend', debouncedHandleMove);
      map.off('zoomend', debouncedHandleZoom);
    };
  }, [map, debouncedHandleMove, debouncedHandleZoom]);

  return null;
}
