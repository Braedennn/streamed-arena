'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Radio } from 'lucide-react';
import { SectionHeading } from '@/components/ui/panel';
import { Badge, LivePill } from '@/components/ui/badge';
import { EmptyState } from '@/components/fixtures/EmptyState';
import { MatchCard } from '@/components/fixtures/MatchCard';
import { MatchCardSkeletons } from '@/components/fixtures/Skeletons';
import { SportsShelf, sportIcon } from '@/components/fixtures/SportsShelf';
import { useFixtures, useSportsQuery, useStreamPreviews } from '@/lib/hooks';
import { useFilters } from '@/components/providers/FilterProvider';
import { FALLBACK_SPORTS, sportName } from '@/lib/utils';
import { sportHref, watchHref } from '@/lib/links';
import type { Fixture } from '@/lib/types';

export default function SportChannel({ sport: sportProp }: { sport?: string }) {
  const params = useParams<{ sport: string }>();
  const router = useRouter();
  const sportId = sportProp ?? params?.sport ?? 'all';
  const fixtures = useFixtures();
  const sportsQuery = useSportsQuery();
  const { query, density } = useFilters();

  const watch = React.useCallback(
    (fixture: { id: string }) => router.push(watchHref(fixture.id)),
    [router],
  );

  const sports = sportsQuery.data && sportsQuery.data.length > 0 ? sportsQuery.data : FALLBACK_SPORTS;
  const matchesQuery = query.trim().toLowerCase();
  const SportIcon = sportIcon(sportId);
  const label = sportId === 'all' ? 'All Sports' : sportName(sportId, sports);

  const matchesFilters = React.useCallback(
    (fixture: Fixture) => {
      if (sportId !== 'all' && fixture.category !== sportId) return false;
      if (matchesQuery) {
        const haystack = `${fixture.title} ${fixture.home?.name ?? ''} ${fixture.away?.name ?? ''}`.toLowerCase();
        if (!haystack.includes(matchesQuery)) return false;
      }
      return true;
    },
    [sportId, matchesQuery],
  );

  const liveOnes = React.useMemo(
    () => [...fixtures.liveFixtures, ...fixtures.inPlayFixtures].filter(matchesFilters),
    [fixtures.liveFixtures, fixtures.inPlayFixtures, matchesFilters],
  );

  const upcomingOnes = React.useMemo(
    () => fixtures.upcomingFixtures.filter(matchesFilters),
    [fixtures.upcomingFixtures, matchesFilters],
  );

  const previews = useStreamPreviews(liveOnes, 8);

  const counts = React.useMemo(() => {
    const map: Record<string, number> = {};
    for (const fixture of [...fixtures.liveFixtures, ...fixtures.inPlayFixtures, ...fixtures.upcomingFixtures]) {
      map[fixture.category] = (map[fixture.category] ?? 0) + 1;
    }
    return map;
  }, [fixtures.liveFixtures, fixtures.inPlayFixtures, fixtures.upcomingFixtures]);
  const total = fixtures.liveFixtures.length + fixtures.inPlayFixtures.length + fixtures.upcomingFixtures.length;

  const known = sportId === 'all' || sports.some((entry) => entry.id === sportId);

  return (
    <div className="flex flex-col gap-6 pb-20 pt-6 sm:pt-9">
      <div className="surface rounded-md p-5 sm:p-7">
        <div className="flex flex-wrap items-center gap-4">
          <span className="grid h-14 w-14 shrink-0 place-items-center rounded-md border border-volt bg-void-800">
            <SportIcon className="h-7 w-7 text-volt" />
          </span>
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-volt">
              Sport channel
            </p>
            <h1 className="mt-1 font-display text-2xl font-bold tracking-tight text-white sm:text-4xl">
              {label}
            </h1>
          </div>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {liveOnes.length > 0 ? <LivePill label={`${liveOnes.length} live`} /> : null}
            <Badge variant="neutral">{upcomingOnes.length} upcoming</Badge>
          </div>
        </div>
      </div>

      <SportsShelf
        sports={sports}
        counts={counts}
        active={sportId}
        onChange={(value) => router.push(sportHref(value))}
        total={total}
      />

      {fixtures.isLoading && liveOnes.length === 0 && upcomingOnes.length === 0 ? (
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          <MatchCardSkeletons count={8} />
        </div>
      ) : !known || (liveOnes.length === 0 && upcomingOnes.length === 0) ? (
        <EmptyState
          upcoming={fixtures.upcomingFixtures}
          sports={sports}
          onRefresh={fixtures.refetch}
          onBrowse={() => router.push('/schedule')}
        />
      ) : (
        <div className="flex flex-col gap-10">
          {liveOnes.length > 0 ? (
            <section className="flex flex-col gap-4">
              <SectionHeading
                eyebrow={
                  <span className="inline-flex items-center gap-1.5">
                    <Radio className="h-3 w-3 text-live" /> On air
                  </span>
                }
                title="Live Now"
                action={
                  <span className="rounded-md border border-edge bg-void-800 px-2 py-0.5 font-mono text-[10px] font-bold text-ink-300">
                    {liveOnes.length}
                  </span>
                }
              />
              <div
                className={
                  density === 'compact'
                    ? 'grid grid-cols-1 gap-4 lg:grid-cols-2'
                    : 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                }
              >
                {liveOnes.map((fixture, index) => (
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
              </div>
            </section>
          ) : null}

          {upcomingOnes.length > 0 ? (
            <section className="flex flex-col gap-4">
              <SectionHeading
                eyebrow="Timetable"
                title="Upcoming"
                action={
                  <span className="rounded-md border border-edge bg-void-800 px-2 py-0.5 font-mono text-[10px] font-bold text-ink-300">
                    {upcomingOnes.length}
                  </span>
                }
              />
              <div
                className={
                  density === 'compact'
                    ? 'grid grid-cols-1 gap-4 lg:grid-cols-2'
                    : 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'
                }
              >
                {upcomingOnes.map((fixture, index) => (
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
          ) : null}
        </div>
      )}
    </div>
  );
}
