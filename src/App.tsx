import React, { useState, useEffect, useCallback, useRef } from 'react';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import L from 'leaflet';
import { Place, Status } from './types';
import { MOCK_PLACES, CATEGORIES } from './constants';
import { motion, AnimatePresence } from 'motion/react';
import { 
  MapPin, Users, Clock, ShieldAlert, Navigation, 
  CheckCircle2, XCircle, HelpCircle, 
  ShoppingCart, Store, Coffee, Utensils, PlusSquare, Fuel, Pill,
  Search,
  ThumbsUp,
  Bike,
  Globe,
  Croissant,
  ShoppingBag,
  Building2,
  CreditCard,
  Ticket,
  ChevronDown,
  LogOut,
  User as UserIcon,
  Trophy,
  Star,
  Sliders,
  Beer,
  MoreHorizontal,
  Lock
} from 'lucide-react';
import { cn, UserProfile, Reward, CommunityReport, TimeRange } from './types';
import { validateBusinessStatus, mapValidationToStatus } from './services/validationEngine';
import { isPlaceIncomplete } from './utils/placeIncomplete';
import { Search as SearchComponent } from './components/Search';
import logger from './utils/logger';
import { discoverPlaces, searchPlaces, getPlaceById } from './services/placesService';
import { BusinessMarker } from './components/BusinessMarker';
import { MapDiscovery } from './components/MapDiscovery';
import { RewardActionButton } from './components/RewardActionButton';
import { checkEmergencyStatus } from './services/emergencyService';
import { auth, googleProvider, db } from './firebase';
import { signInWithPopup, onAuthStateChanged, signOut, User } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, increment, arrayUnion, collection, addDoc, query, where, getDocs, limit, orderBy } from 'firebase/firestore';

const REWARDS: Reward[] = [
  { id: 'reporter-advanced', title: 'מדווח מתקדם', description: 'מיקום הסמן הופך למדויק יותר', reportsRequired: 25, icon: '🛰', type: 'utility' },
  { id: 'theme-dark', title: 'ערכת נושא כהה', description: 'אפשרות להחליף לעיצוב כהה למפה', reportsRequired: 50, icon: '🌙', type: 'theme' },
  { id: 'skin-silver', title: 'סמן כסף', description: 'סמן המשתמש שלך הופך לכסף', reportsRequired: 100, icon: '🥈', type: 'skin' },
  { id: 'badge-super', title: 'תג תורם על', description: 'תג מיוחד ליד שם המשתמש', reportsRequired: 200, icon: '🏆', type: 'badge' },
  { id: 'badge-veteran', title: 'ותיק', description: 'תג מיוחד ליד שם המשתמש', reportsRequired: 300, icon: '👑', type: 'badge' },
];

// Icon mapping based on category
const getCategoryIcon = (category: string) => {
  if (category.includes('סופר') || category.includes('מכולת')) return <ShoppingCart size={18} strokeWidth={2.5} />;
  if (category.includes('קפה')) return <Coffee size={18} strokeWidth={2.5} />;
  if (category.includes('מסעד')) return <Utensils size={18} strokeWidth={2.5} />;
  if (category.includes('מרקחת')) return <Pill size={18} strokeWidth={2.5} />;
  if (category.includes('דלק')) return <Fuel size={18} strokeWidth={2.5} />;
  if (category.includes('מאפ')) return <Croissant size={18} strokeWidth={2.5} />;
  if (category.includes('קיוסק')) return <Store size={18} strokeWidth={2.5} />;
  if (category.includes('בנק')) return <Building2 size={18} strokeWidth={2.5} />;
  if (category.includes('כספומט')) return <CreditCard size={18} strokeWidth={2.5} />;
  if (category.includes('אטרקציות')) return <Ticket size={18} strokeWidth={2.5} />;
  if (category.includes('לילה') || category.includes('בר')) return <Beer size={18} strokeWidth={2.5} />;
  if (category.includes('פעיל')) return <Bike size={18} strokeWidth={2.5} />;
  if (category.includes('אחר')) return <MoreHorizontal size={18} strokeWidth={2.5} />;
  return <MapPin size={18} strokeWidth={2.5} />;
};

function ChangeView({ center }: { center: [number, number] }) {
  const map = useMap();
  useEffect(() => {
    map.setView(center, 15);
  }, [center, map]);
  return null;
}

function MapEvents({ onMapClick }: { onMapClick: () => void }) {
  useMapEvents({
    click: () => {
      onMapClick();
    },
    dragstart: () => {
      onMapClick();
    }
  });
  return null;
}

function getDistance(lat1: number, lng1: number, lat2: number, lng2: number) {
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
}

const PLACEHOLDERS: Record<string, { icon: React.ReactNode, title: string, caption: string, color: string }> = {
  'כספומטים': {
    icon: <CreditCard size={48} strokeWidth={1.5} />,
    title: "No photo for this ATM yet",
    caption: "But at least it still gives cash.",
    color: "bg-blue-50 text-blue-500"
  },
  'מסעדות': {
    icon: <Utensils size={48} strokeWidth={1.5} />,
    title: "This place has no photo yet",
    caption: "Maybe the food is camera shy.",
    color: "bg-orange-50 text-orange-500"
  },
  'בתי קפה': {
    icon: <Coffee size={48} strokeWidth={1.5} />,
    title: "No photo yet",
    caption: "Imagine a good cup of coffee here.",
    color: "bg-amber-50 text-amber-700"
  },
  'סופרים': {
    icon: <ShoppingCart size={48} strokeWidth={1.5} />,
    title: "No photo yet",
    caption: "But groceries are probably inside.",
    color: "bg-green-50 text-green-600"
  },
  'מכולות': {
    icon: <ShoppingCart size={48} strokeWidth={1.5} />,
    title: "No photo yet",
    caption: "But groceries are probably inside.",
    color: "bg-green-50 text-green-600"
  },
  'בתי מרקחת': {
    icon: <Pill size={48} strokeWidth={1.5} />,
    title: "No photo yet",
    caption: "But hopefully they have what you need.",
    color: "bg-red-50 text-red-500"
  },
  'תחנות דלק': {
    icon: <Fuel size={48} strokeWidth={1.5} />,
    title: "No photo yet",
    caption: "Fueling your imagination for now.",
    color: "bg-slate-50 text-slate-600"
  },
  'מאפיות': {
    icon: <Croissant size={48} strokeWidth={1.5} />,
    title: "No photo yet",
    caption: "Can you smell the imaginary bread?",
    color: "bg-yellow-50 text-yellow-700"
  },
  'קיוסק': {
    icon: <Store size={48} strokeWidth={1.5} />,
    title: "No photo yet",
    caption: "A small place with big potential.",
    color: "bg-purple-50 text-purple-600"
  },
  'בנק': {
    icon: <Building2 size={48} strokeWidth={1.5} />,
    title: "No photo yet",
    caption: "Your money is safe, even if the photo isn't here.",
    color: "bg-indigo-50 text-indigo-600"
  },
  'אטרקציות': {
    icon: <Ticket size={48} strokeWidth={1.5} />,
    title: "No photo yet",
    caption: "The fun is waiting for you inside.",
    color: "bg-pink-50 text-pink-500"
  }
};

const DEFAULT_PLACEHOLDER = {
  icon: <MapPin size={48} strokeWidth={1.5} />,
  title: "No photo yet",
  caption: "A mysterious place indeed.",
  color: "bg-gray-50 text-gray-400"
};

const PlacePlaceholder = React.memo(({ category }: { category: string }) => {
  let placeholder = DEFAULT_PLACEHOLDER;
  
  if (category.includes('כספומט')) placeholder = PLACEHOLDERS['כספומטים'];
  else if (category.includes('מסעד')) placeholder = PLACEHOLDERS['מסעדות'];
  else if (category.includes('קפה')) placeholder = PLACEHOLDERS['בתי קפה'];
  else if (category.includes('סופר') || category.includes('מכולת')) placeholder = PLACEHOLDERS['סופרים'];
  else if (category.includes('מרקחת')) placeholder = PLACEHOLDERS['בתי מרקחת'];
  else if (category.includes('דלק')) placeholder = PLACEHOLDERS['תחנות דלק'];
  else if (category.includes('מאפ')) placeholder = PLACEHOLDERS['מאפיות'];
  else if (category.includes('קיוסק')) placeholder = PLACEHOLDERS['קיוסק'];
  else if (category.includes('בנק')) placeholder = PLACEHOLDERS['בנק'];
  else if (category.includes('אטרקציות')) placeholder = PLACEHOLDERS['אטרקציות'];
  
  return (
    <div className="flex flex-col items-center justify-center gap-4 text-center p-8 w-full h-full">
      <motion.div 
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className={cn("w-20 h-20 rounded-3xl flex items-center justify-center mb-2 shadow-sm", placeholder.color)}
      >
        {placeholder.icon}
      </motion.div>
      <div className="flex flex-col gap-1.5">
        <span className="text-base font-bold text-black/80">{placeholder.title}</span>
        <span className="text-xs font-medium text-black/40 max-w-[200px] leading-relaxed italic">"{placeholder.caption}"</span>
      </div>
    </div>
  );
});

