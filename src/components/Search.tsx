import React, { useState, useEffect, useRef } from 'react';
import { Search as SearchIcon, X, MapPin, Loader2, History, CheckCircle2, Globe } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { searchPlaces, upsertPlaceToDB, searchGooglePlaces } from '../services/placesService';
import { Place } from '../types';
import { convertEnToHeLayout, hasEnglishLetters } from '../utils/keyboardLayout';

interface SearchProps {
  onSelect: (place: Place) => void;
  onFocus?: () => void;
  userLocation: [number, number];
  userId?: string;
}

const HISTORY_KEY = 'search_history_v1';
const MAX_HISTORY = 15;

export const Search: React.FC<SearchProps> = React.memo(({ onSelect, onFocus, userLocation, userId }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [googleResults, setGoogleResults] = useState<Place[]>([]);
  const [history, setHistory] = useState<Place[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isGoogleSearching, setIsGoogleSearching] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  // Load history on mount
  useEffect(() => {
    const saved = localStorage.getItem(HISTORY_KEY);
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) {
        console.error("Failed to parse history", e);
      }
    }
  }, []);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    const delayDebounceFn = setTimeout(async () => {
      if (query.length > 2) {
        setIsSearching(true);
        const searchResults = await searchPlaces(query, { lat: userLocation[0], lng: userLocation[1] }, userId);
        setResults(searchResults);
        setGoogleResults([]); // Clear google results on new local search
        setIsSearching(false);
        setIsOpen(true);
      } else {
        setResults([]);
        setGoogleResults([]);
        // Show history if query is empty and input is focused
        if (query.length === 0 && history.length > 0) {
          setIsOpen(true);
        } else {
          setIsOpen(false);
        }
      }
    }, 300);

    return () => clearTimeout(delayDebounceFn);
  }, [query, userLocation, history.length]);

  const handleSelect = async (place: Place) => {
    // Add to history
    const newHistory = [place, ...history.filter(p => p.id !== place.id)].slice(0, MAX_HISTORY);
    setHistory(newHistory);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(newHistory));

    // Upsert if it's a Google result
    if (!place.isLocal) {
      await upsertPlaceToDB(place);
    }

    onSelect(place);
    setIsOpen(false);
    setQuery('');
  };

  const getFilteredHistory = (q: string) => {
    const original = history.filter(p => 
      p.name.toLowerCase().includes(q.toLowerCase()) || 
      p.address?.toLowerCase().includes(q.toLowerCase())
    );
    
    if (original.length === 0 && hasEnglishLetters(q)) {
      const converted = convertEnToHeLayout(q);
      if (converted !== q) {
        return history.filter(p => 
          p.name.toLowerCase().includes(converted.toLowerCase()) || 
          p.address?.toLowerCase().includes(converted.toLowerCase())
        );
      }
    }
    return original;
  };

  const filteredHistory = getFilteredHistory(query);

  const hasStrongMatch = results.some(p => 
    p.name.toLowerCase() === query.toLowerCase() || 
    p.name.toLowerCase().startsWith(query.toLowerCase())
  );

  const handleGoogleSearch = async () => {
    if (!query || !userId) return;
    setIsGoogleSearching(true);
    try {
      const gResults = await searchGooglePlaces(query, { lat: userLocation[0], lng: userLocation[1] }, userId);
      setGoogleResults(gResults);
    } catch (error) {
      console.error("Google search failed", error);
    } finally {
      setIsGoogleSearching(false);
    }
  };

  const showSuggestions = isOpen && isFocused && (results.length > 0 || googleResults.length > 0 || filteredHistory.length > 0 || isSearching || (query.length > 2));

  return (
    <div ref={searchRef} className="relative w-full max-w-md mx-auto px-4">
      <div className="relative group">
        <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none text-gray-400 group-focus-within:text-black transition-colors">
          <SearchIcon size={20} />
        </div>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => { 
            setIsOpen(true); 
            setIsFocused(true);
            onFocus?.();
          }}
          onBlur={() => {
            // Delay blur to allow clicking suggestions
            setTimeout(() => setIsFocused(false), 200);
          }}
          placeholder="חפש עסק, כתובת או קטגוריה..."
          className="w-full h-12 pl-12 pr-12 bg-white/80 backdrop-blur-2xl border border-black/[0.08] rounded-2xl shadow-[0_8px_32px_rgba(0,0,0,0.08)] outline-none focus:ring-4 focus:ring-black/5 focus:border-black/10 transition-all text-right font-medium placeholder:text-gray-400"
          dir="rtl"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute inset-y-0 right-4 flex items-center text-gray-400 hover:text-black transition-colors"
          >
            <X size={20} />
          </button>
        )}
      </div>

      <AnimatePresence>
        {showSuggestions && (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="absolute top-full left-4 right-4 mt-3 bg-white/90 backdrop-blur-3xl border border-black/[0.08] rounded-[24px] shadow-[0_20px_60px_rgba(0,0,0,0.15)] overflow-hidden z-50"
          >
            {isSearching ? (
              <div className="p-8 flex flex-col items-center justify-center gap-3 text-gray-400">
                <Loader2 className="animate-spin" size={24} />
                <span className="text-sm font-medium">מחפש תוצאות...</span>
              </div>
            ) : (
              <div className="max-h-[60vh] overflow-y-auto py-2">
                {/* History Section */}
                {filteredHistory.length > 0 && (
                  <div className="mb-2">
                    <div className="px-4 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">חיפושים אחרונים</div>
                    {filteredHistory.map((place) => (
                      <button
                        key={`hist-${place.id}`}
                        onClick={() => handleSelect(place)}
                        className="w-full px-4 py-3 flex items-center gap-4 hover:bg-black/5 transition-colors text-right"
                        dir="rtl"
                      >
                        <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-gray-400 shrink-0">
                          <History size={18} />
                        </div>
                        <div className="flex flex-col min-w-0">
                          <span className="font-bold text-black truncate">{place.name}</span>
                          <span className="text-xs text-gray-500 truncate">{place.address}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Search Results Section */}
                {results.length > 0 && (
                  <div>
                    <div className="px-4 py-1 text-[10px] font-bold text-gray-400 uppercase tracking-wider">תוצאות חיפוש</div>
                    {results.map((place) => (
                      <button
                        key={`res-${place.id}`}
                        onClick={() => handleSelect(place)}
                        className="w-full px-4 py-3 flex items-center gap-4 hover:bg-black/5 transition-colors text-right"
                        dir="rtl"
                      >
                        <div className="w-10 h-10 rounded-xl bg-gray-100 flex items-center justify-center text-gray-500 shrink-0 relative">
                          <MapPin size={20} />
                          {place.isLocal ? (
                            <div className="absolute -top-1 -right-1 bg-green-500 text-white rounded-full p-0.5 shadow-sm">
                              <CheckCircle2 size={10} />
                            </div>
                          ) : (
                            <div className="absolute -top-1 -right-1 bg-blue-500 text-white rounded-full p-0.5 shadow-sm">
                              <Globe size={10} />
                            </div>
                          )}
                        </div>
                        <div className="flex flex-col min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-bold text-black truncate">{place.name}</span>
                            {place.isLocal && (
                              <span className="text-[9px] font-bold text-green-600 bg-green-50 px-1.5 py-0.5 rounded-md uppercase tracking-wider shrink-0">שמור</span>
                            )}
                          </div>
                          <span className="text-xs text-gray-500 truncate">{place.address}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Google Search Results Section */}
                {googleResults.length > 0 && (
                  <div className="mt-2 border-t border-black/5 pt-2">
                    <div className="px-4 py-1 text-[10px] font-bold text-blue-500 uppercase tracking-wider">תוצאות מ-Google</div>
                    {googleResults.map((place) => (
                      <button
                        key={`google-${place.id}`}
                        onClick={() => handleSelect(place)}
                        className="w-full px-4 py-3 flex items-center gap-4 hover:bg-black/5 transition-colors text-right"
                        dir="rtl"
                      >
                        <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500 shrink-0 relative">
                          <Globe size={20} />
                        </div>
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="font-bold text-black truncate">{place.name}</span>
                          <span className="text-xs text-gray-500 truncate">{place.address}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}

                {/* Fallback Search Button */}
                {query.length > 2 && !isSearching && googleResults.length === 0 && (results.length === 0 || !hasStrongMatch) && (
                  <div className="p-2">
                    <button
                      onClick={handleGoogleSearch}
                      disabled={isGoogleSearching}
                      className="w-full px-4 py-4 flex items-center justify-center gap-3 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded-2xl transition-all group active:scale-[0.98] disabled:opacity-50 disabled:active:scale-100"
                    >
                      {isGoogleSearching ? (
                        <Loader2 className="animate-spin" size={20} />
                      ) : (
                        <Globe size={20} className="group-hover:rotate-12 transition-transform" />
                      )}
                      <span className="font-bold text-sm">חפש את "{query}" ב-Google</span>
                    </button>
                  </div>
                )}

                {results.length === 0 && filteredHistory.length === 0 && googleResults.length === 0 && !isSearching && !isGoogleSearching && query.length > 2 && (
                  <div className="p-8 text-center text-gray-400">
                    <span className="text-sm font-medium">לא נמצאו תוצאות ל-" {query} "</span>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});
