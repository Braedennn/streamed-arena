'use client';

import * as React from 'react';
import { CalendarDays, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { SectionHeading } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { MatchCard } from '@/components/fixtures/MatchCard';
import { MatchCardSkeletons } from '@/components/fixtures/Skeletons';
import { SportsShelf } from '@/components/fixtures/SportsShelf';
import { useFixtures, useSportsQuery } from '@/lib/hooks';
import { useFilters } from '@/components/providers/FilterProvider';
import { cn, FALLBACK_SPORTS } from '@/lib/utils';
import { watchHref } from '@/lib/links';
import type { Fixture } from '@/lib/types';

interface DayGroup {
  readonly key: string;
  readonly label: string;
  readonly fixtures: Fixture[];
}

export default function SchedulePage() {
  const fixtures = useFixtures();
  const sportsQuery = useSportsQuery();
  const { sport, setSport, query, density } = useFilters();
  const router = useRouter();

  const watch = React.useCallback(
    (fixture: { id: string }) => router.push(watchHref(fixture.id)),
    [router],
  );

  const sports = sportsQuery.data && sportsQuery.data.length > 0 ? sportsQuery.data : FALLBACK_SPORTS;
  const matchesQuery = query.trim().toLowerCase();

  const filtered = React.useMemo(() => {
    return fixtures.upcomingFixtures.filter((fixture) => {
      if (sport !== 'all' && fixture.category !== sport) return false;
      if (matchesQuery) {
        const haystack = `${fixture.title} ${fixture.home?.name ?? ''} ${fixture.away?.name ?? ''}`.toLowerCase();
        if (!haystack.includes(matchesQuery)) return false;
      }
      return true;
    });
  }, [fixtures.upcomingFixtures, sport, matchesQuery]);

  const counts = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const fixture of fixtures.upcomingFixtures) {
      map[fixture.category] = (map[fixture.category] ?? 0) + 1;
    }
    return map;
  }, [fixtures.upcomingFixtures]);

  const dayGroups = React.useMemo<DayGroup[]>(() => {
    const map = new Map<string, DayGroup>();
    for (const fixture of filtered) {
      const date = new Date(fixture.date);
      const key = date.toDateString();
      const existing = map.get(key);
      if (existing) {
        existing.fixtures.push(fixture);
      } else {
        map.set(key, {
          key,
          label: dayLabelFor(fixture.date),
          fixtures: [fixture],
        });
      }
    }
    return Array.from(map.values());
  }, [filtered]);

  return (
    <div className="flex flex-col gap-6 pb-20 pt-6 sm:pt-9">
      <SectionHeading
        as="h1"
        eyebrow="Timetable"
        title="Schedule"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden items-center gap-2 rounded-md border border-edge bg-void-850 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-ink-400 sm:inline-flex">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  fixtures.isFetching ? 'animate-pulse-live bg-volt' : 'bg-live',
                )}
              />
              Auto sync · 30s
            </span>
            <Button variant="ghost" size="sm" onClick={fixtures.refetch} aria-label="Refresh schedule">
              <RefreshCw className={cn('h-3.5 w-3.5', fixtures.isFetching && 'animate-spin-slow')} />
              Refresh
            </Button>
          </div>
        }
      />

      <SportsShelf sports={sports} counts={counts} active={sport} onChange={setSport} total={filtered.length} />

      {fixtures.isLoading && filtered.length === 0 ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <MatchCardSkeletons count={8} />
        </div>
      ) : dayGroups.length === 0 ? (
        <div className="rounded-3xl border border-dashed border-edge bg-void-850 p-10 text-center">
          <CalendarDays className="mx-auto h-8 w-8 text-volt" />
          <h3 className="mt-4 font-display text-xl font-semibold text-white">No fixtures scheduled</h3>
          <p className="mt-2 text-sm text-ink-400">
            Nothing matches the current sport or search filter yet. The schedule syncs every 30
            seconds.
          </p>
          <div className="mt-5 flex justify-center gap-2">
            <Button variant="primary" onClick={fixtures.refetch}>
              <RefreshCw className="h-4 w-4" />
              Refresh feed
            </Button>
            <Button variant="outline" onClick={() => router.push('/live')}>
              Check live matches
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-10">
          {dayGroups.map((group) => (
            <section key={group.key} className="flex flex-col gap-4">
              <div className="flex items-center gap-3 border-b border-edge pb-3">
                <h2 className="font-display text-lg font-bold uppercase tracking-[0.14em] text-white">
                  {group.label}
                </h2>
                <span className="rounded-md border border-edge bg-void-800 px-2 py-0.5 font-mono text-[10px] font-bold text-ink-300">
                  {group.fixtures.length}
                </span>
              </div>
              <div
                className={cn(
                  'grid gap-4',
                  density === 'compact'
                    ? 'grid-cols-1 lg:grid-cols-2'
                    : 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4',
                )}
              >
                {group.fixtures.map((fixture, index) => (
                  <MatchCard
                    key={fixture.id}
                    fixture={fixture}
                    index={index}
                    sports={sports}
                    compact={density === 'compact'}
                    onWatch={watch}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function dayLabelFor(date: number): string {
  const target = new Date(date);
  const now = new Date();
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const startOfCurrent = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayDelta = Math.round((startOfTarget - startOfCurrent) / 86_400_000);

  if (dayDelta === 0) return 'Today';
  if (dayDelta === 1) return 'Tomorrow';
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: '2-digit',
    month: 'short',
  }).format(target);
}
