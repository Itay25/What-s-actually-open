import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Sparkles, AlertCircle, CheckCircle2, XCircle, Clock, HelpCircle } from 'lucide-react';
import { cn, LiveCheckResult } from '../types';
import { auth } from '../firebase';
import { isLiveCheckValid } from '../utils/liveCheck';

interface LiveCheckButtonProps {
  hasImage?: boolean;
  placeId: string;
  placeName: string;
  city?: string;
  address?: string;
  openingHours?: any;
  lastCheckedAt?: number;
  onResult?: (result: LiveCheckResult) => void;
  dailyLimitReached?: boolean;
}

const LOADING_PHRASES = [
  "מעבד בקשה...",
  "מחפש נתונים ברשת...",
  "מנתח תשובות...",
  "מגבש מסקנה..."
];

export const LiveCheckButton = ({ 
  hasImage = true,
  placeId,
  placeName,
  city,
  address,
  openingHours,
  lastCheckedAt,
  onResult,
  dailyLimitReached = false
}: LiveCheckButtonProps) => {
  const [status, setStatus] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [apiResponse, setApiResponse] = useState<LiveCheckResult | null>(null);
  const [phraseIndex, setPhraseIndex] = useState(0);

  // 1. Fix State Bleeding: Reset when placeId changes
  useEffect(() => {
    setStatus('idle');
    setApiResponse(null);
    setPhraseIndex(0);
  }, [placeId]);

  // 2. Animated Cycling Text
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (status === 'loading') {
      interval = setInterval(() => {
        setPhraseIndex((prev) => (prev + 1) % LOADING_PHRASES.length);
      }, 2000);
    }
    return () => clearInterval(interval);
  }, [status]);

  const isRecentlyChecked = isLiveCheckValid({ id: placeId, liveCheckResult: { checkedAt: lastCheckedAt } } as any);

  const handleCheck = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (status === 'loading' || status === 'success' || isRecentlyChecked || dailyLimitReached) return;

    setStatus('loading');
    
    try {
      const userId = auth.currentUser?.uid || 'anonymous';
      const email = auth.currentUser?.email || null;
      const response = await fetch('/live-check', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          placeId,
          placeName,
          city,
          address,
          openingHours,
          userId,
          email
        }),
      });

      if (response.status === 429) {
        setStatus('idle');
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to perform live check');
      }

      const data = await response.json();
      setApiResponse(data);
      setStatus('success');
      if (onResult) {
        onResult(data);
      }
    } catch (error: any) {
      console.error('Live check error:', error);
      setStatus('error');
      // Reset to idle after a few seconds so user can try again
      setTimeout(() => setStatus('idle'), 3000);
    }
  };

  return (
    <button
      onClick={handleCheck}
      disabled={status === 'loading' || status === 'success' || !!isRecentlyChecked || dailyLimitReached}
      className={cn(
        "absolute bottom-3 left-3 flex-shrink-0 border backdrop-blur-md transition-all duration-300 ease-in-out flex flex-col items-center justify-center gap-0.5 overflow-hidden shadow-[0_4px_12px_rgba(0,0,0,0.05)]",
        status === 'loading' 
          ? "h-12 px-4 min-w-[140px] rounded-full" 
          : "h-12 md:h-14 min-w-max px-4 rounded-full",
        // Neutral Status Colors
        status === 'idle' && !isRecentlyChecked && !dailyLimitReached ? "bg-white/50 hover:bg-white/70 active:scale-95 cursor-pointer border-white/30" : 
        status === 'loading' ? "bg-white/30 cursor-default border-white/20" :
        (status === 'success' || isRecentlyChecked || dailyLimitReached) ? "bg-gray-100/50 border-gray-300/30 cursor-not-allowed opacity-80" :
        "bg-red-50/50 cursor-pointer border-red-500/30",
        !hasImage && "bottom-4 left-4"
      )}
    >
      <div className="relative flex items-center justify-center">
        <motion.div
          animate={status === 'loading' ? { 
            rotate: [0, 15, -15, 0],
            scale: [1, 1.2, 1]
          } : {}}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          {status === 'error' ? (
            <AlertCircle size={15} className="text-red-500" />
          ) : (status === 'success' || isRecentlyChecked) ? (
            <Clock size={15} className="text-gray-400" />
          ) : dailyLimitReached ? (
            <HelpCircle size={15} className="text-gray-400" />
          ) : (
            <Sparkles size={15} className={cn(
              "transition-colors duration-500",
              status === 'loading' ? "text-amber-500" : "text-black/60"
            )} />
          )}
        </motion.div>
        
        {status === 'loading' && (
          <motion.div
            className="absolute inset-0 bg-amber-400/20 rounded-full blur-sm"
            animate={{ scale: [1, 2, 1], opacity: [0.5, 0, 0.5] }}
            transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          />
        )}
      </div>

      <div className="flex flex-col items-center w-full px-1">
        <AnimatePresence mode="wait">
          <motion.span
            key={status === 'loading' ? phraseIndex : status}
            initial={{ opacity: 0, y: 2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -2 }}
            className={cn(
              "text-[7px] md:text-[8px] font-bold tracking-tight transition-colors duration-500 text-center leading-[1.1] truncate w-full",
              status === 'error' ? "text-red-600" : "text-black/70"
            )}
          >
            {status === 'idle' && (
              dailyLimitReached ? "מכסה יומית נוצלה" :
              isRecentlyChecked ? "נבדק לאחרונה" : "בדיקה בזמן אמת"
            )}
            {status === 'loading' && LOADING_PHRASES[phraseIndex]}
            {status === 'success' && "נבדק לאחרונה"}
            {status === 'error' && "שגיאה"}
          </motion.span>
        </AnimatePresence>
      </div>

      {status === 'loading' && (
        <motion.div
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white/40 to-transparent -skew-x-12"
          initial={{ x: '-150%' }}
          animate={{ x: '150%' }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "linear" }}
        />
      )}
      
      {status === 'idle' && !isRecentlyChecked && (
        <motion.div
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -skew-x-12"
          initial={{ x: '-150%' }}
          animate={{ x: '150%' }}
          transition={{ duration: 3, repeat: Infinity, ease: "linear", delay: 1 }}
        />
      )}
    </button>
  );
};
