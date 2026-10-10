'use client';

import * as React from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { ArrowLeft, RadioTower, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge, LivePill } from '@/components/ui/badge';
import { MatchCard } from '@/components/fixtures/MatchCard';
import { sportIcon } from '@/components/fixtures/SportsShelf';
import { ArenaWatch } from '@/components/watch/ArenaWatch';
import { useFixtures, useSportsQuery } from '@/lib/hooks';
import { FALLBACK_SPORTS, kickoffParts, sportName } from '@/lib/utils';
import { watchHref } from '@/lib/links';
import type { Fixture } from '@/lib/types';

export default function WatchClient({ id: idProp }: { id?: string }) {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = idProp ?? params?.id ?? '';
  const fixtures = useFixtures();
  const sportsQuery = useSportsQuery();

  const sports = sportsQuery.data && sportsQuery.data.length > 0 ? sportsQuery.data : FALLBACK_SPORTS;
  const fixture = React.useMemo(
    () => fixtures.allFixtures.find((entry) => entry.id === id) ?? null,
    [fixtures.allFixtures, id],
  );

  const upNext = React.useMemo(
    () => fixtures.liveFixtures.filter((entry) => entry.id !== id).slice(0, 4),
    [fixtures.liveFixtures, id],
  );

  if (fixtures.isLoading && !fixture) {
    return (
      <div className="flex flex-col gap-4 pb-20 pt-6 sm:pt-9">
        <div className="skeleton h-14 w-full rounded-md" />
        <div className="skeleton aspect-video w-full rounded-md" />
        <div className="skeleton h-24 w-full rounded-md" />
      </div>
    );
  }

  if (!fixture) {
    return (
      <div className="flex flex-col gap-6 pb-20 pt-6 sm:pt-9">
        <div className="surface rounded-md p-10 text-center sm:p-16">
          <span className="mx-auto grid h-16 w-16 place-items-center rounded-md border border-edge bg-void-800">
            <Search className="h-7 w-7 text-volt" />
          </span>
          <h1 className="mt-5 font-display text-2xl font-bold tracking-tight text-white sm:text-4xl">
            Match not found
          </h1>
          <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-400">
            This fixture is not in the current feed. It may have expired from the schedule — check
            the live board or the full schedule.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button variant="primary" onClick={() => router.push('/live')}>
              <RadioTower className="h-4 w-4" />
              Browse live matches
            </Button>
            <Button variant="outline" onClick={() => router.push('/schedule')}>
              Open schedule
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const SportIcon = sportIcon(fixture.category);
  const kickoff = kickoffParts(fixture.date, Date.now());

  return (
    <div className="flex flex-col gap-6 pb-20 pt-6 sm:pt-9">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => router.push('/live')}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Live board
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Badge variant="neutral">{sportName(fixture.category, sports)}</Badge>
          {fixture.status === 'live' ? (
            <LivePill label="Live now" />
          ) : fixture.status === 'in-play' ? (
            <Badge variant="volt">In play</Badge>
          ) : fixture.status === 'ended' ? (
            <Badge variant="neutral">Ended</Badge>
          ) : (
            <Badge variant="outline">
              {kickoff.dayLabel} · {kickoff.timeLabel}
            </Badge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-md border border-volt bg-void-800">
          <SportIcon className="h-5 w-5 text-volt" />
        </span>
        <h1 className="font-display text-xl font-bold tracking-tight text-white sm:text-2xl">
          {fixture.title}
        </h1>
      </div>

      <ArenaWatch fixture={fixture} />

      {upNext.length > 0 ? (
        <section className="flex flex-col gap-4">
          <div className="flex items-center gap-3 border-b border-edge pb-3">
            <h2 className="font-display text-lg font-bold uppercase tracking-[0.14em] text-white">
              Also live
            </h2>
            <span className="rounded-md border border-edge bg-void-800 px-2 py-0.5 font-mono text-[10px] font-bold text-ink-300">
              {upNext.length}
            </span>
            <Link
              href="/live"
              className="ml-auto text-[11px] font-semibold uppercase tracking-[0.16em] text-volt transition hover:text-white"
            >
              View all live
            </Link>
          </div>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {upNext.map((entry, index) => (
              <MatchCard
                key={entry.id}
                fixture={entry}
                index={index}
                sports={sports}
                compact
                onWatch={(next: Fixture) => router.push(watchHref(next.id))}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
