import React, { useEffect } from 'react';
import { Marker } from 'react-leaflet';
import L from 'leaflet';
import { motion, AnimatePresence } from 'motion/react';
import { createPortal } from 'react-dom';
import { Place } from '../types';
import { 
  ShoppingCart, Coffee, Utensils, Pill, Fuel, 
  Croissant, Store, Building2, CreditCard, MapPin, Ticket,
  Beer, Bike, MoreHorizontal
} from 'lucide-react';

interface BusinessMarkerProps {
  place: Place;
  isActive: boolean;
  zoom: number;
  showLabel: boolean;
  labelType?: 'none' | 'short' | 'full';
  isDimmed?: boolean;
  isLabelDimmed?: boolean;
  onClick: (place: Place) => void;
}

const colors = {
  active: '#28CD41', // Green
  unknown: '#A0A0A0', // Gray
  closed: '#FF3B30', // Red
  closing_soon: '#99CC33', // Yellow-Green
  maybe: '#FFCC00', // Yellow
  dimmed: '#D1D1D1',
};

const shortenName = (name: string) => {
  if (!name) return "";
  
  // 1. Split by common separators like dash, comma, or "–"
  const parts = name.split(/[-–,]/);
  let mainPart = parts[0].trim();
  
  // 2. If the main part is still too long, truncate it
  const MAX_LENGTH = 18;
  if (mainPart.length > MAX_LENGTH) {
    return mainPart.substring(0, MAX_LENGTH) + "...";
  }
  
  return mainPart;
};

export const BusinessMarker = React.memo(({ place, isActive, zoom, showLabel, labelType = 'none', isDimmed, isLabelDimmed, onClick }: BusinessMarkerProps) => {
  const color = isDimmed ? colors.dimmed : colors[place.status || 'unknown'];
  const markerRef = React.useRef<L.Marker>(null);
  const [iconContainer, setIconContainer] = React.useState<HTMLElement | null>(null);
  
  // Adaptive sizing based on zoom and dimmed state
  let size = 32;
  if (isDimmed) {
    size = 6;
  } else {
    if (zoom < 14) size = 10;
    else if (zoom < 16) size = 20;
  }
  
  const showIcon = zoom >= 15 && !isDimmed;
  const isDistant = zoom < 14 || isDimmed;

  const icon = React.useMemo(() => {
    return L.divIcon({
      html: `<div class="marker-portal-container" id="marker-portal-${place.id}"></div>`,
      className: 'custom-marker-container',
      iconSize: [size, size],
      iconAnchor: [size/2, size/2],
    });
  }, [place.id, size]);

  // We need to wait for the marker to be added to the map to find the portal container
  useEffect(() => {
    const timer = setTimeout(() => {
      const el = document.getElementById(`marker-portal-${place.id}`);
      if (el) setIconContainer(el);
    }, 0);
    return () => clearTimeout(timer);
  }, [place.id, icon]);

  const eventHandlers = React.useMemo(() => {
    if (isDimmed) return {};
    return { click: () => onClick(place) };
  }, [isDimmed, onClick, place]);

  return (
    <>
      <Marker
        ref={markerRef}
        position={[place.lat, place.lng]}
        icon={icon}
        eventHandlers={eventHandlers}
        zIndexOffset={isActive ? 2000 : (isDimmed ? -1000 : 1000)}
        interactive={!isDimmed}
      />
      {iconContainer && createPortal(
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ 
            opacity: isDimmed ? 0.4 : 1, 
            scale: isActive ? 1.25 : 1,
            backgroundColor: color,
            transition: { 
              type: 'spring', 
              stiffness: 120, 
              damping: 20,
              backgroundColor: { duration: 0.5 } // Smooth color transition
            }
          }}
          exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.2 } }}
          className="relative flex items-center cursor-pointer pointer-events-auto rounded-full"
          style={{ 
            width: `${size}px`, 
            height: `${size}px`,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onClick(place);
          }}
        >
          {/* Icon Part */}
          <div 
            className={`w-full h-full rounded-full shadow-lg flex items-center justify-center relative z-10 shrink-0 pointer-events-none`} 
            style={{ 
              boxShadow: isDimmed ? 'none' : '0 0 0 2px white, 0 2px 8px rgba(0,0,0,0.3)'
            }}
          >
            {showIcon && !isDistant && (
              <div className="text-white flex items-center justify-center">
                {getIconSvg(place.category)}
              </div>
            )}
          </div>

          {/* Label Part */}
          {showLabel && !isDistant && !isDimmed && labelType !== 'none' && (
            <div 
              className={`mr-1 flex flex-col pointer-events-none px-2 py-1 rounded-lg transition-opacity duration-300 ${isLabelDimmed ? 'opacity-40' : 'opacity-100'}`}
              style={{ 
                textShadow: '0 0 4px white, 0 0 4px white, 0 0 4px white, 0 0 4px white, 0 0 8px white' 
              }}
            >
              <span className="text-[13px] font-bold text-black leading-none whitespace-nowrap tracking-tight">
                {shortenName(place.name)}
              </span>
              {labelType === 'full' && (
                <span className="text-[10px] font-medium text-gray-600 leading-tight whitespace-nowrap mt-0.5">
                  {place.category}
                </span>
              )}
            </div>
          )}
        </motion.div>,
        iconContainer
      )}
    </>
  );
}, (prevProps, nextProps) => {
  return (
    prevProps.isActive === nextProps.isActive &&
    prevProps.zoom === nextProps.zoom &&
    prevProps.showLabel === nextProps.showLabel &&
    prevProps.labelType === nextProps.labelType &&
    prevProps.isDimmed === nextProps.isDimmed &&
    prevProps.isLabelDimmed === nextProps.isLabelDimmed &&
    prevProps.place.id === nextProps.place.id &&
    prevProps.place.status === nextProps.place.status &&
    prevProps.place.isFallback === nextProps.place.isFallback &&
    prevProps.place.reportsOpen === nextProps.place.reportsOpen &&
    prevProps.place.reportsClosed === nextProps.place.reportsClosed &&
    prevProps.place.lastReportTime === nextProps.place.lastReportTime
  );
});

function getIconSvg(category: string) {
  const iconSize = 14;
  const strokeWidth = 3;

  if (category.includes('סופר') || category.includes('מכולת')) return <ShoppingCart size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('קפה')) return <Coffee size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('מסעד')) return <Utensils size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('מרקחת')) return <Pill size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('דלק')) return <Fuel size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('מאפ')) return <Croissant size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('קיוסק')) return <Store size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('בנק')) return <Building2 size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('כספומט')) return <CreditCard size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('אטרקציות')) return <Ticket size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('לילה') || category.includes('בר')) return <Beer size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('פעיל')) return <Bike size={iconSize} strokeWidth={strokeWidth} />;
  if (category.includes('אחר')) return <MoreHorizontal size={iconSize} strokeWidth={strokeWidth} />;
  return <MapPin size={iconSize} strokeWidth={strokeWidth} />;
}
