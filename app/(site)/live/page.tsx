'use client';

import * as React from 'react';
import { RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { SectionHeading } from '@/components/ui/panel';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/fixtures/EmptyState';
import { MatchCard } from '@/components/fixtures/MatchCard';
import { MatchCardSkeletons } from '@/components/fixtures/Skeletons';
import { SportsShelf } from '@/components/fixtures/SportsShelf';
import { useFixtures, useSportsQuery, useStreamPreviews } from '@/lib/hooks';
import { useFilters } from '@/components/providers/FilterProvider';
import { cn, FALLBACK_SPORTS } from '@/lib/utils';
import { watchHref } from '@/lib/links';
import type { Fixture } from '@/lib/types';

export default function LivePage() {
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
    const seen = new Set<string>();
    const merged: Fixture[] = [];
    for (const fixture of [...fixtures.liveFixtures, ...fixtures.inPlayFixtures]) {
      if (seen.has(fixture.id)) continue;
      seen.add(fixture.id);
      if (sport !== 'all' && fixture.category !== sport) continue;
      if (matchesQuery) {
        const haystack = `${fixture.title} ${fixture.home?.name ?? ''} ${fixture.away?.name ?? ''}`.toLowerCase();
        if (!haystack.includes(matchesQuery)) continue;
      }
      merged.push(fixture);
    }
    return merged;
  }, [fixtures.liveFixtures, fixtures.inPlayFixtures, sport, matchesQuery]);

  const counts = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const fixture of [...fixtures.liveFixtures, ...fixtures.inPlayFixtures]) {
      map[fixture.category] = (map[fixture.category] ?? 0) + 1;
    }
    return map;
  }, [fixtures.liveFixtures, fixtures.inPlayFixtures]);

  const previews = useStreamPreviews(filtered, 8);

  return (
    <div className="flex flex-col gap-6 pb-20 pt-6 sm:pt-9">
      <SectionHeading
        as="h1"
        eyebrow="Realtime"
        title="Live Now"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <span className="hidden items-center gap-2 rounded-md border border-edge bg-void-850 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-ink-400 sm:inline-flex">
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  fixtures.isFetching ? 'animate-pulse-live bg-volt' : 'bg-live',
                )}
              />
              Auto sync · 15s
            </span>
            <Button variant="ghost" size="sm" onClick={fixtures.refetch} aria-label="Refresh fixtures">
              <RefreshCw className={cn('h-3.5 w-3.5', fixtures.isFetching && 'animate-spin-slow')} />
              Refresh
            </Button>
          </div>
        }
      />

      <SportsShelf sports={sports} counts={counts} active={sport} onChange={setSport} total={filtered.length} />

      {fixtures.isLoading && filtered.length === 0 ? (
        <Grid density={density}>
          <MatchCardSkeletons count={density === 'compact' ? 6 : 8} compact={density === 'compact'} />
        </Grid>
      ) : filtered.length === 0 ? (
        <EmptyState
          upcoming={fixtures.upcomingFixtures}
          sports={sports}
          onRefresh={fixtures.refetch}
          onBrowse={() => router.push('/schedule')}
        />
      ) : (
        <Grid density={density}>
          {filtered.map((fixture, index) => (
            <MatchCard
              key={fixture.id}
              fixture={fixture}
              index={index}
              sports={sports}
              streams={previews.byMatch.get(fixture.id)}
              compact={density === 'compact'}
              onWatch={watch}
            />
          ))}
        </Grid>
      )}
    </div>
  );
}

function Grid({ children, density }: { children: React.ReactNode; density: 'comfortable' | 'compact' }) {
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
