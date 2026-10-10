'use client';

import * as React from 'react';
import { RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { SafeImage } from '@/components/media/SafeImage';
import { GAME_STATS_REFRESH_MS, useGameStats } from '@/lib/hooks';
import { betterSide, type GameSide, type TeamStat } from '@/lib/espn';
import { cn, initials } from '@/lib/utils';
import type { Fixture } from '@/lib/types';

export function GameStats({ fixture }: { fixture: Fixture }) {
  const { supported, matched, isLoading, stats } = useGameStats(fixture);

  return (
    <section className="surface rounded-md p-4 sm:p-5">
      <div className="flex items-center gap-3 border-b border-edge pb-3">
        <h2 className="font-display text-lg font-bold uppercase tracking-[0.14em] text-white">
          Game stats
        </h2>
        <span className="ml-auto inline-flex items-center gap-2 rounded-md border border-edge bg-void-850 px-3 py-1.5 text-[11px] uppercase tracking-[0.16em] text-ink-400">
          <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-live" />
          Auto sync · 15s
        </span>
      </div>

      {isLoading && !stats ? (
        <div className="mt-4 space-y-2">
          <div className="skeleton h-16 w-full rounded-md" />
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className="skeleton h-8 w-full rounded-md" />
          ))}
        </div>
      ) : !supported ? (
        <EmptyNote>Live game stats are not available for this sport.</EmptyNote>
      ) : !matched ? (
        <EmptyNote>
          No live stats tracked for this game yet — stats appear here once the game is on the
          board.
        </EmptyNote>
      ) : !stats ? (
        <EmptyNote>Stats are unavailable right now — retrying every 15 seconds.</EmptyNote>
      ) : (
        <div className="mt-4 space-y-5">
          <ScoreHeader home={stats.home} away={stats.away} statusDetail={stats.statusDetail} />
          {stats.home.stats.length > 0 && stats.away.stats.length > 0 ? (
            <StatLine home={stats.home} away={stats.away} />
          ) : null}
          {stats.home.leaders.length > 0 || stats.away.leaders.length > 0 ? (
            <Leaders home={stats.home} away={stats.away} />
          ) : null}
        </div>
      )}
    </section>
  );
}

function ScoreHeader({
  home,
  away,
  statusDetail,
}: {
  home: GameSide;
  away: GameSide;
  statusDetail: string;
}) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-md border border-edge bg-void-900 px-4 py-3.5">
      <TeamIdentity side={home} align="start" />
      <div className="flex flex-col items-center gap-1">
        <span className="font-mono text-2xl font-bold tabular-nums text-white sm:text-3xl">
          {home.score || '0'}<span className="mx-1.5 text-ink-500">-</span>{away.score || '0'}
        </span>
        {statusDetail ? (
          <Badge variant={home.score || away.score ? 'live' : 'outline'}>{statusDetail}</Badge>
        ) : null}
      </div>
      <TeamIdentity side={away} align="end" />
    </div>
  );
}

function TeamIdentity({ side, align }: { side: GameSide; align: 'start' | 'end' }) {
  return (
    <div
      className={cn(
        'flex min-w-0 flex-col items-center gap-1.5 text-center sm:gap-2.5',
        align === 'end' ? 'sm:flex-row-reverse sm:text-right' : 'sm:flex-row sm:text-left',
      )}
    >
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md border border-edge bg-void-800 p-1">
        <SafeImage
          src={side.logo}
          alt={side.name}
          width={36}
          height={36}
          fallbackText={initials(side.name)}
          imgClassName="object-contain"
        />
      </span>
      <span className="line-clamp-2 min-w-0 text-xs font-semibold text-white sm:line-clamp-1 sm:text-base">
        {side.name}
      </span>
    </div>
  );
}

function StatLine({ home, away }: { home: GameSide; away: GameSide }) {
  const rows = React.useMemo(() => {
    const names = new Set<string>();
    for (const stat of home.stats) names.add(stat.name);
    for (const stat of away.stats) names.add(stat.name);
    return [...names];
  }, [home.stats, away.stats]);
  const byName = (side: GameSide, name: string): TeamStat | undefined =>
    side.stats.find((stat) => stat.name === name);

  return (
    <div className="overflow-hidden rounded-md border border-edge bg-void-900">
      <div className="grid grid-cols-[1fr_auto_1fr] border-b border-edge bg-void-850 px-4 py-2 text-[9px] font-bold uppercase tracking-[0.2em] text-ink-500">
        <span className="text-left">{home.name}</span>
        <span>Stat</span>
        <span className="text-right">{away.name}</span>
      </div>
      {rows.map((name) => {
        const homeStat = byName(home, name);
        const awayStat = byName(away, name);
        if (!homeStat && !awayStat) return null;
        const reference = homeStat ?? awayStat;
        if (!reference) return null;
        const leader = betterSide(reference, home, away);
        return (
          <div
            key={name}
            className="grid grid-cols-[1fr_auto_1fr] items-center border-b border-edge px-4 py-2 last:border-b-0"
          >
            <span
              className={cn(
                'text-left font-mono text-sm tabular-nums',
                leader === 'home' ? 'font-bold text-live' : 'text-ink-100',
              )}
            >
              {homeStat?.displayValue ?? '—'}
            </span>
            <span className="px-4 text-center text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-400">
              {reference.label}
            </span>
            <span
              className={cn(
                'text-right font-mono text-sm tabular-nums',
                leader === 'away' ? 'font-bold text-live' : 'text-ink-100',
              )}
            >
              {awayStat?.displayValue ?? '—'}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function Leaders({ home, away }: { home: GameSide; away: GameSide }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <LeaderColumn side={home} />
      <LeaderColumn side={away} />
    </div>
  );
}

function LeaderColumn({ side }: { side: GameSide }) {
  if (side.leaders.length === 0) {
    return (
      <div className="rounded-md border border-edge bg-void-900 px-4 py-3">
        <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-ink-500">
          {side.name} leaders
        </p>
        <p className="mt-2 text-xs text-ink-500">No player leaders reported yet.</p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-edge bg-void-900 px-4 py-3">
      <p className="truncate text-[10px] font-bold uppercase tracking-[0.2em] text-ink-500">
        {side.name} leaders
      </p>
      <div className="mt-2.5 space-y-2">
        {side.leaders.map((leader) => (
          <div key={`${leader.statName}-${leader.athleteName}`} className="flex items-center gap-2.5">
            <span className="grid h-8 w-8 shrink-0 place-items-center overflow-hidden rounded-full border border-edge bg-void-800">
              <SafeImage
                src={leader.headshot}
                alt={leader.athleteName}
                width={28}
                height={28}
                fallbackText={initials(leader.athleteName)}
                imgClassName="object-cover"
              />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-semibold text-white">
                {leader.athleteName}
              </span>
              <span className="block text-[10px] uppercase tracking-[0.14em] text-ink-400">
                {leader.statLabel}
              </span>
            </span>
            <span className="font-mono text-sm font-bold tabular-nums text-live">
              {leader.displayValue}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-4 flex items-center justify-center gap-2 rounded-md border border-dashed border-edge bg-void-900 px-4 py-8 text-center">
      <RefreshCw className="h-3.5 w-3.5 shrink-0 text-ink-500" />
      <p className="text-xs leading-relaxed text-ink-400">{children}</p>
    </div>
  );
}
