'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { CalendarDays, ChevronDown, Copy, Home, Minus, Radio, Search, Square, X } from 'lucide-react';
import { Menu, MenuItem } from '@/components/ui/menu';
import { useFilters } from '@/components/providers/FilterProvider';
import { useFixtures, useSportsQuery } from '@/lib/hooks';
import { cn, FALLBACK_SPORTS } from '@/lib/utils';

const NAV_ITEMS = [
  { href: '/', label: 'Home' },
  { href: '/live', label: 'Live Now' },
  { href: '/schedule', label: 'Schedule' },
  { href: '/multistream', label: 'Multistream' },
] as const;

interface ArenaWindow {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  onState: (listener: (state: { maximized: boolean }) => void) => () => void;
}

function arenaWindow(): ArenaWindow | null {
  return (window as unknown as { arenaWindow?: ArenaWindow }).arenaWindow ?? null;
}

function WindowControls() {
  const [mounted, setMounted] = React.useState(false);
  const [maximized, setMaximized] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
    const bridge = arenaWindow();
    if (!bridge) return;
    return bridge.onState((state) => setMaximized(state.maximized));
  }, []);

  if (!mounted) return null;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <button
        type="button"
        onClick={() => arenaWindow()?.minimize()}
        className="grid h-8 w-8 place-items-center rounded-md border border-edge bg-void-850 text-ink-300 transition hover:border-edge-hi hover:text-white"
        aria-label="Minimize"
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => arenaWindow()?.toggleMaximize()}
        className="grid h-8 w-8 place-items-center rounded-md border border-edge bg-void-850 text-ink-300 transition hover:border-edge-hi hover:text-white"
        aria-label={maximized ? 'Restore' : 'Maximize'}
      >
        {maximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
      </button>
      <button
        type="button"
        onClick={() => arenaWindow()?.close()}
        className="grid h-8 w-8 place-items-center rounded-md border border-edge bg-void-850 text-ink-300 transition hover:border-flare hover:bg-flare hover:text-white"
        aria-label="Close"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  const { rawQuery, setRawQuery, sport, setSport } = useFilters();
  const liveQuery = useFixtures();
  const sportsQuery = useSportsQuery();
  const [mobileSearch, setMobileSearch] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const sports = sportsQuery.data && sportsQuery.data.length > 0 ? sportsQuery.data : FALLBACK_SPORTS;
  const liveCount = liveQuery.liveFixtures.length;

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setMobileSearch(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  const activeSportLabel =
    sports.find((entry) => entry.id === sport)?.name ?? (sport === 'all' ? 'All Sports' : sport);

  return (
    <header className="app-drag sticky top-0 z-40 border-b border-edge bg-void">
      <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
        <Link href="/" className="group flex shrink-0 items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-md border border-volt bg-volt text-void transition-transform duration-300 group-hover:scale-105">
            <Radio size={18} />
          </span>
          <span className="hidden flex-col leading-none sm:flex">
            <span className="font-display text-[15px] font-bold tracking-[0.16em] text-white">
              STREAMED
            </span>
            <span className="mt-1 text-[9px] font-semibold uppercase tracking-[0.42em] text-volt">
              Arena
            </span>
          </span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'inline-flex h-9 items-center rounded-md px-3.5 text-xs font-semibold uppercase tracking-[0.12em] transition-all duration-300',
                isActive(item.href)
                  ? 'border border-volt bg-volt text-void'
                  : 'border border-transparent text-ink-300 hover:border-edge hover:text-white',
              )}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div className="ml-1 hidden items-center gap-2 lg:flex">
          <span className="inline-flex items-center gap-2 rounded-md border border-live bg-live px-3 py-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-void">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-pulse-live rounded-full bg-void-950" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-void-950" />
            </span>
            {liveCount} live
          </span>
        </div>

        <div className="relative ml-auto hidden w-full max-w-sm md:block">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
          <input
            ref={inputRef}
            value={rawQuery}
            onChange={(event) => setRawQuery(event.target.value)}
            placeholder="Search teams, leagues, events..."
            className="h-10 w-full rounded-md border border-edge bg-void-850 pl-10 pr-16 text-sm text-white placeholder:text-ink-500 transition-all duration-300 outline-none focus:border-volt focus:bg-void-800"
          />
          {rawQuery ? (
            <button
              type="button"
              onClick={() => setRawQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-400 transition hover:text-white"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <kbd className="pointer-events-none absolute right-3 top-1/2 hidden -translate-y-1/2 rounded-md border border-edge bg-void-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-400 lg:block">
              ⌘K
            </kbd>
          )}
        </div>

        <Menu
          align="start"
          className="hidden lg:block"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className="ml-auto flex h-10 items-center gap-2 rounded-md border border-edge bg-void-850 px-3.5 text-sm text-ink-200 transition-all hover:border-edge-hi hover:text-white lg:ml-0"
            >
              <span className="max-w-[9rem] truncate">{activeSportLabel}</span>
              <ChevronDown
                className={cn('h-4 w-4 transition-transform duration-300', open && 'rotate-180')}
              />
            </button>
          )}
        >
          {({ close }) => (
            <div className="max-h-80 overflow-y-auto">
              <MenuItem
                active={sport === 'all'}
                onClick={() => {
                  setSport('all');
                  close();
                }}
              >
                All Sports
                {sport === 'all' ? <Dot /> : null}
              </MenuItem>
              {sports.map((entry) => (
                <MenuItem
                  key={entry.id}
                  active={sport === entry.id}
                  onClick={() => {
                    setSport(entry.id);
                    close();
                  }}
                >
                  <span className="truncate">{entry.name}</span>
                  {sport === entry.id ? <Dot /> : null}
                </MenuItem>
              ))}
            </div>
          )}
        </Menu>

        <button
          type="button"
          onClick={() => setMobileSearch((value) => !value)}
          aria-label="Toggle search"
          className="ml-auto grid h-10 w-10 place-items-center rounded-md border border-edge bg-void-850 text-ink-300 transition hover:text-white md:hidden"
        >
          {mobileSearch ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
        </button>

        <Link
          href="/live"
          className="inline-flex items-center gap-2 rounded-md border border-live bg-live px-2.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.14em] text-void md:hidden"
        >
          <span className="h-1.5 w-1.5 rounded-full bg-void-950" />
          {liveCount}
        </Link>

        <WindowControls />
      </div>

      <nav className="flex items-center gap-2 overflow-x-auto border-t border-edge bg-void px-4 py-2 no-scrollbar md:hidden">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              'inline-flex h-8 shrink-0 items-center rounded-md px-3 text-[11px] font-semibold uppercase tracking-[0.12em] transition-all',
              isActive(item.href)
                ? 'border border-volt bg-volt text-void'
                : 'border border-edge bg-void-850 text-ink-300',
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <AnimatePresence>
        {mobileSearch ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden md:hidden"
          >
            <div className="relative px-4 pb-3 pt-2">
              <Search className="pointer-events-none absolute left-7 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
              <input
                autoFocus
                value={rawQuery}
                onChange={(event) => setRawQuery(event.target.value)}
                placeholder="Search teams, leagues, events..."
                className="h-11 w-full rounded-md border border-edge bg-void-850 pl-10 pr-4 text-sm text-white placeholder:text-ink-500 outline-none focus:border-volt"
              />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  );
}

function Dot() {
  return <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-void-950" />;
}
