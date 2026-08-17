import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface TouchRangeInstructionProps {
  surface: 'plan' | 'review';
  children: React.ReactNode;
  onCancel: () => void;
}

/** Temporary safe-area-aware prompt while a touch user chooses a range endpoint. */
export const TouchRangeInstruction: React.FC<TouchRangeInstructionProps> = ({
  surface,
  children,
  onCancel,
}) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel]);

  return createPortal(
    <div className="pn-visible-viewport-overlay z-[2200] pointer-events-none flex items-end justify-center">
      <div
        data-pn-touch-range-instruction={surface}
        className="pointer-events-auto flex min-h-11 max-w-full items-center gap-3 rounded-full border border-border bg-popover/95 py-1.5 pl-4 pr-1.5 text-sm text-foreground shadow-2xl backdrop-blur-xl"
      >
        <span role="status" aria-live="polite" className="truncate">{children}</span>
        <button
          type="button"
          data-pn-touch-target="true"
          onClick={onCancel}
          className="shrink-0 rounded-full px-3 text-sm text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          Cancel
        </button>
      </div>
    </div>,
    document.body,
  );
};
