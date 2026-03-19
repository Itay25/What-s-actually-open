import React from 'react';
import { cn } from '../types';

interface RewardActionButtonProps {
  isActive: boolean;
  onToggle: () => void;
  activateText: string;
  deactivateText: string;
}

export const RewardActionButton: React.FC<RewardActionButtonProps> = React.memo(({
  isActive,
  onToggle,
  activateText,
  deactivateText
}) => {
  return (
    <button 
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className={cn(
        "text-[10px] font-bold px-3 py-1 rounded-lg transition-all active:scale-95 border",
        isActive 
          ? "bg-white text-black border-green-500 shadow-[0_0_12px_rgba(34,197,94,0.15)]" 
          : "bg-white text-black border-black/10 hover:border-black/20"
      )}
    >
      {isActive ? deactivateText : activateText}
    </button>
  );
});
