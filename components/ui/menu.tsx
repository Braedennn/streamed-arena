'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';

interface MenuProps {
  trigger: (state: { open: boolean; toggle: () => void }) => React.ReactNode;
  children: (state: { close: () => void }) => React.ReactNode;
  className?: string;
  panelClassName?: string;
  align?: 'start' | 'end';
  /**
   * Notified whenever the menu opens or closes. A parent that reveals itself
   * on hover needs this: once the menu is open it has to stay visible, even
   * when the pointer (and the keyboard focus) move away.
   */
  onOpenChange?: (open: boolean) => void;
}

export function Menu({
  trigger,
  children,
  className,
  panelClassName,
  align = 'end',
  onOpenChange,
}: MenuProps) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  const setOpenState = React.useCallback(
    (next: boolean) => {
      setOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const toggle = React.useCallback(() => setOpenState(!open), [open, setOpenState]);
  const close = React.useCallback(() => setOpenState(false), [setOpenState]);

  React.useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpenState(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenState(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, setOpenState]);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {trigger({ open, toggle })}
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              'absolute top-[calc(100%+0.6rem)] z-50 min-w-[13rem] origin-top overflow-hidden rounded-2xl border border-edge bg-void-850 p-1.5',
              align === 'end' ? 'right-0' : 'left-0',
              panelClassName,
            )}
          >
            {children({ close })}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({
  active = false,
  children,
  onClick,
  className,
}: {
  active?: boolean;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center justify-between gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-ink-200 transition-colors hover:bg-void-700 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-volt',
        active && 'bg-volt text-void font-semibold',
        className,
      )}
    >
      {children}
    </button>
  );
}
