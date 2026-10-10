'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { HeroArena } from '@/components/hero/HeroArena';
import { FixtureHub, type FixtureTab } from '@/components/fixtures/FixtureHub';
import { useFixtures, useSportsQuery } from '@/lib/hooks';
import { useFilters } from '@/components/providers/FilterProvider';
import { cn, FALLBACK_SPORTS, kickoffParts } from '@/lib/utils';
import { watchHref } from '@/lib/links';

function StatStrip({
  live,
  inPlay,
  upcoming,
  sportsCount,
}: {
  live: number;
  inPlay: number;
  upcoming: number;
  sportsCount: number;
}) {
  const tiles = [
    { label: 'Live now', value: String(live), accent: true },
    { label: 'In progress', value: String(inPlay), accent: false },
    { label: 'Starting today', value: String(upcoming), accent: false },
    { label: 'Sports covered', value: String(sportsCount), accent: false },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {tiles.map((tile) => (
        <div
          key={tile.label}
          className={cn(
            'rounded-md border px-4 py-3.5',
            tile.accent ? 'border-live bg-void-850' : 'border-edge bg-void-850',
          )}
        >
          <p
            className={cn(
              'font-mono text-2xl font-bold tabular-nums leading-none',
              tile.accent ? 'text-live' : 'text-white',
            )}
          >
            {tile.value}
          </p>
          <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-ink-400">
            {tile.label}
          </p>
        </div>
      ))}
    </div>
  );
}

export default function Page() {
  const sportsQuery = useSportsQuery();
  const fixtures = useFixtures();
  const router = useRouter();
  const { sport, setSport, rawQuery, setRawQuery, query, density } = useFilters();
  const [tab, setTab] = React.useState<FixtureTab>('live');

  const watch = React.useCallback(
    (fixture: { id: string }) => router.push(watchHref(fixture.id)),
    [router],
  );

  const sports = sportsQuery.data && sportsQuery.data.length > 0 ? sportsQuery.data : FALLBACK_SPORTS;

  const sideFixtures = React.useMemo(
    () => fixtures.liveFixtures.filter((fixture) => fixture.id !== fixtures.featured?.id),
    [fixtures.liveFixtures, fixtures.featured],
  );

  const startingToday = React.useMemo(
    () => fixtures.upcomingFixtures.filter((fixture) => kickoffParts(fixture.date, Date.now()).sameDay).length,
    [fixtures.upcomingFixtures],
  );

  const isLoading = fixtures.isLoading || sportsQuery.isLoading;

  return (
    <div className="flex flex-col gap-12 pb-20 pt-6 sm:pt-9">
      <StatStrip
        live={fixtures.liveFixtures.length}
        inPlay={fixtures.inPlayFixtures.length}
        upcoming={startingToday}
        sportsCount={sports.length}
      />

      <HeroArena
        featured={fixtures.featured}
        nextKickoff={fixtures.nextKickoff}
        sideFixtures={sideFixtures}
        sports={sports}
        liveCount={fixtures.liveFixtures.length}
        isLoading={isLoading}
        onWatch={watch}
      />

      <FixtureHub
        live={fixtures.liveFixtures}
        inPlay={fixtures.inPlayFixtures}
        upcoming={fixtures.upcomingFixtures}
        sports={sports}
        activeSport={sport}
        onSportChange={setSport}
        query={query}
        onClearQuery={() => setRawQuery('')}
        tab={tab}
        onTabChange={setTab}
        density={density}
        isLoading={isLoading}
        isFetching={fixtures.isFetching}
        isError={fixtures.isError}
        onRefresh={fixtures.refetch}
        onWatch={watch}
      />
    </div>
  );
}
