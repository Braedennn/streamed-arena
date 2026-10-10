'use client';

import * as React from 'react';
import { CalendarClock, Maximize, Minimize, Plus, Search, Signal, X } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Menu, MenuItem } from '@/components/ui/menu';
import { SafeImage } from '@/components/media/SafeImage';
import { HlsPlayer } from '@/components/arena/HlsPlayer';
import { IframePlayer } from '@/components/arena/IframePlayer';
import { badgeUrl, isHlsUrl } from '@/lib/api';
import { useFixtures, useMatchStreams, useSportsQuery, useStreamSelection } from '@/lib/hooks';
import { cn, FALLBACK_SPORTS, initials, kickoffParts, slugSource, splitTitle, sportName, streamKey } from '@/lib/utils';
import type { Fixture, Sport, StreamDto } from '@/lib/types';

const SLOT_COUNT = 4;
const STORAGE_KEY = 'streamed-arena.multistream';

type Slots = readonly (string | null)[];

export function MultiStream() {
  const fixturesState = useFixtures();
  const sportsQuery = useSportsQuery();
  const [slots, setSlots] = React.useState<Slots>([null, null, null, null]);
  const [pickerSlot, setPickerSlot] = React.useState<number | null>(null);
  const [rawQuery, setRawQuery] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [restored, setRestored] = React.useState(false);
  // iPhone has no element fullscreen; hide the button rather than leave it dead.
  const [canFullscreen, setCanFullscreen] = React.useState(true);
  React.useEffect(() => setCanFullscreen(document.fullscreenEnabled), []);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLDivElement>(null);

  const sports = sportsQuery.data && sportsQuery.data.length > 0 ? sportsQuery.data : FALLBACK_SPORTS;

  React.useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length === SLOT_COUNT) {
        setSlots(parsed.map((entry) => (typeof entry === 'string' ? entry : null)));
      }
    } catch {
    }
    setRestored(true);
  }, []);

  // Only persist once the saved wall has been read back, so the initial empty
  // state can never overwrite it.
  React.useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(slots));
    } catch {
    }
  }, [slots, restored]);

  // Saved matches that have since dropped off the feed used to linger as
  // invisible "filled" screens (wrong 3/4 count, blank tile in fullscreen,
  // search-to-add skipping them). Free those screens once both feeds are in.
  const { isReady, allFixtures } = fixturesState;
  React.useEffect(() => {
    if (!restored || !isReady) return;
    const known = new Set(allFixtures.map((fixture) => fixture.id));
    setSlots((previous) =>
      previous.some((entry) => entry !== null && !known.has(entry))
        ? previous.map((entry) => (entry !== null && known.has(entry) ? entry : null))
        : previous,
    );
  }, [restored, isReady, allFixtures]);

  React.useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  React.useEffect(() => {
    if (!searchOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) setSearchOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSearchOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [searchOpen]);

  const filled = slots.filter((entry) => entry !== null).length;
  const slotEntries = slots.map((fixtureId, index) => ({ fixtureId, index }));
  const visibleSlots = fullscreen ? slotEntries.filter((entry) => entry.fixtureId !== null) : slotEntries;

  const toggleFullscreen = React.useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void gridRef.current?.requestFullscreen?.();
    }
  }, []);

  const assign = React.useCallback((index: number, fixtureId: string) => {
    setSlots((previous) => previous.map((entry, position) => (position === index ? fixtureId : entry)));
  }, []);

  const assignToFirstFree = React.useCallback((fixtureId: string) => {
    setSlots((previous) => {
      const free = previous.findIndex((entry) => entry === null);
      if (free === -1) return previous;
      return previous.map((entry, position) => (position === free ? fixtureId : entry));
    });
  }, []);

  const clear = React.useCallback((index: number) => {
    setSlots((previous) => previous.map((entry, position) => (position === index ? null : entry)));
  }, []);

  const query = rawQuery.trim().toLowerCase();
  const results = React.useMemo(() => {
    if (!query) return [];
    const taken = new Set(slots.filter((entry): entry is string => entry !== null));
    const seen = new Set<string>();
    const merged: Fixture[] = [];
    for (const fixture of [...fixturesState.liveFixtures, ...fixturesState.inPlayFixtures, ...fixturesState.upcomingFixtures]) {
      if (seen.has(fixture.id) || taken.has(fixture.id)) continue;
      seen.add(fixture.id);
      const haystack = `${fixture.title} ${fixture.home?.name ?? ''} ${fixture.away?.name ?? ''}`.toLowerCase();
      if (!haystack.includes(query)) continue;
      merged.push(fixture);
      if (merged.length >= 8) break;
    }
    return merged;
  }, [query, slots, fixturesState.liveFixtures, fixturesState.inPlayFixtures, fixturesState.upcomingFixtures]);

  return (
    <div className="flex flex-col gap-5 pb-20 pt-6 sm:pt-9">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="font-display text-xl font-bold tracking-tight text-white sm:text-2xl">
            Multistream
          </h1>
          <p className="mt-1 text-xs text-ink-400">
            Pick up to four live feeds and watch them side by side — fullscreen to spread the wall.
          </p>
        </div>
        <span className="inline-flex items-center gap-2 rounded-md border border-edge bg-void-850 px-3 py-2 font-mono text-[11px] font-bold text-ink-300">
          {filled}/{SLOT_COUNT} streams
        </span>
        {canFullscreen ? (
          <button
            type="button"
            onClick={toggleFullscreen}
            disabled={filled === 0}
            className="inline-flex h-10 items-center gap-2 rounded-md border border-live bg-live px-4 text-xs font-bold uppercase tracking-[0.14em] text-void transition hover:bg-live-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-live"
          >
            {fullscreen ? <Minimize className="h-4 w-4" /> : <Maximize className="h-4 w-4" />}
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        ) : null}
      </div>

      <div ref={searchRef} className="relative">
        <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
        <input
          value={rawQuery}
          onChange={(event) => {
            setRawQuery(event.target.value);
            setSearchOpen(true);
          }}
          onFocus={() => setSearchOpen(true)}
          placeholder="Search or add a new stream"
          className="h-11 w-full rounded-md border border-edge bg-void-850 pl-10 pr-10 text-sm text-white placeholder:text-ink-500 outline-none transition focus:border-volt focus:bg-void-800"
        />
        {rawQuery ? (
          <button
            type="button"
            onClick={() => {
              setRawQuery('');
              setSearchOpen(false);
            }}
            className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1 text-ink-400 transition hover:text-white"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}

        {searchOpen && query && filled === SLOT_COUNT ? (
          <p className="absolute inset-x-0 top-[calc(100%+0.5rem)] z-50 rounded-md border border-edge bg-void-850 px-4 py-3 text-xs text-ink-300">
            All {SLOT_COUNT} screens are in use — remove one to add another stream.
          </p>
        ) : searchOpen && query && results.length === 0 ? (
          <p className="absolute inset-x-0 top-[calc(100%+0.5rem)] z-50 rounded-md border border-edge bg-void-850 px-4 py-3 text-xs text-ink-400">
            No matches found for “{rawQuery.trim()}”.
          </p>
        ) : searchOpen && results.length > 0 ? (
          <div className="absolute inset-x-0 top-[calc(100%+0.5rem)] z-50 overflow-hidden rounded-2xl border border-edge bg-void-850 p-1.5 shadow-none">
            {results.map((fixture) => (
              <FixtureRow
                key={fixture.id}
                fixture={fixture}
                sports={sports}
                onClick={() => {
                  assignToFirstFree(fixture.id);
                  setSearchOpen(false);
                  setRawQuery('');
                }}
              />
            ))}
          </div>
        ) : null}
      </div>

      <div
        ref={gridRef}
        className={cn(
          'grid',
          fullscreen
            ? cn(
                'h-screen w-full bg-black',
                filled === 1
                  ? 'grid-cols-1 grid-rows-1'
                  : filled === 2
                    ? 'grid-cols-2 grid-rows-1'
                    : 'grid-cols-2 grid-rows-2',
              )
            : 'grid-cols-1 gap-4 lg:grid-cols-2',
        )}
      >
        {visibleSlots.map(({ fixtureId, index }) => (
          <MultiStreamSlot
            key={index}
            index={index}
            fixtureId={fixtureId}
            fixtures={fixturesState.allFixtures}
            fullscreen={fullscreen}
            onPick={() => setPickerSlot(index)}
            onClear={() => clear(index)}
          />
        ))}
      </div>

      <PickerDialog
        slot={pickerSlot}
        slots={slots}
        fixturesState={fixturesState}
        sports={sports}
        onPick={assign}
        onClose={() => setPickerSlot(null)}
      />
    </div>
  );
}

function MultiStreamSlot({
  index,
  fixtureId,
  fixtures,
  fullscreen,
  onPick,
  onClear,
}: {
  index: number;
  fixtureId: string | null;
  fixtures: readonly Fixture[];
  fullscreen: boolean;
  onPick: () => void;
  onClear: () => void;
}) {
  const fixture = React.useMemo(
    () => (fixtureId ? fixtures.find((entry) => entry.id === fixtureId) ?? null : null),
    [fixtures, fixtureId],
  );
  const streamsQuery = useMatchStreams(fixture?.sources ?? [], Boolean(fixture));
  const streams = React.useMemo(() => streamsQuery.data ?? [], [streamsQuery.data]);
  const { groups, source, selectedKey, selectSource, selectStream } = useStreamSelection(
    streams,
    fixture?.id,
  );
  const selectedStream =
    streams.find((stream) => streamKey(stream.source, stream.streamNo, stream.id) === selectedKey) ?? null;
  const effectiveUrl = selectedStream?.embedUrl ?? '';
  const useHls = Boolean(effectiveUrl) && isHlsUrl(effectiveUrl);

  if (!fixture) {
    return (
      <button
        type="button"
        onClick={onPick}
        className={cn(
          'group grid place-items-center rounded-2xl border border-dashed border-edge bg-void-950 text-center transition-colors duration-300 hover:border-edge-hi hover:bg-void-850',
          fullscreen ? 'h-full w-full' : 'aspect-video w-full',
        )}
      >
        <span className="space-y-2 px-6">
          <Plus className="mx-auto h-8 w-8 text-ink-500 transition-colors group-hover:text-ink-300" />
          <span className="block text-sm font-semibold text-ink-200">Click to add stream</span>
          <span className="block text-xs text-ink-500">
            You can add up to 4 streams to watch at the same time.
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className={cn('group/slot relative min-w-0', fullscreen ? 'h-full w-full' : 'aspect-video w-full')}>
      <div
        className={cn(
          'absolute inset-0 overflow-hidden',
          fullscreen ? 'bg-black' : 'rounded-2xl border border-edge bg-void-950',
        )}
      >
        {streamsQuery.isPending && streams.length === 0 ? (
          <div className="absolute inset-0 grid place-items-center">
            <p className="text-[11px] uppercase tracking-[0.24em] text-ink-500">Resolving streams</p>
          </div>
        ) : streams.length === 0 ? (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <div className="space-y-2">
              <p className="text-sm font-semibold text-white">{fixture.title}</p>
              <p className="text-xs text-ink-400">
                {fixture.status === 'upcoming'
                  ? 'Not started yet — the feed opens at kick-off.'
                  : 'No streams available right now.'}
              </p>
              <button
                type="button"
                onClick={() => void streamsQuery.refetch()}
                className="rounded-md border border-edge px-3 py-1.5 text-[11px] text-ink-200 transition hover:text-white"
              >
                Retry
              </button>
            </div>
          </div>
        ) : !effectiveUrl ? (
          <div className="absolute inset-0 grid place-items-center px-6 text-center">
            <p className="text-xs text-ink-400">No playable channel — pick a stream from the signal menu.</p>
          </div>
        ) : useHls ? (
          <HlsPlayer src={effectiveUrl} />
        ) : (
          <IframePlayer src={effectiveUrl} title={`${fixture.title} — screen ${index + 1}`} reloadToken={0} />
        )}
      </div>

      <div className="absolute right-2 top-2 z-30 flex max-w-[calc(100%-3.5rem)] items-center gap-1.5 opacity-0 transition-opacity duration-200 focus-within:opacity-100 group-hover/slot:opacity-100 [@media(hover:none)]:opacity-100">
        <span className="min-w-0 truncate rounded-md border border-edge bg-void-950 px-2 py-1 text-[11px] font-semibold leading-none text-ink-200">
          {fixture.title}
        </span>
        <Menu
          align="end"
          panelClassName="max-h-72 w-64"
          trigger={({ open, toggle }) => (
            <button
              type="button"
              onClick={toggle}
              aria-expanded={open}
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-edge bg-void-950 text-ink-300 transition hover:text-white"
              aria-label="Switch channel"
            >
              <Signal className={cn('h-3 w-3', open && 'text-volt')} />
            </button>
          )}
        >
          {({ close }) => (
            <div className="max-h-72 overflow-y-auto">
              {groups.map((group) => (
                <React.Fragment key={group.source}>
                  <p className="px-3 pb-1 pt-2 text-[9px] font-bold uppercase tracking-[0.2em] text-ink-500">
                    {slugSource(group.source)}
                  </p>
                  {group.streams.map((stream: StreamDto) => {
                    const key = streamKey(stream.source, stream.streamNo, stream.id);
                    return (
                      <MenuItem
                        key={key}
                        active={key === selectedKey}
                        onClick={() => {
                          selectStream(key);
                          close();
                        }}
                      >
                        <span className="truncate">
                          #{stream.streamNo} · {stream.language}
                        </span>
                        {stream.hd ? <Badge variant="live">HD</Badge> : null}
                      </MenuItem>
                    );
                  })}
                </React.Fragment>
              ))}
              {groups.length > 1 ? (
                <MenuItem
                  onClick={() => {
                    const currentIndex = groups.findIndex((group) => group.source === source);
                    const next = groups[(currentIndex + 1) % groups.length];
                    if (next) selectSource(next.source);
                    close();
                  }}
                >
                  Cycle server
                </MenuItem>
              ) : null}
            </div>
          )}
        </Menu>

        <button
          type="button"
          onClick={onClear}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-edge bg-void-950 text-ink-300 transition hover:border-flare hover:text-flare"
          aria-label={`Remove ${fixture.title} from screen ${index + 1}`}
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

function PickerDialog({
  slot,
  slots,
  fixturesState,
  sports,
  onPick,
  onClose,
}: {
  slot: number | null;
  slots: Slots;
  fixturesState: ReturnType<typeof useFixtures>;
  sports: readonly Sport[];
  onPick: (index: number, fixtureId: string) => void;
  onClose: () => void;
}) {
  const [rawQuery, setRawQuery] = React.useState('');
  const open = slot !== null;

  React.useEffect(() => {
    if (open) setRawQuery('');
  }, [open, slot]);

  if (!open) return null;

  const query = rawQuery.trim().toLowerCase();
  const taken = new Set(slots.filter((entry): entry is string => entry !== null));
  const pool: Fixture[] = [
    ...fixturesState.liveFixtures,
    ...fixturesState.inPlayFixtures,
    ...fixturesState.upcomingFixtures,
  ].filter((fixture) => !taken.has(fixture.id));

  const results = pool.filter((fixture) => {
    if (!query) return true;
    const haystack = `${fixture.title} ${fixture.home?.name ?? ''} ${fixture.away?.name ?? ''}`.toLowerCase();
    return haystack.includes(query);
  });

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-3xl">
        <header className="shrink-0 border-b border-edge bg-void-800 px-4 py-3.5 sm:px-6 sm:pt-5">
          <DialogTitle>Add stream — screen {(slot ?? 0) + 1}</DialogTitle>
          <DialogDescription className="mt-1">
            {results.length} available feed{results.length === 1 ? '' : 's'} · live matches first
          </DialogDescription>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <div className="relative mb-4">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-400" />
            <input
              autoFocus
              value={rawQuery}
              onChange={(event) => setRawQuery(event.target.value)}
              placeholder="Search teams, leagues, events..."
              className="h-10 w-full rounded-md border border-edge bg-void-950 pl-10 pr-4 text-sm text-white placeholder:text-ink-500 outline-none focus:border-volt"
            />
          </div>

          {fixturesState.isLoading && results.length === 0 ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }, (_, index) => (
                <div key={index} className="skeleton h-14 w-full rounded-md" />
              ))}
            </div>
          ) : results.length === 0 ? (
            <p className="py-10 text-center text-sm text-ink-400">
              No feeds found{query ? ' for that search' : ' yet — check back closer to kick-off'}.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
              {results.map((fixture) => (
                <FixtureRow
                  key={fixture.id}
                  fixture={fixture}
                  sports={sports}
                  onClick={() => {
                    onPick(slot ?? 0, fixture.id);
                    onClose();
                  }}
                />
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function FixtureRow({
  fixture,
  sports,
  onClick,
}: {
  fixture: Fixture;
  sports: readonly Sport[];
  onClick: () => void;
}) {
  const fallback = splitTitle(fixture.title);
  const kickoff = kickoffParts(fixture.date, Date.now());

  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 rounded-md border border-edge bg-void-900 px-3 py-2.5 text-left transition-all duration-300 hover:border-edge-hi hover:bg-void-800"
    >
      <span className="flex shrink-0 -space-x-2">
        {[fixture.home, fixture.away].map((team, index) => (
          <span
            key={index}
            className="grid h-9 w-9 place-items-center rounded-md border border-edge bg-void-800 p-1"
          >
            <SafeImage
              src={badgeUrl(team?.badge ?? null)}
              alt={team?.name ?? (index === 0 ? fallback.home : fallback.away)}
              width={28}
              height={28}
              fallbackText={initials(team?.name ?? (index === 0 ? fallback.home : fallback.away))}
            />
          </span>
        ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-white">{fixture.title}</span>
        <span className="mt-0.5 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-ink-400">
          {sportName(fixture.category, sports)}
          {fixture.status === 'live' ? (
            <span className="font-bold text-live">Live</span>
          ) : fixture.status === 'upcoming' ? (
            <>
              <CalendarClock className="h-3 w-3" />
              {kickoff.dayLabel !== 'Today' ? `${kickoff.dayLabel} ` : ''}
              {kickoff.timeLabel}
            </>
          ) : fixture.status === 'in-play' ? (
            <span className="text-volt">In play</span>
          ) : null}
        </span>
      </span>
      <Plus className="h-4 w-4 shrink-0 text-ink-500 transition-colors group-hover:text-live" />
    </button>
  );
}