export default function App() {
  const isValidLatLng = (lat: any, lng: any) => {
    return typeof lat === 'number' && typeof lng === 'number' && !isNaN(lat) && !isNaN(lng);
  };

  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const [userLocation, setUserLocation] = useState<[number, number]>([32.0853, 34.7818]);
  const [isLoadingLocation, setIsLoadingLocation] = useState(true);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [discoveredPlaces, setDiscoveredPlaces] = useState<Place[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isFilterOpen, setIsFilterOpen] = useState(false);
  const [mapZoom, setMapZoom] = useState(15);
  const [tempVisiblePlaceId, setTempVisiblePlaceId] = useState<string | null>(null);
  const [showFullHours, setShowFullHours] = useState(false);
  const mapRef = React.useRef<L.Map | null>(null);
  const pendingSearchPlaceId = React.useRef<string | null>(null);

  // We keep track of places that should be visible to handle exit animations
  const [visiblePlaces, setVisiblePlaces] = useState<Place[]>([]);

  const [pinnedPlaces, setPinnedPlaces] = useState<Place[]>([]);

  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [userReportsTimestamps, setUserReportsTimestamps] = useState<Record<string, number>>(() => {
    const saved = localStorage.getItem('user_reports_timestamps');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        return {};
      }
    }
    return {};
  });

  useEffect(() => {
    localStorage.setItem('user_reports_timestamps', JSON.stringify(userReportsTimestamps));
  }, [userReportsTimestamps]);

  const [showRewards, setShowRewards] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showLocationOnboarding, setShowLocationOnboarding] = useState(false);
  const [locationPermissionDenied, setLocationPermissionDenied] = useState(false);
  const [showNavigationDialog, setShowNavigationDialog] = useState(false);
  const [wazeIconError, setWazeIconError] = useState(false);
  const [googleMapsIconError, setGoogleMapsIconError] = useState(false);
  const [imageIndex, setImageIndex] = useState(0);
  const [imageError, setImageError] = useState(false);
  const placeDetailsRef = React.useRef<HTMLDivElement>(null);
  const filterRef = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (window.innerWidth < 768 && isFilterOpen && filterRef.current && !filterRef.current.contains(event.target as Node)) {
        setIsFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isFilterOpen]);

  useEffect(() => {
    if (selectedPlace && placeDetailsRef.current) {
      placeDetailsRef.current.scrollTo(0, 0);
    }
  }, [selectedPlace?.id]);

  useEffect(() => {
    setImageIndex(0);
    setImageError(false);
  }, [selectedPlace?.id]);
  useEffect(() => {
    if (showNavigationDialog) {
      setWazeIconError(false);
      setGoogleMapsIconError(false);
    }
  }, [showNavigationDialog]);

  const [emergencyData, setEmergencyData] = useState<{ active: boolean; operationName?: string }>({ active: false });
  const [currentTime, setCurrentTime] = useState(Date.now());

  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStartY = useRef(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY;
    setIsDragging(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!isDragging) return;
    const deltaY = e.touches[0].clientY - touchStartY.current;
    setDragY(Math.max(0, deltaY));
  };

  const handleTouchEnd = () => {
    if (dragY > 100) {
      setSelectedPlace(null);
    }
    setDragY(0);
    setIsDragging(false);
  };

  useEffect(() => {
    if (!selectedPlace) {
      setDragY(0);
      setIsDragging(false);
    }
  }, [selectedPlace]);

  useEffect(() => {
    const timer = setInterval(() => {
      setCurrentTime(Date.now());
    }, 60000); // Update every minute
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let isMounted = true;
    const timeout = setTimeout(() => {
      if (isMounted) {
        setIsLoadingLocation(false);
      }
    }, 2000);

    if ("geolocation" in navigator) {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          if (!isMounted) return;
          clearTimeout(timeout);
          const { latitude, longitude } = pos.coords;
          if (isValidLatLng(latitude, longitude)) {
            setUserLocation([latitude, longitude]);
          }
          setIsLoadingLocation(false);
        },
        (err) => {
          if (!isMounted) return;
          clearTimeout(timeout);
          setIsLoadingLocation(false);
          logger.error("Initial location error:", err);
        },
        { timeout: 2000, enableHighAccuracy: true }
      );
    } else {
      clearTimeout(timeout);
      setIsLoadingLocation(false);
    }

    return () => {
      isMounted = false;
      clearTimeout(timeout);
    };
  }, []);

  // Reset image error when selected place changes
  useEffect(() => {
    setImageError(false);
  }, [selectedPlace]);

  // Emergency API Polling
  useEffect(() => {
    const checkEmergency = async () => {
      const status = await checkEmergencyStatus();
      setEmergencyData(status);
    };

    checkEmergency();
    const interval = setInterval(checkEmergency, 86400000); // Once a day
    return () => clearInterval(interval);
  }, []);

  // Location request helper
  const requestLocation = useCallback(() => {
    if (isValidLatLng(userLocation[0], userLocation[1])) {
      setRefreshTrigger(prev => prev + 1);
      if (mapRef.current) {
        mapRef.current.flyTo(userLocation, 17, {
          duration: 2,
          easeLinearity: 0.25
        });
      }
    } else if ("geolocation" in navigator) {
      // Fallback if userLocation is somehow invalid
      navigator.geolocation.getCurrentPosition((pos) => {
        const { latitude, longitude } = pos.coords;
        if (isValidLatLng(latitude, longitude)) {
          const newLoc: [number, number] = [latitude, longitude];
          setUserLocation(newLoc);
          setRefreshTrigger(prev => prev + 1);
          if (mapRef.current) {
            mapRef.current.flyTo(newLoc, 17, {
              duration: 2,
              easeLinearity: 0.25
            });
          }
        }
      }, (err) => {
        logger.error("Location error:", err);
      });
    }
  }, [userLocation]);

  // Live Tracking
  const lastMarkerLocation = useRef<[number, number] | null>(null);
  useEffect(() => {
    let watchId: number | null = null;

    if ("geolocation" in navigator) {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          if (isValidLatLng(latitude, longitude)) {
            const newLoc: [number, number] = [latitude, longitude];
            
            // Performance: Update marker only if movement > 10m
            if (lastMarkerLocation.current) {
              const distance = getDistance(
                lastMarkerLocation.current[0], 
                lastMarkerLocation.current[1], 
                latitude, 
                longitude
              );
              if (distance > 10) {
                setUserLocation(newLoc);
                lastMarkerLocation.current = newLoc;
              }
            } else {
              setUserLocation(newLoc);
              lastMarkerLocation.current = newLoc;
            }
          }
        },
        (err) => {
          logger.error("Watch position error:", err);
        },
        { enableHighAccuracy: true, maximumAge: 10000, timeout: 5000 }
      );
    }

    return () => {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
      }
    };
  }, []);

  // Check for onboarding
  useEffect(() => {
    const onboardingDone = localStorage.getItem('location_onboarding_done');
    if (!onboardingDone) {
      setShowLocationOnboarding(true);
    }
  }, []);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);
      if (firebaseUser) {
        const userDocRef = doc(db, 'users', firebaseUser.uid);
        const userDoc = await getDoc(userDocRef);
        if (userDoc.exists()) {
          const data = userDoc.data();
          // Sanitize createdAt if it's a Timestamp
          if (data.createdAt && typeof data.createdAt === 'object' && 'seconds' in data.createdAt) {
            data.createdAt = data.createdAt.seconds * 1000;
          }
          setUserProfile(data as UserProfile);
        } else {
          const newProfile: UserProfile = {
            uid: firebaseUser.uid,
            displayName: firebaseUser.displayName || 'משתמש',
            email: firebaseUser.email || '',
            photoURL: firebaseUser.photoURL || '',
            reportsCount: 0,
            createdAt: Date.now(),
            points: 0,
            contributions: 0,
            unlockedRewards: [],
            activeRewards: []
          };
          await setDoc(userDocRef, newProfile);
          setUserProfile(newProfile);
        }
      } else {
        setUserProfile(null);
      }
    });
    return () => unsubscribe();
  }, []);

  const handleLogin = useCallback(async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      logger.error("Login failed:", error);
    }
  }, []);

  const performLogout = useCallback(async () => {
    try {
      await signOut(auth);
      setShowLogoutConfirm(false);
    } catch (error) {
      logger.error("Logout failed:", error);
    }
  }, []);

  const handleLogout = useCallback(() => {
    setShowLogoutConfirm(true);
  }, []);

  const handleDiscovery = useCallback((newPlaces: Place[]) => {
    setDiscoveredPlaces(prev => {
      const combined = [...prev, ...newPlaces];
      // Deduplicate by ID
      const unique = combined.filter((v, i, a) => a.findIndex(t => t.id === v.id) === i);
      return unique;
    });
  }, []);

  const handleSearchSelect = useCallback(async (place: Place) => {
    if (window.innerWidth < 768) {
      setIsFilterOpen(false);
    }
    
    // Set this as the pending selection from search
    pendingSearchPlaceId.current = place.id;

    // Add to pinned places to keep it visible regardless of filter
    setPinnedPlaces(prev => {
      if (prev.find(p => p.id === place.id)) return prev;
      return [...prev, place];
    });

    if (mapRef.current) {
      // First, animate smoothly
      mapRef.current.flyTo([place.lat, place.lng], 17, {
        duration: 2, // Slower for better context
        easeLinearity: 0.25
      });

      // Wait for animation to finish before opening info sheet
      const onMoveEnd = () => {
        // Only open if this is still the pending selection
        if (pendingSearchPlaceId.current === place.id) {
          setSelectedPlace(place);
          setImageError(false); // Reset image error
        }
        mapRef.current?.off('moveend', onMoveEnd);
      };
      mapRef.current.on('moveend', onMoveEnd);
    }
    
    // Ensure the place is in our discovered list so it renders
    setDiscoveredPlaces(prev => {
      if (prev.find(p => p.id === place.id)) return prev;
      return [...prev, place];
    });

    // Always fetch the latest version of that place from the database
    try {
      const latestPlace = await getPlaceById(place.id);
      // Only update if this is still the pending selection
      if (latestPlace && pendingSearchPlaceId.current === place.id) {
        setSelectedPlace(latestPlace);
        // Update in discoveredPlaces and pinnedPlaces
        setDiscoveredPlaces(prev => prev.map(p => p.id === latestPlace.id ? latestPlace : p));
        setPinnedPlaces(prev => prev.map(p => p.id === latestPlace.id ? latestPlace : p));
      }
    } catch (error) {
      logger.error("Failed to refresh place details after search:", error);
    }
  }, []);

  // Map initialization and script loading logs
  useEffect(() => {
    // In this Leaflet-based app, we don't load the full JS API script, 
    // but we log this to track Places API usage which uses the same key.
  }, []);

  const handlePlaceClick = useCallback(async (place: Place) => {
    if (window.innerWidth < 768) {
      setIsFilterOpen(false);
    }
    
    // Set this as the pending selection to prevent re-opening if closed
    pendingSearchPlaceId.current = place.id;

    setSelectedPlace(place);
    setImageError(false); // Reset image error to retry loading if it was missing

    // Always fetch the latest version of that place from the database
    try {
      const latestPlace = await getPlaceById(place.id);
      // Only update if this is still the pending selection
      if (latestPlace && pendingSearchPlaceId.current === place.id) {
        setSelectedPlace(latestPlace);
        // Update in discoveredPlaces to keep data consistent
        setDiscoveredPlaces(prev => prev.map(p => p.id === latestPlace.id ? latestPlace : p));
      }
    } catch (error) {
      logger.error("Failed to refresh place details:", error);
    }
  }, []);

  const [reportSuccess, setReportSuccess] = useState(false);
  const [isReportingStatus, setIsReportingStatus] = useState(false);
  const [reportMessage, setReportMessage] = useState('');
  const [impactMessage, setImpactMessage] = useState<string | null>(null);
  const [showImpactToast, setShowImpactToast] = useState(false);

  const [errorToast, setErrorToast] = useState<string | null>(null);
  const [showTooFarTooltip, setShowTooFarTooltip] = useState(false);
  const tooltipTimerRef = React.useRef<NodeJS.Timeout | null>(null);

  const triggerTooFarTooltip = useCallback(() => {
    if (tooltipTimerRef.current) clearTimeout(tooltipTimerRef.current);
    setShowTooFarTooltip(true);
    tooltipTimerRef.current = setTimeout(() => setShowTooFarTooltip(false), 2000);
  }, []);

  const isPromptShown = useCallback((placeId: string) => {
    return !!sessionStorage.getItem(`reportedPromptShown_${placeId}`);
  }, []);

  const markPromptAsShown = useCallback((placeId: string) => {
    sessionStorage.setItem(`reportedPromptShown_${placeId}`, 'true');
  }, []);

  const [hasReportedThisSession, setHasReportedThisSession] = useState(false);
  const [showExitReminder, setShowExitReminder] = useState(false);
  const [lastViewedPlace, setLastViewedPlace] = useState<Place | null>(null);
  const [lastNavigatedPlace, setLastNavigatedPlace] = useState<{ id: string, name: string, time: number, lat: number, lng: number } | null>(null);
  const [showNavPrompt, setShowNavPrompt] = useState(false);

  useEffect(() => {
    if (selectedPlace) {
      setTempVisiblePlaceId(selectedPlace.id);
    } else if (tempVisiblePlaceId) {
      // Keep it visible for 5 seconds after selection is cleared
      const timer = setTimeout(() => {
        setTempVisiblePlaceId(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [selectedPlace?.id, tempVisiblePlaceId]);

  useEffect(() => {
    if (selectedPlace) {
      setHasReportedThisSession(false);
      setLastViewedPlace(selectedPlace);
    } else if (lastViewedPlace && !hasReportedThisSession && !isPromptShown(lastViewedPlace.id)) {
      // User closed the sheet without reporting
      const distance = getDistance(userLocation[0], userLocation[1], lastViewedPlace.lat, lastViewedPlace.lng);
      if (distance <= 50) {
        setShowExitReminder(true);
        markPromptAsShown(lastViewedPlace.id);
        // Auto-hide after 10 seconds
        const timer = setTimeout(() => setShowExitReminder(false), 10000);
        return () => clearTimeout(timer);
      }
    }
  }, [selectedPlace, lastViewedPlace, hasReportedThisSession, userLocation, isPromptShown, markPromptAsShown]);

  // Handle returning from navigation
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && lastNavigatedPlace && !isPromptShown(lastNavigatedPlace.id)) {
        const now = Date.now();
        const thirtyMinutes = 30 * 60 * 1000;
        if (now - lastNavigatedPlace.time < thirtyMinutes) {
          const distance = getDistance(userLocation[0], userLocation[1], lastNavigatedPlace.lat, lastNavigatedPlace.lng);
          if (distance <= 50) {
            setShowNavPrompt(true);
            markPromptAsShown(lastNavigatedPlace.id);
          }
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [lastNavigatedPlace, userLocation, isPromptShown, markPromptAsShown]);

  const handleReport = useCallback(async (status: 'open' | 'closed', placeToReport: Place | null = selectedPlace) => {
    if (!placeToReport || !user) return;
    
    // Proximity check
    const distance = getDistance(userLocation[0], userLocation[1], placeToReport.lat, placeToReport.lng);
    const maxDistance = 50;
    const isAdmin = user?.email === 'itay8090100@gmail.com';
    
    if (!isAdmin && distance > maxDistance) {
      setErrorToast("עליך להיות במרחק של עד 50 מטרים מהמקום כדי לדווח");
      setTimeout(() => setErrorToast(null), 3000);
      return;
    }

    const lastReportTime = userReportsTimestamps[placeToReport.id] || 0;
    const now = Date.now();
    const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

    if (now - lastReportTime < COOLDOWN_MS) {
      const minutesLeft = Math.ceil((COOLDOWN_MS - (now - lastReportTime)) / 60000);
      alert(`כבר דיווחת על מקום זה לאחרונה. תוכל לדווח שוב בעוד ${minutesLeft} דקות.`);
      return;
    }

    setIsReportingStatus(true);
    setReportMessage("שולח דיווח...");

    try {
      // Calculate impact message
      const currentReports = placeToReport.userReports || [];
      const validReports = currentReports.filter(r => {
        const ts = typeof r.timestamp === 'number' ? r.timestamp : 0;
        return (Date.now() - ts) / (1000 * 60) <= 120;
      });
      const sameStatusReports = validReports.filter(r => r.status === status);
      
      let impact = "תודה על הדיווח!";
      if (sameStatusReports.length === 0) {
        impact = "התחלת תהליך אימות עבור מקום זה";
      } else if (sameStatusReports.length === 1) {
        impact = "עזרת לאמת שהמקום " + (status === 'open' ? 'פתוח' : 'סגור');
      } else {
        impact = "עזרת לשפר את אמינות המידע עבור מקום זה";
      }
      setImpactMessage(impact);

      // 1. Create report in Firestore
      await addDoc(collection(db, 'reports'), {
        userId: user.uid,
        placeId: placeToReport.id,
        placeName: placeToReport.name,
        latitude: placeToReport.lat,
        longitude: placeToReport.lng,
        status,
        timestamp: Date.now()
      });

      // 2. Update place stats in Firestore (ONLY if it meets business criteria)
      const hasPhoto = placeToReport.imageUrl && placeToReport.imageUrl !== 'NO_IMAGE';
      const hasOpeningHours = placeToReport.openingHours && Array.isArray(placeToReport.openingHours) && placeToReport.openingHours.length > 0;
      const isBusiness = !!(placeToReport.name && placeToReport.lat && (hasPhoto || hasOpeningHours));

      if (isBusiness) {
        const placeRef = doc(db, 'places', placeToReport.id);
        const reportEntry = {
          status,
          timestamp: Date.now(),
          userId: user.uid,
          userPhoto: user.photoURL || undefined
        };
        
        try {
          await updateDoc(placeRef, {
            [status === 'open' ? 'reportsOpen' : 'reportsClosed']: increment(1),
            [status === 'open' ? 'lastReportedOpen' : 'lastReportedClosed']: Date.now(),
            lastReportTime: Date.now(),
            userReports: arrayUnion(reportEntry)
          });
        } catch (e) {
          // If update fails, it might be a new business that wasn't in DB yet
          // But we only reach here if isBusiness is true
          logger.debug("Place update failed, skipping aggregated stats update");
        }
      }

      // 3. Update user stats
      const newReportsCount = (userProfile?.reportsCount || 0) + 1;
      const newlyUnlocked = REWARDS
        .filter(r => newReportsCount >= r.reportsRequired && !userProfile?.unlockedRewards.includes(r.id))
        .map(r => r.id);

      await updateDoc(doc(db, 'users', user.uid), {
        reportsCount: increment(1),
        contributions: increment(1),
        unlockedRewards: arrayUnion(...newlyUnlocked)
      });

      // Update local profile state
      if (userProfile) {
        setUserProfile({
          ...userProfile,
          reportsCount: newReportsCount,
          contributions: (userProfile.contributions || 0) + 1,
          unlockedRewards: [...(userProfile.unlockedRewards || []), ...newlyUnlocked]
        });
      }

      setUserReportsTimestamps(prev => ({
        ...prev,
        [placeToReport.id]: Date.now()
      }));
      
      markPromptAsShown(placeToReport.id);
      
      setReportSuccess(true);
      setShowImpactToast(true);
      setHasReportedThisSession(true);
      setShowExitReminder(false);
      setShowNavPrompt(false);
      setIsReportingStatus(false);
      setShowReportOptions(false);
      setTimeout(() => {
        setReportSuccess(false);
        setShowImpactToast(false);
      }, 4000);
      
      // Update the place locally
      const updatePlace = (p: Place) => {
        if (p.id === placeToReport.id) {
          const newReports = [...(p.userReports || []), { 
            status, 
            timestamp: Date.now(), 
            userId: user.uid,
            userPhoto: user.photoURL || undefined
          }];
          return { 
            ...p, 
            userReports: newReports,
            reportsOpen: (p.reportsOpen || 0) + (status === 'open' ? 1 : 0),
            reportsClosed: (p.reportsClosed || 0) + (status === 'closed' ? 1 : 0),
            lastReportedOpen: status === 'open' ? Date.now() : p.lastReportedOpen,
            lastReportedClosed: status === 'closed' ? Date.now() : p.lastReportedClosed,
            lastReportTime: Date.now()
          };
        }
        return p;
      };

      setDiscoveredPlaces(prev => prev.map(updatePlace));
      setPinnedPlaces(prev => prev.map(updatePlace));
      
      if (selectedPlace?.id === placeToReport.id) {
        setSelectedPlace(prev => prev ? updatePlace(prev) : null);
      }

    } catch (e) {
      logger.error("Failed to submit report", e);
      setIsReportingStatus(false);
      alert('חלה שגיאה בשליחת הדיווח. נסה שוב מאוחר יותר.');
    }
  }, [user, userLocation, userProfile, userReportsTimestamps, selectedPlace, markPromptAsShown]);

  const toggleReward = async (rewardId: string) => {
    if (!user || !userProfile) return;
    
    const currentActive = userProfile.activeRewards || [];
    const isCurrentlyActive = currentActive.includes(rewardId);
    
    let newActive: string[];
    if (isCurrentlyActive) {
      newActive = currentActive.filter(id => id !== rewardId);
    } else {
      newActive = [...currentActive, rewardId];
    }
    
    try {
      await updateDoc(doc(db, 'users', user.uid), {
        activeRewards: newActive
      });
      
      setUserProfile({
        ...userProfile,
        activeRewards: newActive
      });
    } catch (e) {
      logger.error("Failed to toggle reward", e);
    }
  };

  const [showReportOptions, setShowReportOptions] = useState(false);

  const validatedPlaces = React.useMemo(() => {
    // Combine discovered, pinned, and selected places for validation
    const allPlaces = [...discoveredPlaces];
    
    // Ensure selected place is always included
    if (selectedPlace && !allPlaces.find(p => p.id === selectedPlace.id)) {
      allPlaces.push(selectedPlace);
    }
    
    // Ensure pinned places are always included
    pinnedPlaces.forEach(p => {
      if (!allPlaces.find(ap => ap.id === p.id)) {
        allPlaces.push(p);
      }
    });

    return allPlaces
      .filter(place => !isPlaceIncomplete(place))
      .map(place => {
        const validation = validateBusinessStatus(place);
        return {
          ...place,
          status: mapValidationToStatus(validation.status),
          reasoning_hebrew: validation.reasoning_hebrew,
          secondary_message: validation.secondary_message,
          confidence_score: validation.confidence_score,
          layers: validation.layers,
          reportCount: validation.reportCount,
          reporterPhotos: validation.reporterPhotos,
          lastUpdateMinutes: validation.lastUpdateMinutes,
          confidenceLevel: validation.confidenceLevel,
          isFaded: validation.isFaded
        };
      });
  }, [discoveredPlaces, pinnedPlaces, selectedPlace, emergencyData.active, currentTime]);

  const distanceToSelectedPlace = selectedPlace 
    ? getDistance(userLocation[0], userLocation[1], selectedPlace.lat, selectedPlace.lng)
    : Infinity;
  const maxReportingDistance = 50;
  const isAdmin = user?.email === 'itay8090100@gmail.com';
  const isTooFar = !isAdmin && distanceToSelectedPlace > maxReportingDistance;

  const filteredPlaces = React.useMemo(() => {
    // 1. Filter by category
    const targetCategoryLabel = activeCategory ? CATEGORIES.find(c => c.id === activeCategory)?.label : null;
    
    let filtered = activeCategory 
      ? validatedPlaces.filter(p => p.category === targetCategoryLabel)
      : validatedPlaces;
    
    // 2. Ensure selected place and pinned places are always in the list even if filtered out
    const alwaysVisibleIds = new Set([
      ...(selectedPlace ? [selectedPlace.id] : []),
      ...(tempVisiblePlaceId ? [tempVisiblePlaceId] : []),
      ...pinnedPlaces.map(p => p.id)
    ]);

    for (const id of alwaysVisibleIds) {
      if (!filtered.find(p => p.id === id)) {
        const placeInValidated = validatedPlaces.find(p => p.id === id);
        if (placeInValidated) {
          filtered = [placeInValidated, ...filtered];
        }
      }
    }
    return filtered;
  }, [validatedPlaces, activeCategory, selectedPlace, pinnedPlaces, tempVisiblePlaceId]);

  const prominenceCache = React.useRef<{ [id: string]: number }>({});

  const calculateProminenceScore = useCallback((place: Place) => {
    if (prominenceCache.current[place.id] !== undefined) {
      return prominenceCache.current[place.id];
    }

    const reliability = place.confidenceScore || 0; // 40%
    const external = (place.verificationLayers?.wolt || place.verificationLayers?.easy ? 100 : 0); // 30%
    const gps = (place.physicalPresence || 0) * 100; // 20%
    const popularity = (place.rating || 0) * 20; // 10% (assuming rating is 0-5)
    
    let score = (reliability * 0.4) + (external * 0.3) + (gps * 0.2) + (popularity * 0.1);
    
    if (place.isSuspicious) {
      score -= 50; // Significant penalty for suspicious names
    }
    
    prominenceCache.current[place.id] = score;
    return score;
  }, []);

  // Progressive Disclosure & Selective Density Logic
  const processedPlaces = React.useMemo(() => {
    // 1. Zoom < 13: Show nothing
    if (mapZoom < 13) return [];

    // Calculate prominence scores and sort
    const scoredPlaces = filteredPlaces.map(p => ({
      ...p,
      prominenceScore: calculateProminenceScore(p)
    })).sort((a, b) => b.prominenceScore - a.prominenceScore);

    // 2. Spatial Distribution (Anti-Line Effect)
    // We filter markers that are too close to each other to avoid clustering
    // Threshold depends on zoom level (approximate meters)
    const minDistance = mapZoom >= 17 ? 15 : (mapZoom >= 15 ? 30 : 50); 
    const distributed: any[] = [];
    
    // Always prioritize selected place and pinned places
    const priorityIds = new Set([
      ...(selectedPlace ? [selectedPlace.id] : []),
      ...pinnedPlaces.map(p => p.id)
    ]);

    // Helper to calculate distance in meters (Haversine formula)
    const getDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
      const R = 6371e3; // metres
      const φ1 = lat1 * Math.PI/180;
      const φ2 = lat2 * Math.PI/180;
      const Δφ = (lat2-lat1) * Math.PI/180;
      const Δλ = (lon2-lon1) * Math.PI/180;
      const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
              Math.cos(φ1) * Math.cos(φ2) *
              Math.sin(Δλ/2) * Math.sin(Δλ/2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
      return R * c;
    };

    scoredPlaces.forEach(place => {
      const isPriority = priorityIds.has(place.id);
      
      if (isPriority) {
        distributed.push({
          ...place,
          isDimmed: false,
          showLabel: true,
          labelType: mapZoom >= 17 ? 'full' : 'short',
          isLabelDimmed: false
        });
        return;
      }

      // Check if too close to any already added place
      const isTooClose = distributed.some(p => {
        const dist = getDistance(place.lat, place.lng, p.lat, p.lng);
        return dist < minDistance;
      });

      if (!isTooClose) {
        distributed.push({
          ...place,
          isDimmed: false,
          showLabel: mapZoom >= 15,
          labelType: mapZoom >= 17 ? 'full' : 'short',
          isLabelDimmed: false
        });
      }
    });

    return distributed;
  }, [filteredPlaces, mapZoom, calculateProminenceScore, selectedPlace, pinnedPlaces]);

  // Handle exit animations by keeping places in state for a short duration
  useEffect(() => {
    setVisiblePlaces(processedPlaces as any);
  }, [processedPlaces]);

  const selectedPlaceData = selectedPlace ? filteredPlaces.find(p => p.id === selectedPlace.id) : null;

  if (isLoadingLocation) {
    return (
      <div className="w-full h-screen bg-white flex items-center justify-center" dir="rtl">
        <div className="flex flex-col items-center gap-4">
          <div className="w-12 h-12 border-4 border-blue-500/20 border-t-blue-500 rounded-full animate-spin" />
          <span className="text-sm font-bold text-black/40">מאתר מיקום...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-full h-screen overflow-hidden font-sans" dir="rtl">
      {/* Map Layer */}
      <MapContainer 
        center={userLocation} 
        zoom={15} 
        zoomControl={false}
        className="w-full h-full z-0"
        ref={mapRef}
      >
        <MapEvents onMapClick={() => {
          if (window.innerWidth < 768) {
            setIsFilterOpen(false);
          }
        }} />
        <TileLayer
          url={isDarkMode && userProfile?.activeRewards?.includes('theme-dark')
            ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
            : "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          }
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
        />
        
        <MapDiscovery 
          onDiscovery={handleDiscovery} 
          onLoading={setIsSearching} 
          onZoomChange={setMapZoom} 
          activeCategory={activeCategory} 
          refreshTrigger={refreshTrigger}
          userProfile={userProfile}
        />

        {visiblePlaces.map((place: any) => (
          <BusinessMarker
            key={place.id}
            place={place}
            isActive={selectedPlace?.id === place.id}
            zoom={mapZoom}
            showLabel={place.showLabel}
            labelType={place.labelType}
            isDimmed={place.isDimmed}
            isLabelDimmed={place.isLabelDimmed}
            onClick={handlePlaceClick}
          />
        ))}

        {/* User Location Marker */}
        {isValidLatLng(userLocation[0], userLocation[1]) && (
          <Marker 
            position={userLocation}
            icon={L.divIcon({
              html: `
                <div class="relative flex items-center justify-center">
                  <div class="w-4 h-4 ${userProfile?.activeRewards?.includes('skin-silver') ? 'bg-slate-300 ring-slate-300/20' : 'bg-black ring-black/20'} rounded-full border-2 border-white shadow-lg ring-4"></div>
                  ${userProfile?.activeRewards?.includes('reporter-advanced') ? `
                    <div class="absolute -top-4 whitespace-nowrap bg-black/80 text-white text-[8px] px-1 rounded-sm font-bold">דיוק גבוה 🛰</div>
                  ` : ''}
                </div>
              `,
              className: '',
              iconSize: [16, 16],
              iconAnchor: [8, 8]
            })}
          />
        )}
      </MapContainer>

      {/* Error Toast */}
      <AnimatePresence>
        {errorToast && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed top-24 left-0 right-0 z-[200] flex justify-center pointer-events-none"
          >
            <div className="bg-red-500 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 pointer-events-auto">
              <ShieldAlert size={20} />
              <span className="text-sm font-bold">{errorToast}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Report Success Feedback */}
      <AnimatePresence>
        {reportSuccess && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            className="fixed top-24 left-0 right-0 z-[200] flex flex-col items-center gap-2 pointer-events-none"
          >
            <div className="bg-green-500 text-white px-6 py-3 rounded-full shadow-2xl flex items-center gap-3 pointer-events-auto">
              <CheckCircle2 size={20} />
              <span className="text-sm font-bold">דיווח התקבל!</span>
            </div>
            {impactMessage && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white/95 backdrop-blur-sm text-black px-5 py-2.5 rounded-full shadow-lg text-xs font-bold border border-black/5 flex items-center gap-2"
              >
                <ThumbsUp size={14} className="text-blue-500" />
                {impactMessage} 🙌
              </motion.div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Smart Reporting Prompt (Navigation Return) */}
      <AnimatePresence>
        {showNavPrompt && lastNavigatedPlace && !selectedPlace && (
          <motion.div
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            className="fixed bottom-24 left-4 right-4 z-[100] flex justify-center"
          >
            <div className="bg-black text-white rounded-[24px] shadow-2xl p-5 w-full max-w-sm flex flex-col gap-4">
              <div className="flex justify-between items-start">
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-bold">הגעת ל-{lastNavigatedPlace.name}?</span>
                  <span className="text-[11px] opacity-60">האם המקום היה פתוח כשהגעת?</span>
                </div>
                <button onClick={() => setShowNavPrompt(false)} className="opacity-40">
                  <XCircle size={20} />
                </button>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={() => {
                    handleReport('open', discoveredPlaces.find(p => p.id === lastNavigatedPlace.id) || null);
                    setShowNavPrompt(false);
                  }}
                  className="flex-1 bg-white text-black py-3 rounded-xl font-bold text-xs active:scale-95 transition-all"
                >
                  כן, פתוח
                </button>
                <button 
                  onClick={() => {
                    handleReport('closed', discoveredPlaces.find(p => p.id === lastNavigatedPlace.id) || null);
                    setShowNavPrompt(false);
                  }}
                  className="flex-1 bg-white/10 text-white py-3 rounded-xl font-bold text-xs active:scale-95 transition-all"
                >
                  לא, סגור
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Exit Reminder Prompt */}
      <AnimatePresence>
        {showExitReminder && lastViewedPlace && (
          <motion.div
            initial={{ opacity: 0, y: 100 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 100 }}
            className="fixed bottom-24 left-4 right-4 z-[100] flex justify-center"
          >
            <div className="bg-white rounded-[24px] shadow-2xl border border-black/5 p-4 w-full max-w-sm flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <span className="text-sm font-bold text-black">המקום היה פתוח? ({lastViewedPlace.name})</span>
                <button onClick={() => setShowExitReminder(false)} className="text-black/20">
                  <XCircle size={20} />
                </button>
              </div>
              <div className="flex gap-2">
                <button 
                  onClick={() => handleReport('open', lastViewedPlace)}
                  className="flex-1 bg-green-500 text-white py-2.5 rounded-xl font-bold text-xs active:scale-95 transition-all"
                >
                  פתוח
                </button>
                <button 
                  onClick={() => handleReport('closed', lastViewedPlace)}
                  className="flex-1 bg-red-500 text-white py-2.5 rounded-xl font-bold text-xs active:scale-95 transition-all"
                >
                  סגור
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {(isSearching || (filteredPlaces.length === 0 && !isSearching && discoveredPlaces.length > 0)) && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-24 left-0 right-0 z-30 flex justify-center pointer-events-none"
          >
            <div className="bg-white/90 backdrop-blur-md border border-black/5 px-4 py-2 rounded-full shadow-lg flex items-center gap-3 pointer-events-auto">
              {isSearching ? (
                <>
                  <div className="w-4 h-4 border-2 border-black/20 border-t-black rounded-full animate-spin" />
                  <span className="text-xs font-bold">מחפש בתי עסק בסביבה...</span>
                </>
              ) : (
                <span className="text-xs font-bold text-gray-500">
                  {activeCategory 
                    ? `לא נמצאו ${CATEGORIES.find(c => c.id === activeCategory)?.label} באזור זה`
                    : "לא נמצאו בתי עסק באזור זה"}
                </span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Bar: Header & Search */}
      <div className="absolute top-0 left-0 right-0 z-10 pt-4 sm:pt-6 pb-4 bg-gradient-to-b from-white/90 to-transparent pointer-events-none transition-all duration-500">
        <div className="px-4 sm:px-6 flex flex-col gap-3 sm:gap-4 pointer-events-auto">
          <div className="flex justify-between items-center">
            <h1 className="text-xl sm:text-2xl font-bold tracking-tighter text-black">
              מה באמת פתוח?
            </h1>
            <div className="flex items-center gap-2">
              {user ? (
                <div className="flex items-center gap-2 mr-2">
                  <button 
                    onClick={() => setShowRewards(true)}
                    className="flex items-center gap-1.5 bg-yellow-400/10 text-yellow-600 px-2 py-1 rounded-full text-[10px] font-bold border border-yellow-400/20"
                  >
                    <Star size={10} fill="currentColor" />
                    <span>{userProfile?.reportsCount || 0}</span>
                  </button>
                  <button 
                    onClick={handleLogout}
                    className="w-8 h-8 rounded-full overflow-hidden border-2 border-white shadow-sm relative"
                  >
                    <img src={user.photoURL || ''} alt="Profile" className="w-full h-full object-cover" />
                    {(userProfile?.activeRewards?.includes('badge-super') || userProfile?.activeRewards?.includes('badge-veteran')) && (
                      <div className="absolute -top-1 -right-1 bg-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] shadow-sm border border-black/5">
                        {userProfile?.activeRewards?.includes('badge-veteran') ? '👑' : '🏆'}
                      </div>
                    )}
                  </button>
                </div>
              ) : (
                <button 
                  onClick={handleLogin}
                  className="mr-2 bg-black text-white px-3 py-1 rounded-full text-[10px] font-bold flex items-center gap-1.5 active:scale-95 transition-transform"
                >
                  <UserIcon size={12} />
                  התחבר
                </button>
              )}
            </div>
          </div>

          <div className="flex flex-col md:flex-row items-stretch md:items-center gap-2">
            <div className="flex-1 order-1 md:order-2">
              <SearchComponent 
                onSelect={handleSearchSelect} 
                onFocus={() => {
                  if (window.innerWidth < 768) {
                    setIsFilterOpen(false);
                  }
                }}
                userLocation={userLocation} 
                userId={userProfile?.uid}
              />
            </div>
            <div ref={filterRef} className="relative order-2 md:order-1 w-fit mx-auto md:w-auto">
              <button 
                onClick={() => setIsFilterOpen(!isFilterOpen)}
                className={cn(
                  "h-10 md:h-12 px-3 md:px-4 rounded-xl md:rounded-2xl flex items-center justify-center md:justify-start gap-1 md:gap-2 transition-all shadow-sm border active:scale-95",
                  isFilterOpen 
                    ? "bg-black text-white border-black" 
                    : "bg-white/90 text-black border-black/5"
                )}
              >
                <span className="text-xs md:text-sm font-bold">
                  {activeCategory 
                    ? CATEGORIES.find(c => c.id === activeCategory)?.label 
                    : "כל הקטגוריות"}
                </span>
                <ChevronDown size={14} className={cn("md:w-[18px] md:h-[18px] transition-transform duration-200", isFilterOpen && "rotate-180")} />
              </button>

              {/* Mobile Filter Dropdown */}
              <div className="md:hidden">
                <AnimatePresence>
                  {isFilterOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                      transition={{ duration: 0.2, ease: "easeOut" }}
                      className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 pointer-events-auto"
                    >
                      <div className="bg-white/95 backdrop-blur-md border border-black/5 rounded-[20px] p-1.5 shadow-xl flex flex-col gap-0.5 max-h-[50vh] overflow-y-auto custom-scrollbar w-auto min-w-[160px]">
                        <button
                          onClick={() => {
                            setActiveCategory(null);
                            setIsFilterOpen(false);
                          }}
                          className={cn(
                            "flex items-center gap-2 px-3 py-2 rounded-lg transition-all border shrink-0 active:scale-[0.98]",
                            activeCategory === null 
                              ? "bg-black text-white border-black" 
                              : "bg-transparent text-black border-transparent hover:bg-black/[0.03]"
                          )}
                        >
                          <MapPin size={16} strokeWidth={2.5} />
                          <span className="text-xs font-bold">כל הקטגוריות</span>
                        </button>
                        
                        {CATEGORIES.map((cat) => (
                          <button
                            key={cat.id}
                            onClick={() => {
                              setActiveCategory(cat.id);
                              setIsFilterOpen(false);
                            }}
                            className={cn(
                              "flex items-center gap-2 px-3 py-2 rounded-lg transition-all border shrink-0 active:scale-[0.98]",
                              activeCategory === cat.id 
                                ? "bg-black text-white border-black" 
                                : "bg-transparent text-black border-transparent hover:bg-black/[0.03]"
                            )}
                          >
                            <div className="scale-90">
                              {getCategoryIcon(cat.label)}
                            </div>
                            <span className="text-xs font-bold">{cat.label}</span>
                          </button>
                        ))}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </div>
          </div>
        </div>

        {/* Desktop Filter Dropdown */}
        <div className="hidden md:block">
          <AnimatePresence>
            {isFilterOpen && (
              <motion.div
                initial={{ opacity: 0, y: -10, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, y: -10, height: 0 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className="px-4 sm:px-6 mt-3 sm:mt-4 pointer-events-auto overflow-hidden flex justify-start"
              >
                <div className="bg-white/95 backdrop-blur-md border border-black/5 rounded-[20px] md:rounded-[24px] p-1.5 md:p-2 shadow-xl flex flex-col gap-0.5 md:gap-1 max-h-[50vh] md:max-h-[60vh] overflow-y-auto custom-scrollbar w-full max-w-[200px] md:max-w-[250px]">
                  <button
                    onClick={() => {
                      setActiveCategory(null);
                      setIsFilterOpen(false);
                    }}
                    className={cn(
                      "flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 md:py-3 rounded-lg md:rounded-xl transition-all border shrink-0 active:scale-[0.98]",
                      activeCategory === null 
                        ? "bg-black text-white border-black" 
                        : "bg-transparent text-black border-transparent hover:bg-black/[0.03]"
                    )}
                  >
                    <MapPin size={16} className="md:w-[18px] md:h-[18px]" strokeWidth={2.5} />
                    <span className="text-xs md:text-sm font-bold">כל הקטגוריות</span>
                  </button>
                  
                  {CATEGORIES.map((cat) => {
                    return (
                      <button
                        key={cat.id}
                        onClick={() => {
                          setActiveCategory(cat.id);
                          setIsFilterOpen(false);
                        }}
                        className={cn(
                          "flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 md:py-3 rounded-lg md:rounded-xl transition-all border shrink-0 active:scale-[0.98]",
                          activeCategory === cat.id 
                            ? "bg-black text-white border-black" 
                            : "bg-transparent text-black border-transparent hover:bg-black/[0.03]"
                        )}
                      >
                        <div className="scale-90 md:scale-100">
                          {getCategoryIcon(cat.label)}
                        </div>
                        <span className="text-xs md:text-sm font-bold">{cat.label}</span>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Quick Info Sheet */}
      <AnimatePresence>
        {selectedPlace && (
          <motion.div
            initial={{ x: "100%", opacity: 0 }}
            animate={{ x: 0, opacity: 1, y: dragY }}
            exit={{ x: "100%", opacity: 0 }}
            transition={isDragging ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 28, mass: 0.8 }}
            className="absolute bottom-4 left-4 right-4 top-12 sm:bottom-8 sm:left-8 sm:right-auto sm:top-28 sm:w-[440px] sm:rounded-[32px] z-40 bg-white rounded-[32px] shadow-[0_-10px_40px_rgba(0,0,0,0.1)] sm:shadow-[0_20px_60px_rgba(0,0,0,0.15)] overflow-hidden flex flex-col border-t sm:border border-black/5"
            style={{ opacity: isDragging ? Math.max(0.7, 1 - dragY / 500) : 1 }}
          >
            {/* Drag Handle (Mobile only) */}
            <div 
              className="w-full flex justify-center pt-4 pb-4 sm:hidden cursor-grab active:cursor-grabbing touch-none"
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleTouchEnd}
            >
              <div className="w-12 h-1.5 bg-black/10 rounded-full" />
            </div>

            <div ref={placeDetailsRef} className="flex-1 overflow-y-auto custom-scrollbar">
              {/* Business Photo */}
              <div className="px-4 sm:px-6 pt-2 sm:pt-8">
                <motion.div 
                  whileHover={{ scale: 1.01 }}
                  whileTap={{ scale: 0.99 }}
                  className="w-full h-44 sm:h-56 rounded-[28px] overflow-hidden bg-white relative shadow-sm border border-black/5 cursor-pointer flex items-center justify-center group"
                >
                  {(!selectedPlace.imageUrl || imageError) ? (
                    <PlacePlaceholder category={selectedPlace.category} />
                  ) : (
                    <motion.img 
                      initial={{ filter: "brightness(1)" }}
                      whileHover={{ filter: "brightness(1.05)" }}
                      src={selectedPlace.potentialImages?.[imageIndex] || selectedPlace.imageUrl}
                      alt={selectedPlace.name}
                      className="w-full h-full object-cover transition-transform duration-700 group-hover:scale-105"
                      referrerPolicy="no-referrer"
                      onError={() => {
                        if (selectedPlace.potentialImages && imageIndex < selectedPlace.potentialImages.length - 1) {
                          setImageIndex(prev => prev + 1);
                        } else {
                          setImageError(true);
                        }
                      }}
                    />
                  )}
                  <div className="absolute top-4 right-4 bg-white/90 backdrop-blur-md px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider shadow-sm border border-black/5">
                    {selectedPlace.category}
                  </div>
                </motion.div>
              </div>

              <div className="p-4 sm:p-8 pt-6">
                <div className="flex justify-between items-start mb-6 sm:mb-8">
                  <div className="max-w-[80%]">
                    <h2 className="text-2xl sm:text-3xl font-bold tracking-tight mb-1.5 leading-tight text-black">{selectedPlace.name}</h2>
                    <p className="text-xs sm:text-sm text-black/50 font-medium flex items-center gap-1.5">
                      <MapPin size={14} className="opacity-40" />
                      {selectedPlace.address || (
                        <span className="text-[11px] sm:text-xs leading-relaxed block mt-1 opacity-70 font-normal">
                          לא הצלחנו למצוא כתובת למקום הזה.
                        </span>
                      )}
                    </p>
                  </div>
                  <button 
                    onClick={() => {
                      setSelectedPlace(null);
                      pendingSearchPlaceId.current = null;
                    }}
                    className="w-11 h-11 bg-black/5 rounded-full flex items-center justify-center text-black/40 hover:bg-black/10 hover:text-black/60 transition-all shrink-0 active:scale-90"
                  >
                    <XCircle size={26} />
                  </button>
                </div>

                {/* Status Card */}
                <div className={cn(
                  "p-5 sm:p-6 rounded-[28px] mb-6 sm:mb-8 flex flex-col gap-3 sm:gap-4 transition-all border shadow-sm",
                  selectedPlaceData?.status === 'active' ? "bg-[#2ECC71]/5 border-[#2ECC71]/20" : 
                  selectedPlaceData?.status === 'closing_soon' ? "bg-[#9ACD32]/5 border-[#9ACD32]/20" :
                  selectedPlaceData?.status === 'maybe' ? "bg-[#F39C12]/5 border-[#F39C12]/20" : "bg-[#E74C3C]/5 border-[#E74C3C]/20",
                  selectedPlaceData?.isFaded && "opacity-60"
                )}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3.5">
                      <div 
                        className="w-4 h-4 status-pulse-dot shadow-sm"
                        style={{ 
                          backgroundColor: 
                            selectedPlaceData?.status === 'active' ? "#2ECC71" : 
                            selectedPlaceData?.status === 'closing_soon' ? "#9ACD32" :
                            selectedPlaceData?.status === 'maybe' ? "#F39C12" : "#E74C3C",
                          '--pulse-color': 
                            selectedPlaceData?.status === 'active' ? "rgba(46, 204, 113, 0.4)" : 
                            selectedPlaceData?.status === 'closing_soon' ? "rgba(154, 205, 50, 0.4)" :
                            selectedPlaceData?.status === 'maybe' ? "rgba(243, 156, 18, 0.4)" : "rgba(231, 76, 60, 0.4)"
                        } as React.CSSProperties}
                      />
                      <div className="flex flex-col">
                        <span className="text-lg sm:text-xl font-bold text-black flex items-center gap-2">
                          <span>
                            {selectedPlaceData?.reasoning_hebrew}
                          </span>
                        </span>
                        {selectedPlaceData?.secondary_message && (
                          <span className="text-xs font-medium text-black/60">
                            {selectedPlaceData.secondary_message}
                          </span>
                        )}
                        {selectedPlaceData?.lastUpdateMinutes !== undefined && (
                          <span className="text-[10px] font-bold opacity-40 uppercase tracking-wider">
                            {selectedPlaceData.lastUpdateMinutes === 0 ? 'עודכן הרגע' : 
                             selectedPlaceData.lastUpdateMinutes === 1 ? 'עודכן לפני דקה' :
                             `עודכן לפני ${selectedPlaceData.lastUpdateMinutes} דקות`}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Confidence & Reporters */}
                  {(selectedPlaceData?.reportCount || 0) > 0 && (
                    <div className="mt-2 pt-3 border-t border-black/5 flex flex-col gap-3">
                      {/* Local Community Prompt for Awaiting Confirmation */}
                      {selectedPlaceData?.reasoning_hebrew === "ממתין לאימות" && distanceToSelectedPlace <= 50 && (
                        <div className="bg-blue-500/5 border border-blue-500/10 rounded-2xl p-4 flex flex-col gap-3">
                          <div className="flex items-center gap-2">
                            <HelpCircle size={16} className="text-blue-500" />
                            <span className="text-xs font-bold text-blue-700">אתה נמצא בקרבת המקום. תוכל לאמת אם הוא פתוח?</span>
                          </div>
                          <div className="flex gap-2">
                            <button 
                              onClick={() => handleReport('open')}
                              className="flex-1 bg-blue-500 text-white py-2 rounded-xl text-[10px] font-bold shadow-sm active:scale-95 transition-all"
                            >
                              פתוח עכשיו
                            </button>
                            <button 
                              onClick={() => handleReport('closed')}
                              className="flex-1 bg-white text-blue-500 border border-blue-500/20 py-2 rounded-xl text-[10px] font-bold shadow-sm active:scale-95 transition-all"
                            >
                              סגור עכשיו
                            </button>
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <div className="flex -space-x-2">
                            {selectedPlaceData?.reporterPhotos?.map((photo, i) => (
                              <img 
                                key={i}
                                src={photo} 
                                alt="reporter" 
                                className="w-6 h-6 rounded-full border-2 border-white shadow-sm object-cover"
                                referrerPolicy="no-referrer"
                              />
                            ))}
                            {(selectedPlaceData?.reportCount || 0) > 3 && (
                              <div className="w-6 h-6 rounded-full border-2 border-white bg-gray-100 flex items-center justify-center text-[8px] font-bold text-gray-500 shadow-sm">
                                +{selectedPlaceData!.reportCount! - 3}
                              </div>
                            )}
                          </div>
                          <span className="text-[11px] font-medium text-black/60">
                            {selectedPlaceData?.reportCount === 1 ? 'משתמש אחד אישר' : `${selectedPlaceData?.reportCount} משתמשים אישרו`} שהמקום פתוח
                          </span>
                        </div>
                        <div className={cn(
                          "px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-tight",
                          selectedPlaceData?.confidenceLevel === 'high' ? "bg-green-100 text-green-700" :
                          selectedPlaceData?.confidenceLevel === 'medium' ? "bg-orange-100 text-orange-700" :
                          "bg-gray-100 text-gray-600"
                        )}>
                          {selectedPlaceData?.confidenceLevel === 'high' ? 'אמינות גבוהה' :
                           selectedPlaceData?.confidenceLevel === 'medium' ? 'אמינות בינונית' :
                           'אמינות נמוכה'}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                <div className="mb-6 sm:mb-8">
                  {/* Presence and Update boxes removed as per request */}
                </div>

                {/* Popular Times */}
                {selectedPlace.popularTimes && (
                  <div className="mb-6 sm:mb-8 p-6 bg-black/[0.02] rounded-[28px] border border-black/[0.03]">
                    <div className="flex justify-between items-center mb-4">
                      <h3 className="text-[10px] uppercase font-bold opacity-30 tracking-wider">שעות עומס</h3>
                      <span className="text-[10px] font-bold opacity-30">היום</span>
                    </div>
                    <div className="h-20 flex items-end gap-1 px-1">
                      {(selectedPlace.popularTimes.find(d => d.day === new Date().toLocaleDateString('en-US', { weekday: 'long' })) || selectedPlace.popularTimes[0])?.hours.map((val, i) => {
                        const isCurrentHour = i === new Date().getHours();
                        return (
                          <div 
                            key={i} 
                            className={cn(
                              "flex-1 rounded-t-[2px] transition-all duration-500",
                              isCurrentHour ? "bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]" : "bg-black/10"
                            )}
                            style={{ height: `${Math.max(val, 2)}%` }}
                          />
                        );
                      })}
                    </div>
                    <div className="flex justify-between mt-2 text-[9px] font-bold opacity-20 px-1">
                      <span>00:00</span>
                      <span>12:00</span>
                      <span>23:00</span>
                    </div>
                  </div>
                )}

                {/* Opening Hours */}
                <div className="mb-8 p-6 bg-black/[0.02] rounded-[28px] border border-black/[0.03]">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-[10px] uppercase font-bold opacity-30 tracking-wider">שעות פתיחה</h3>
                    {(selectedPlace.normalizedOpeningHours || (Array.isArray(selectedPlace.openingHours) && selectedPlace.openingHours.length > 0)) && (
                      <button 
                        onClick={() => setShowFullHours(!showFullHours)}
                        className="text-[10px] font-bold text-blue-600 uppercase tracking-wider hover:text-blue-700 transition-colors"
                      >
                        {showFullHours ? 'פחות' : 'הצג הכל'}
                      </button>
                    )}
                  </div>
                  {selectedPlace.normalizedOpeningHours || (Array.isArray(selectedPlace.openingHours) && selectedPlace.openingHours.length > 0) ? (
                    <div className="flex flex-col gap-2.5">
                      {selectedPlace.normalizedOpeningHours ? (
                        Object.entries(selectedPlace.normalizedOpeningHours)
                          .sort((a, b) => {
                            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                            return days.indexOf(a[0]) - days.indexOf(b[0]);
                          })
                          .filter(([day]) => {
                            if (showFullHours) return true;
                            const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
                            return day === days[new Date().getDay()];
                          })
                          .map(([day, hoursData]) => {
                            const ranges = hoursData as TimeRange[];
                            const daysHe: Record<string, string> = {
                              Sunday: 'יום ראשון',
                              Monday: 'יום שני',
                              Tuesday: 'יום שלישי',
                              Wednesday: 'יום רביעי',
                              Thursday: 'יום חמישי',
                              Friday: 'יום שישי',
                              Saturday: 'יום שבת'
                            };
                            const dayHe = daysHe[day] || day;
                            const isToday = day === ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date().getDay()];
                            
                            let hoursStr = '';
                            if (ranges.length === 0) {
                              hoursStr = 'סגור';
                            } else if (ranges.length === 1 && ranges[0].open === 0 && ranges[0].close === 0) {
                              hoursStr = 'פתוח 24 שעות';
                            } else {
                              const formatTime = (m: number) => {
                                const h = Math.floor(m / 60);
                                const min = m % 60;
                                return `${h.toString().padStart(2, '0')}:${min.toString().padStart(2, '0')}`;
                              };
                              hoursStr = ranges.map(r => `${formatTime(r.open)} – ${formatTime(r.close)}`).join(', ');
                            }

                            return (
                              <div 
                                key={day} 
                                className={cn(
                                  "flex justify-between text-xs sm:text-sm font-medium py-1.5 px-3 rounded-xl transition-all",
                                  isToday ? "bg-blue-500/5 text-blue-600 font-bold shadow-sm" : "text-black/60"
                                )}
                              >
                                <span>{dayHe}</span>
                                <span className="tabular-nums text-left" dir="ltr">{hoursStr}</span>
                              </div>
                            );
                          })
                      ) : (
                        (selectedPlace.openingHours as string[])
                          .filter((day) => {
                            if (showFullHours) return true;
                            const todayName = new Date().toLocaleDateString('he-IL', { weekday: 'long' });
                            return String(day || "").includes(todayName);
                          })
                          .map((day, idx) => {
                            const todayName = new Date().toLocaleDateString('he-IL', { weekday: 'long' });
                            const dayStr = String(day || "");
                            const isToday = dayStr.includes(todayName);
                            const [dayName, hours] = dayStr.split(': ');
                            
                            return (
                              <div 
                                key={idx} 
                                className={cn(
                                  "flex justify-between text-xs sm:text-sm font-medium py-1.5 px-3 rounded-xl transition-all",
                                  isToday ? "bg-blue-500/5 text-blue-600 font-bold shadow-sm" : "text-black/60"
                                )}
                              >
                                <span>{dayName}</span>
                                <span className="tabular-nums text-left" dir="ltr">{hours}</span>
                              </div>
                            );
                          })
                      )}
                    </div>
                  ) : (
                    <p className="text-xs sm:text-sm font-medium text-black/40 text-center py-2 leading-relaxed">
                      שעות הפתיחה של המקום הזה מסתוריות במיוחד.
                      <br />
                      כנראה צריך פשוט להגיע ולבדוק.
                    </p>
                  )}
                </div>

                <div className="flex flex-col gap-4 mt-auto pb-4">
                  <div className="flex flex-col gap-2 relative">
                    <AnimatePresence>
                      {isTooFar && showTooFarTooltip && (
                        <motion.div
                          initial={{ opacity: 0, y: 10, scale: 0.95 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.95 }}
                          className="absolute -top-10 left-1/2 -translate-x-1/2 z-50 bg-black/80 backdrop-blur-sm text-white text-[11px] font-bold py-1.5 px-3 rounded-xl shadow-xl whitespace-nowrap pointer-events-none"
                        >
                          עליך להיות בקרבת המקום כדי לדווח על הסטטוס שלו
                          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-black/80 rotate-45" />
                        </motion.div>
                      )}
                    </AnimatePresence>

                    <div className="flex gap-3">
                      <button 
                        onClick={() => isTooFar ? triggerTooFarTooltip() : handleReport('open')}
                        onMouseEnter={() => isTooFar && setShowTooFarTooltip(true)}
                        onMouseLeave={() => isTooFar && setShowTooFarTooltip(false)}
                        disabled={isReportingStatus || (!isTooFar && !!userReportsTimestamps[selectedPlace.id] && (Date.now() - userReportsTimestamps[selectedPlace.id] < 30 * 60 * 1000))}
                        aria-disabled={isTooFar}
                        title={isTooFar ? "עליך להיות בקרבת המקום כדי לדווח על הסטטוס שלו" : undefined}
                        className={cn(
                          "flex-1 h-14 rounded-[24px] font-bold text-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-lg",
                          isTooFar 
                            ? "bg-green-500/50 text-white/70 cursor-not-allowed shadow-none"
                            : (userReportsTimestamps[selectedPlace.id] && (Date.now() - userReportsTimestamps[selectedPlace.id] < 30 * 60 * 1000)) 
                              ? "bg-gray-100 text-black/20 border border-black/5" 
                              : "bg-green-500 text-white shadow-green-500/20 hover:bg-green-600"
                        )}
                      >
                        {isReportingStatus ? <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : "פתוח עכשיו"}
                      </button>
                      <button 
                        onClick={() => isTooFar ? triggerTooFarTooltip() : handleReport('closed')}
                        onMouseEnter={() => isTooFar && setShowTooFarTooltip(true)}
                        onMouseLeave={() => isTooFar && setShowTooFarTooltip(false)}
                        disabled={isReportingStatus || (!isTooFar && !!userReportsTimestamps[selectedPlace.id] && (Date.now() - userReportsTimestamps[selectedPlace.id] < 30 * 60 * 1000))}
                        aria-disabled={isTooFar}
                        title={isTooFar ? "עליך להיות בקרבת המקום כדי לדווח על הסטטוס שלו" : undefined}
                        className={cn(
                          "flex-1 h-14 rounded-[24px] font-bold text-sm transition-all active:scale-[0.98] flex items-center justify-center gap-2 shadow-lg",
                          isTooFar
                            ? "bg-red-500/50 text-white/70 cursor-not-allowed shadow-none"
                            : (userReportsTimestamps[selectedPlace.id] && (Date.now() - userReportsTimestamps[selectedPlace.id] < 30 * 60 * 1000)) 
                              ? "bg-gray-100 text-black/20 border border-black/5" 
                              : "bg-red-500 text-white shadow-red-500/20 hover:bg-red-600"
                        )}
                      >
                        {isReportingStatus ? <div className="w-4 h-4 border-2 border-white/20 border-t-white rounded-full animate-spin" /> : "סגור עכשיו"}
                      </button>
                    </div>
                  </div>

                  <button 
                    onClick={() => setShowNavigationDialog(true)}
                    className="w-full bg-black text-white py-4.5 sm:py-5 rounded-[24px] font-bold text-sm sm:text-base flex items-center justify-center gap-2.5 active:scale-[0.98] transition-all shadow-xl shadow-black/10 hover:bg-black/90"
                  >
                    <Navigation size={20} strokeWidth={1.5} />
                    ניווט למקום
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rewards Modal */}
      <AnimatePresence>
        {showRewards && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white w-full max-w-md rounded-[32px] overflow-hidden shadow-2xl"
            >
              <div className="p-6 border-b border-black/5 flex justify-between items-center bg-yellow-400/5">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 bg-yellow-400 rounded-2xl flex items-center justify-center text-white shadow-lg shadow-yellow-400/20">
                    <Trophy size={20} />
                  </div>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <h2 className="text-lg font-bold">ההישגים שלי</h2>
                      {userProfile?.activeRewards?.includes('badge-veteran') && <span title="ותיק" className="text-lg">👑</span>}
                      {userProfile?.activeRewards?.includes('badge-super') && <span title="תורם על" className="text-lg">🏆</span>}
                    </div>
                    <p className="text-xs opacity-50 font-medium">{userProfile?.reportsCount || 0} דיווחים שתרמו לקהילה</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setShowHelp(true)}
                    className="w-8 h-8 bg-black/5 rounded-full flex items-center justify-center text-black/40 hover:bg-black/10 transition-colors"
                  >
                    <HelpCircle size={18} />
                  </button>
                  <button 
                    onClick={() => setShowRewards(false)}
                    className="w-8 h-8 bg-black/5 rounded-full flex items-center justify-center text-black/40 hover:bg-black/10 transition-colors"
                  >
                    <XCircle size={20} />
                  </button>
                </div>
              </div>

              <div className="p-6 flex flex-col gap-4 max-h-[60vh] overflow-y-auto">
                {REWARDS.map(reward => {
                  const isUnlocked = userProfile?.unlockedRewards?.includes(reward.id);
                  const isActive = userProfile?.activeRewards?.includes(reward.id);
                  const progress = Math.min(100, ((userProfile?.reportsCount || 0) / reward.reportsRequired) * 100);
                  
                  return (
                    <div key={reward.id} className={cn(
                      "p-4 rounded-[24px] border transition-all",
                      isUnlocked ? "bg-green-50 border-green-100" : "bg-black/[0.02] border-black/[0.05] opacity-60"
                    )}>
                      <div className="flex justify-between items-center mb-3">
                        <div className="flex gap-3 items-center">
                          <div className="text-2xl">{reward.icon}</div>
                          <div>
                            <h3 className="text-sm font-bold">{reward.title}</h3>
                            {isUnlocked ? (
                              <p className="text-[10px] opacity-50 font-medium">{reward.description}</p>
                            ) : (
                              <div className="flex items-center gap-1 opacity-30">
                                <Lock size={10} />
                                <span className="text-[10px] font-bold">{reward.reportsRequired} דיווחים</span>
                              </div>
                            )}
                          </div>
                        </div>
                        
                        {isUnlocked && (
                          <div className="flex items-center gap-1 text-green-600">
                            <CheckCircle2 size={14} />
                            <span className="text-[10px] font-bold">פתוח</span>
                          </div>
                        )}
                      </div>
                      
                      {isUnlocked && (
                        <div className="mt-3 pt-3 border-t border-green-100/50 flex justify-between items-center">
                          <span className="text-[10px] font-bold opacity-50">מצב בונוס:</span>
                          <RewardActionButton 
                            isActive={!!isActive}
                            onToggle={() => toggleReward(reward.id)}
                            activateText={`הפעל ${reward.title}`}
                            deactivateText={`כיבוי ${reward.title}`}
                          />
                        </div>
                      )}
                      
                      {isUnlocked && reward.id === 'theme-dark' && isActive && (
                        <div className="mt-3 pt-3 border-t border-green-100 flex justify-between items-center">
                          <span className="text-[10px] font-bold opacity-50">בחר מצב:</span>
                          <button 
                            onClick={() => setIsDarkMode(!isDarkMode)}
                            className={cn(
                              "text-[10px] font-bold px-3 py-1 rounded-lg transition-colors",
                              isDarkMode ? "bg-black text-white" : "bg-white text-black border border-black/10"
                            )}
                          >
                            {isDarkMode ? 'מצב יום' : 'מצב לילה'}
                          </button>
                        </div>
                      )}

                      {!isUnlocked && (
                        <div className="w-full h-1.5 bg-black/5 rounded-full overflow-hidden mt-2">
                          <motion.div 
                            initial={{ width: 0 }}
                            animate={{ width: `${progress}%` }}
                            className="h-full bg-yellow-400"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              <div className="p-6 pt-0">
                <button 
                  onClick={() => setShowRewards(false)}
                  className="w-full bg-black text-white py-4 rounded-[20px] font-bold text-sm active:scale-95 transition-transform"
                >
                  המשך לדווח
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Help Modal */}
      <AnimatePresence>
        {showHelp && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[110] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white w-full max-w-sm rounded-[32px] overflow-hidden shadow-2xl p-8"
            >
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold">איך זה עובד?</h2>
                <button onClick={() => setShowHelp(false)} className="text-black/20">
                  <XCircle size={24} />
                </button>
              </div>
              
              <div className="flex flex-col gap-6">
                <div className="flex gap-4">
                  <div className="w-10 h-10 bg-blue-50 rounded-2xl flex items-center justify-center text-blue-500 shrink-0">
                    <MapPin size={20} />
                  </div>
                  <p className="text-sm font-medium leading-relaxed">אתה מדווח ממקום שבו אתה נמצא</p>
                </div>
                
                <div className="flex gap-4">
                  <div className="w-10 h-10 bg-green-50 rounded-2xl flex items-center justify-center text-green-500 shrink-0">
                    <Store size={20} />
                  </div>
                  <p className="text-sm font-medium leading-relaxed">הדיווח נשמר עבור העסק</p>
                </div>
                
                <div className="flex gap-4">
                  <div className="w-10 h-10 bg-yellow-50 rounded-2xl flex items-center justify-center text-yellow-500 shrink-0">
                    <Trophy size={20} />
                  </div>
                  <p className="text-sm font-medium leading-relaxed">ככל שתדווח יותר תפתח יכולות חדשות</p>
                </div>
              </div>

              <button 
                onClick={() => setShowHelp(false)}
                className="w-full mt-8 bg-black text-white py-4 rounded-[20px] font-bold text-sm"
              >
                הבנתי, תודה
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Logout Confirmation Modal */}
      <AnimatePresence>
        {showLogoutConfirm && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[130] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white w-full max-w-xs rounded-[32px] overflow-hidden shadow-2xl p-8 text-center"
            >
              <div className="w-16 h-16 bg-red-50 rounded-full flex items-center justify-center text-red-500 mx-auto mb-6">
                <LogOut size={32} />
              </div>
              
              <h2 className="text-xl font-bold mb-2">Exit account?</h2>
              <p className="text-sm text-black/50 font-medium mb-8">Are you sure you want to log out?</p>
              
              <div className="flex flex-col gap-3">
                <button 
                  onClick={performLogout}
                  className="w-full bg-red-500 text-white py-4 rounded-[20px] font-bold text-sm active:scale-95 transition-transform"
                >
                  Log out
                </button>
                <button 
                  onClick={() => setShowLogoutConfirm(false)}
                  className="w-full bg-black/5 text-black py-4 rounded-[20px] font-bold text-sm active:scale-95 transition-transform"
                >
                  Cancel
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Location Onboarding Modal */}
      <AnimatePresence>
        {showLocationOnboarding && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[120] bg-black/60 backdrop-blur-sm flex items-center justify-center p-6"
          >
            <motion.div 
              initial={{ scale: 0.9, y: 20 }}
              animate={{ scale: 1, y: 0 }}
              className="bg-white w-full max-w-sm rounded-[40px] overflow-hidden shadow-2xl p-10 text-center"
            >
              <AnimatePresence mode="wait">
                {locationPermissionDenied ? (
                  <motion.div
                    key="denied"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="flex flex-col items-center"
                  >
                    <div className="w-20 h-20 bg-red-50 rounded-[32px] flex items-center justify-center text-red-500 mb-8">
                      <ShieldAlert size={40} strokeWidth={1.5} />
                    </div>
                    
                    <h2 className="text-2xl font-bold mb-4 text-black">גישה למיקום נחסמה</h2>
                    <p className="text-sm text-black/60 font-medium leading-relaxed mb-10">
                      יש להפעיל מיקום בהגדרות הדפדפן כדי שנוכל להציג לך את המקומות הקרובים אליך.
                    </p>

                    <div className="flex flex-col gap-3 w-full">
                      <button 
                        onClick={async () => {
                          if ("permissions" in navigator) {
                            try {
                              const result = await navigator.permissions.query({ name: "geolocation" as PermissionName });
                              if (result.state === "denied") {
                                // Still denied, maybe user needs to change settings
                                return;
                              }
                            } catch (e) {
                              console.error("Permission query failed", e);
                            }
                          }
                          setLocationPermissionDenied(false);
                          requestLocation();
                          localStorage.setItem('location_onboarding_done', 'true');
                          setShowLocationOnboarding(false);
                        }}
                        className="w-full bg-black text-white py-4.5 rounded-[24px] font-bold text-sm active:scale-95 transition-transform shadow-lg shadow-black/10"
                      >
                        נסה שוב
                      </button>
                      <button 
                        onClick={() => {
                          localStorage.setItem('location_onboarding_done', 'true');
                          setShowLocationOnboarding(false);
                        }}
                        className="w-full bg-black/5 text-black/40 py-4 rounded-[24px] font-bold text-sm active:scale-95 transition-transform"
                      >
                        לא עכשיו
                      </button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="onboarding"
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, x: -20 }}
                    className="flex flex-col items-center"
                  >
                    <div className="w-20 h-20 bg-blue-50 rounded-[32px] flex items-center justify-center text-blue-500 mb-8">
                      <MapPin size={40} strokeWidth={1.5} />
                    </div>
                    
                    <h2 className="text-2xl font-bold mb-4 text-black">נשמח להכיר את הסביבה שלך</h2>
                    <p className="text-sm text-black/60 font-medium leading-relaxed mb-10">
                      כדי להציג מקומות קרובים אליך, נדרש לאפשר גישה למיקום.
                    </p>

                    <div className="flex flex-col gap-3 w-full">
                      <button 
                        onClick={async () => {
                          if ("permissions" in navigator) {
                            try {
                              const result = await navigator.permissions.query({ name: "geolocation" as PermissionName });
                              if (result.state === "denied") {
                                setLocationPermissionDenied(true);
                                return;
                              }
                            } catch (e) {
                              console.error("Permission query failed", e);
                            }
                          }
                          
                          // If not denied, try to get location
                          navigator.geolocation.getCurrentPosition(
                            (pos) => {
                              const { latitude, longitude } = pos.coords;
                              if (isValidLatLng(latitude, longitude)) {
                                const newLoc: [number, number] = [latitude, longitude];
                                setUserLocation(newLoc);
                                setRefreshTrigger(prev => prev + 1);
                                if (mapRef.current) {
                                  mapRef.current.flyTo(newLoc, 17, {
                                    duration: 2,
                                    easeLinearity: 0.25
                                  });
                                }
                              }
                              localStorage.setItem('location_onboarding_done', 'true');
                              setShowLocationOnboarding(false);
                            },
                            (err) => {
                              if (err.code === err.PERMISSION_DENIED) {
                                setLocationPermissionDenied(true);
                              } else {
                                // Other errors, just close onboarding
                                localStorage.setItem('location_onboarding_done', 'true');
                                setShowLocationOnboarding(false);
                              }
                            }
                          );
                        }}
                        className="w-full bg-black text-white py-4.5 rounded-[24px] font-bold text-sm active:scale-95 transition-transform shadow-lg shadow-black/10"
                      >
                        אפשר מיקום
                      </button>
                      <button 
                        onClick={() => {
                          localStorage.setItem('location_onboarding_done', 'true');
                          setShowLocationOnboarding(false);
                        }}
                        className="w-full bg-black/5 text-black/40 py-4 rounded-[24px] font-bold text-sm active:scale-95 transition-transform"
                      >
                        לא עכשיו
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Navigation Selection Dialog */}
      <AnimatePresence>
        {showNavigationDialog && selectedPlace && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[150] bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center p-4 sm:p-6"
            onClick={() => setShowNavigationDialog(false)}
          >
            <motion.div 
              initial={{ y: "100%", opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: "100%", opacity: 0 }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="bg-white w-full max-w-sm rounded-[32px] overflow-hidden shadow-2xl p-8"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex justify-between items-center mb-8">
                <h2 className="text-xl font-bold text-black">בחר אפליקציית ניווט</h2>
                <button 
                  onClick={() => setShowNavigationDialog(false)}
                  className="w-10 h-10 bg-black/5 rounded-full flex items-center justify-center text-black/40 hover:bg-black/10 transition-colors"
                >
                  <XCircle size={24} />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-4">
                  <a 
                    href={`https://www.google.com/maps/dir/?api=1&destination=${selectedPlace.lat},${selectedPlace.lng}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => {
                      setLastNavigatedPlace({ id: selectedPlace.id, name: selectedPlace.name, time: Date.now(), lat: selectedPlace.lat, lng: selectedPlace.lng });
                      setShowNavigationDialog(false);
                    }}
                    className="flex flex-col items-center gap-4 p-6 bg-gray-50 rounded-[24px] hover:bg-blue-50 transition-all border border-black/5 group"
                  >
                  <div className="w-16 h-16 bg-white rounded-2xl shadow-sm flex items-center justify-center group-hover:scale-110 transition-transform overflow-hidden p-3">
                    {googleMapsIconError ? (
                      <Navigation size={32} className="text-green-600" />
                    ) : (
                      <img 
                        src="https://upload.wikimedia.org/wikipedia/commons/a/aa/Google_Maps_icon_%282020%29.svg" 
                        alt="Google Maps" 
                        className="w-full h-full object-contain"
                        referrerPolicy="no-referrer"
                        onError={() => setGoogleMapsIconError(true)}
                      />
                    )}
                  </div>
                  <span className="text-sm font-bold text-black/70">Google Maps</span>
                </a>

                <a 
                  href={`https://waze.com/ul?ll=${selectedPlace.lat},${selectedPlace.lng}&navigate=yes`}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    setLastNavigatedPlace({ id: selectedPlace.id, name: selectedPlace.name, time: Date.now(), lat: selectedPlace.lat, lng: selectedPlace.lng });
                    setShowNavigationDialog(false);
                  }}
                  className="flex flex-col items-center gap-4 p-6 bg-gray-50 rounded-[24px] hover:bg-blue-50 transition-all border border-black/5 group"
                >
                  <div className="w-16 h-16 bg-white rounded-2xl shadow-sm flex items-center justify-center group-hover:scale-110 transition-transform overflow-hidden p-2">
                    {wazeIconError ? (
                      <Navigation size={32} className="text-blue-400" />
                    ) : (
                      <img 
                        src="https://logo-teka.com/wp-content/uploads/2026/01/waze-icon-logo.svg" 
                        alt="Waze" 
                        className="w-full h-full object-contain"
                        referrerPolicy="no-referrer"
                        onError={() => setWazeIconError(true)}
                      />
                    )}
                  </div>
                  <span className="text-sm font-bold text-black/70">Waze</span>
                </a>
              </div>

              <button 
                onClick={() => setShowNavigationDialog(false)}
                className="w-full mt-8 py-4 text-sm font-bold text-black/30 hover:text-black/50 transition-colors"
              >
                ביטול
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Action Buttons */}
      <div className="absolute bottom-4 left-4 md:bottom-10 md:left-6 z-10 flex flex-col gap-4">
        <button 
          onClick={requestLocation}
          className="w-12 h-12 md:w-14 md:h-14 bg-white rounded-2xl shadow-xl flex items-center justify-center text-black active:scale-90 transition-transform border border-black/5"
        >
          <Navigation size={20} className="md:w-6 md:h-6" />
        </button>
      </div>

      {/* Emergency Indicator */}
      <AnimatePresence>
        {emergencyData.active && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 20 }}
            className="absolute bottom-4 md:bottom-10 right-4 md:right-6 z-10"
          >
            <div className="bg-white/80 backdrop-blur-sm text-black px-3 py-2.5 md:px-4 md:py-3 rounded-xl md:rounded-2xl shadow-lg border border-black/5 flex flex-col gap-0.5 md:gap-1 min-w-[140px] md:min-w-[200px] max-w-[180px] md:max-w-[280px]">
              <div className="flex items-center gap-1.5 md:gap-2 text-red-600">
                <ShieldAlert size={14} className="md:w-[18px] md:h-[18px]" />
                <span className="text-[10px] md:text-sm font-bold">🛡 מצב ביטחוני</span>
              </div>
              <span className="text-[8px] md:text-[10px] font-medium text-black/50 leading-tight">
                דיוק הסטטוס עלול להשתנות.
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
