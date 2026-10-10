'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { CalendarDays, Radar, RefreshCw, SearchX } from 'lucide-react';
import { Badge, LivePill } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionHeading } from '@/components/ui/panel';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { EmptyState } from '@/components/fixtures/EmptyState';
import { MatchCard } from '@/components/fixtures/MatchCard';
import { MatchCardSkeletons } from '@/components/fixtures/Skeletons';
import { SportsShelf } from '@/components/fixtures/SportsShelf';
import { useStreamPreviews } from '@/lib/hooks';
import { cn } from '@/lib/utils';
import type { Fixture, Sport } from '@/lib/types';

export type FixtureTab = 'live' | 'upcoming';
export type Density = 'comfortable' | 'compact';

interface FixtureHubProps {
  live: readonly Fixture[];
  inPlay: readonly Fixture[];
  upcoming: readonly Fixture[];
  sports: readonly Sport[];
  activeSport: string;
  onSportChange: (value: string) => void;
  query: string;
  onClearQuery: () => void;
  tab: FixtureTab;
  onTabChange: (value: FixtureTab) => void;
  density: Density;
  isLoading: boolean;
  isFetching: boolean;
  isError: boolean;
  onRefresh: () => void;
  onWatch: (fixture: Fixture) => void;
}

export function FixtureHub({
  live,
  inPlay,
  upcoming,
  sports,
  activeSport,
  onSportChange,
  query,
  onClearQuery,
  tab,
  onTabChange,
  density,
  isLoading,
  isFetching,
  isError,
  onRefresh,
  onWatch,
}: FixtureHubProps) {
  const matchesQuery = query.trim().toLowerCase();

  const matchesSearch = React.useCallback(
    (fixture: Fixture) => {
      if (!matchesQuery) return true;
      const haystack = `${fixture.title} ${fixture.home?.name ?? ''} ${fixture.away?.name ?? ''}`.toLowerCase();
      return haystack.includes(matchesQuery);
    },
    [matchesQuery],
  );

  const matchesFilters = React.useCallback(
    (fixture: Fixture) => {
      if (activeSport !== 'all' && fixture.category !== activeSport) return false;
      return matchesSearch(fixture);
    },
    [activeSport, matchesSearch],
  );

  const filteredLive = React.useMemo(() => {
    const seen = new Set<string>();
    const merged: Fixture[] = [];
    for (const fixture of [...live, ...inPlay]) {
      if (seen.has(fixture.id)) continue;
      seen.add(fixture.id);
      if (matchesFilters(fixture)) merged.push(fixture);
    }
    return merged;
  }, [live, inPlay, matchesFilters]);

  const onAirCount = React.useMemo(
    () => live.filter(matchesFilters).length,
    [live, matchesFilters],
  );

  const filteredUpcoming = React.useMemo(
    () => upcoming.filter(matchesFilters),
    [upcoming, matchesFilters],
  );

  const counts = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const fixture of [...live, ...inPlay, ...upcoming]) {
      if (!matchesSearch(fixture)) continue;
      map[fixture.category] = (map[fixture.category] ?? 0) + 1;
    }
    return map;
  }, [live, inPlay, upcoming, matchesSearch]);

  const previews = useStreamPreviews(tab === 'live' ? filteredLive : [], 8);

  const totalActive = filteredLive.length + filteredUpcoming.length;

  return (
    <section className="space-y-6">
      <SectionHeading
        eyebrow="Realtime board"
        title="Fixture Hub"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden items-center gap-2 rounded-md border border-edge bg-void-850 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-ink-400 sm:inline-flex">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  isFetching ? 'animate-pulse-live bg-volt-400' : 'bg-live',
                )}
              />
              {isFetching ? 'Syncing' : 'Live sync'} · 15s
            </span>
            <Button variant="ghost" size="sm" onClick={onRefresh} aria-label="Refresh fixtures">
              <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin-slow')} />
              Refresh
            </Button>
          </div>
        }
      />

      <SportsShelf
        sports={sports}
        counts={counts}
        active={activeSport}
        onChange={onSportChange}
        total={totalActive}
      />

      <Tabs value={tab} onValueChange={(value) => onTabChange(value as FixtureTab)}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            <TabsTrigger value="live">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-pulse-live rounded-full bg-current" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-current" />
              </span>
              Live Now
              <span className="rounded-md border border-edge bg-void-950 px-1.5 py-0.5 font-mono text-[10px] text-live">
                {filteredLive.length}
              </span>
            </TabsTrigger>
            <TabsTrigger value="upcoming">
              <CalendarDays className="h-3.5 w-3.5" />
              Upcoming Fixtures
              <span className="rounded-md bg-void-700 px-1.5 py-0.5 font-mono text-[10px] text-ink-300">
                {filteredUpcoming.length}
              </span>
            </TabsTrigger>
          </TabsList>

          {matchesQuery ? (
            <button
              type="button"
              onClick={onClearQuery}
              className="inline-flex items-center gap-2 rounded-md border border-volt bg-void-800 px-3 py-2 text-xs text-volt transition hover:bg-volt hover:text-void"
            >
              <SearchX className="h-3.5 w-3.5" />
              “{query}” · clear
            </button>
          ) : null}
        </div>

        <TabsContent value="live">
          {isLoading && filteredLive.length === 0 ? (
            <Grid density={density}>
              <MatchCardSkeletons count={density === 'compact' ? 6 : 8} compact={density === 'compact'} />
            </Grid>
          ) : filteredLive.length === 0 ? (
            <EmptyState
              upcoming={upcoming}
              sports={sports}
              onRefresh={onRefresh}
              onBrowse={() => onTabChange('upcoming')}
            />
          ) : (
            <Grid density={density}>
              {filteredLive.map((fixture, index) => (
                <MatchCard
                  key={fixture.id}
                  fixture={fixture}
                  index={index}
                  sports={sports}
                  streams={previews.byMatch.get(fixture.id)}
                  compact={density === 'compact'}
                  onWatch={onWatch}
                />
              ))}
            </Grid>
          )}

          {isError ? (
            <div className="mt-4 flex items-center justify-between gap-3 rounded-2xl border border-flare bg-void-800 px-4 py-3 text-sm text-flare">
              <span>Can’t reach the Streamed API right now — retrying automatically.</span>
              <Button size="sm" variant="outline" onClick={onRefresh}>
                Retry
              </Button>
            </div>
          ) : null}
        </TabsContent>

        <TabsContent value="upcoming">
          {isLoading && filteredUpcoming.length === 0 ? (
            <Grid density={density}>
              <MatchCardSkeletons count={6} compact={density === 'compact'} />
            </Grid>
          ) : filteredUpcoming.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              className="rounded-3xl border border-dashed border-edge bg-void-850 p-10 text-center"
            >
              <Radar className="mx-auto h-8 w-8 text-volt-400" />
              <h3 className="mt-4 font-display text-xl font-semibold text-white">
                No fixtures scheduled
              </h3>
              <p className="mt-2 text-sm text-ink-400">
                Nothing matches the current sport or search filter yet.
              </p>
              <div className="mt-5 flex justify-center gap-2">
                <Badge variant="neutral">Auto-refreshing</Badge>
                <Badge variant="volt">Try another sport</Badge>
              </div>
            </motion.div>
          ) : (
            <Grid density={density}>
              {filteredUpcoming.map((fixture, index) => (
                <MatchCard
                  key={fixture.id}
                  fixture={fixture}
                  index={index}
                  sports={sports}
                  compact={density === 'compact'}
                  onWatch={onWatch}
                />
              ))}
            </Grid>
          )}
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-center gap-2 pt-2">
        <LivePill label={`${onAirCount} live`} />
        <Badge variant="neutral">{upcoming.length} upcoming</Badge>
      </div>
    </section>
  );
}

function Grid({ children, density }: { children: React.ReactNode; density: Density }) {
  return (
    <div
      className={cn(
        'grid gap-4',
        density === 'compact'
          ? 'grid-cols-1 lg:grid-cols-2'
          : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
      )}
    >
      {children}
    </div>
  );
}
