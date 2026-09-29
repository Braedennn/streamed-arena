'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { ChevronRight, Play, Radio, SignalHigh, Sparkles, Timer, Users } from 'lucide-react';
import { Badge, LivePill } from '@/components/ui/badge';
import { SafeImage } from '@/components/media/SafeImage';
import { HeroSkeleton } from '@/components/fixtures/Skeletons';
import { sportIcon } from '@/components/fixtures/SportsShelf';
import { badgeUrl } from '@/lib/api';
import { useCountdown, useMatchStreams } from '@/lib/hooks';
import { cn, compactCountdown, formatViewers, initials, kickoffParts, splitTitle, sportName } from '@/lib/utils';
import type { Fixture, Sport } from '@/lib/types';

interface HeroArenaProps {
  featured: Fixture | null;
  nextKickoff: Fixture | null;
  sideFixtures: readonly Fixture[];
  sports: readonly Sport[];
  liveCount: number;
  isLoading: boolean;
  onWatch: (fixture: Fixture) => void;
}

export function HeroArena({
  featured,
  nextKickoff,
  sideFixtures,
  sports,
  liveCount,
  isLoading,
  onWatch,
}: HeroArenaProps) {
  const streams = useMatchStreams(featured?.sources ?? [], featured?.status === 'live');
  const countdown = useCountdown(
    featured && featured.status === 'upcoming' ? featured.date : null,
  );

  if (isLoading && !featured) return <HeroSkeleton />;
  if (!featured) return <HeroCurtain nextKickoff={nextKickoff} sports={sports} onWatch={onWatch} />;

  const fallback = splitTitle(featured.title);
  const SportIcon = sportIcon(featured.category);
  const feedCount = featured.sources.length;
  const hdCount = (streams.data ?? []).filter((stream) => stream.hd).length;
  const viewers = formatViewers((streams.data ?? []).reduce((sum, s) => sum + (s.viewers ?? 0), 0));
  const kickoff = kickoffParts(featured.date, Date.now());

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="relative overflow-hidden rounded-3xl border border-edge bg-void-850"
      id="top"
    >

      <div className="relative grid gap-8 p-6 sm:p-9 lg:grid-cols-[1.65fr_1fr] lg:p-11">
        <div className="flex flex-col gap-6">
          <div className="flex flex-wrap items-center gap-2.5">
            {featured.status === 'live' ? <LivePill /> : <Badge variant="volt">{kickoff.dayLabel}</Badge>}
            <span className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-void-800 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-ink-200">
              <SportIcon className="h-3 w-3 text-volt-400" />
              {sportName(featured.category, sports)}
            </span>
            {featured.popular ? (
              <Badge variant="flare">
                <Sparkles className="h-3 w-3" />
                Featured
              </Badge>
            ) : null}
            <span className="ml-auto hidden text-[11px] uppercase tracking-[0.24em] text-ink-500 sm:inline">
              Multistream Arena
            </span>
          </div>

          <div className="space-y-3">
            <p className="text-[11px] font-semibold uppercase tracking-[0.34em] text-ink-500">
              {featured.status === 'live' ? 'Live billboard' : 'Next on the board'}
            </p>
            <h1 className="font-display text-3xl font-bold leading-[1.05] tracking-tight text-white sm:text-5xl lg:text-6xl">
              {featured.home?.name ?? fallback.home}
              <span className="mx-3 text-volt">
                vs
              </span>
              {featured.away?.name ?? fallback.away}
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-4">
            <span className="flex items-center gap-3 rounded-2xl border border-edge bg-void-800 p-2">
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-void-700">
                <SafeImage
                  src={badgeUrl(featured.home?.badge ?? null)}
                  alt={featured.home?.name ?? fallback.home}
                  width={40}
                  height={40}
                  fallbackText={initials(featured.home?.name ?? fallback.home)}
                />
              </span>
              <span className="grid h-12 w-12 place-items-center rounded-xl bg-void-700">
                <SafeImage
                  src={badgeUrl(featured.away?.badge ?? null)}
                  alt={featured.away?.name ?? fallback.away}
                  width={40}
                  height={40}
                  fallbackText={initials(featured.away?.name ?? fallback.away)}
                />
              </span>
            </span>

            <dl className="grid grid-cols-3 gap-2 text-center">
              <Stat icon={Radio} label="Feeds" value={String(feedCount)} />
              <Stat icon={SignalHigh} label="Quality" value={hdCount > 0 ? 'HD' : 'Auto'} />
              <Stat icon={Users} label="Watching" value={viewers ?? '—'} />
            </dl>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => onWatch(featured)}
              className="group inline-flex items-center gap-3 rounded-2xl border border-live bg-live px-6 py-4 text-sm font-bold uppercase tracking-[0.12em] text-void transition-all duration-300 ease-out-expo hover:-translate-y-1 hover:bg-live-600"
            >
              <Play className="h-4 w-4" fill="currentColor" />
              {featured.status === 'live' ? 'Watch live now' : 'Open arena'}
              <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
            </button>

            <div className="inline-flex items-center gap-3 rounded-2xl border border-edge bg-void-800 px-4 py-3.5">
              <Timer className="h-4 w-4 text-volt-400" />
              <div className="text-xs text-ink-400">
                {featured.status === 'live' ? (
                  <>
                    Kicked off{' '}
                    <span className="font-semibold text-white">{kickoff.timeLabel}</span>
                  </>
                ) : (
                  <>
                    Starts in{' '}
                    <span className="font-semibold text-white">{compactCountdown(countdown)}</span>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          {nextKickoff ? <NextKickoffCard fixture={nextKickoff} sports={sports} onWatch={onWatch} /> : null}

          <div className="surface-strong rounded-2xl p-4">
            <div className="mb-3 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-400">
                Also on air
              </p>
              <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-live-400">
                <span className="h-1.5 w-1.5 animate-pulse-live rounded-full bg-live" />
                {liveCount} live
              </span>
            </div>

            <div className="space-y-2">
              {sideFixtures.slice(0, 3).map((fixture) => (
                <SideTile key={fixture.id} fixture={fixture} sports={sports} onWatch={onWatch} />
              ))}
              {sideFixtures.length === 0 ? (
                <p className="rounded-xl border border-dashed border-edge px-3 py-6 text-center text-xs text-ink-500">
                  No other streams on air yet.
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </motion.section>
  );
}

function Stat({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-[5rem] rounded-xl border border-edge bg-void-800 px-3 py-2.5">
      <Icon className="mx-auto h-3.5 w-3.5 text-volt-400" />
      <dt className="mt-1 text-[9px] uppercase tracking-[0.2em] text-ink-500">{label}</dt>
      <dd className="font-display text-sm font-bold text-white">{value}</dd>
    </div>
  );
}

function NextKickoffCard({
  fixture,
  sports,
  onWatch,
}: {
  fixture: Fixture;
  sports: readonly Sport[];
  onWatch: (fixture: Fixture) => void;
}) {
  const countdown = useCountdown(fixture.date);
  const kickoff = kickoffParts(fixture.date, Date.now());
  const fallback = splitTitle(fixture.title);
  const sportLabel = sports.find((sport) => sport.id === fixture.category)?.name ?? fixture.category;

  const units: Array<{ label: string; value: number }> = [
    { label: 'Days', value: countdown.days },
    { label: 'Hrs', value: countdown.hours },
    { label: 'Min', value: countdown.minutes },
    { label: 'Sec', value: countdown.seconds },
  ];

  return (
    <motion.button
      type="button"
      onClick={() => onWatch(fixture)}
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ duration: 0.5, delay: 0.1, ease: [0.16, 1, 0.3, 1] }}
      className="group surface-strong rounded-2xl p-4 text-left transition-all duration-300 ease-out-expo hover:border-volt"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-volt-400">
          Kick-off countdown
        </p>
        <span className="text-[10px] uppercase tracking-[0.16em] text-ink-500">
          {kickoff.dayLabel} {kickoff.timeLabel}
        </span>
      </div>

      <p className="mt-2 truncate font-display text-sm font-semibold text-white">
        {fixture.home?.name ?? fallback.home} vs {fixture.away?.name ?? fallback.away}
      </p>
      <p className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-ink-500">{sportLabel}</p>

      <div className="mt-3 grid grid-cols-4 gap-1.5">
        {units.map((unit) => (
          <div
            key={unit.label}
            className="rounded-xl border border-edge bg-void-950 px-1 py-2 text-center"
          >
            <p className="font-display text-lg font-bold leading-none text-white tabular-nums">
              {String(unit.value).padStart(2, '0')}
            </p>
            <p className="mt-1 text-[8px] uppercase tracking-[0.18em] text-ink-500">{unit.label}</p>
          </div>
        ))}
      </div>
    </motion.button>
  );
}

function SideTile({
  fixture,
  sports,
  onWatch,
}: {
  fixture: Fixture;
  sports: readonly Sport[];
  onWatch: (fixture: Fixture) => void;
}) {
  const fallback = splitTitle(fixture.title);
  const SportIcon = sportIcon(fixture.category);

  return (
    <button
      type="button"
      onClick={() => onWatch(fixture)}
      className="flex w-full items-center gap-3 rounded-xl border border-edge bg-void-800 p-2.5 text-left transition-all duration-300 ease-out-expo hover:-translate-y-0.5 hover:border-edge-hi hover:bg-void-700"
    >
      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-void-700">
        <SafeImage
          src={badgeUrl(fixture.home?.badge ?? null)}
          alt={fixture.home?.name ?? fallback.home}
          width={28}
          height={28}
          fallbackText={initials(fixture.home?.name ?? fallback.home)}
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-white">
          {fixture.home?.name ?? fallback.home} vs {fixture.away?.name ?? fallback.away}
        </span>
        <span className="mt-0.5 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-ink-500">
          <SportIcon className="h-3 w-3" />
          {sportName(fixture.category, sports)}
        </span>
      </span>
      <span className="shrink-0">
        {fixture.status === 'live' ? (
          <span className="inline-flex items-center gap-1 rounded-md border border-live bg-live px-2 py-1 text-[9px] font-bold uppercase tracking-[0.14em] text-void">
            Live
          </span>
        ) : (
          <span className="text-[10px] font-semibold text-ink-300">
            {kickoffParts(fixture.date, Date.now()).timeLabel}
          </span>
        )}
      </span>
    </button>
  );
}

function HeroCurtain({
  nextKickoff,
  sports,
  onWatch,
}: {
  nextKickoff: Fixture | null;
  sports: readonly Sport[];
  onWatch: (fixture: Fixture) => void;
}) {
  const countdown = useCountdown(nextKickoff?.date ?? null);

  return (
    <motion.section
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="relative isolate overflow-hidden rounded-3xl border border-edge bg-void-850 p-8 sm:p-12"
      id="top"
    >
      <div className="absolute inset-0 bg-grid-void bg-[size:44px_44px]" />
      <div className="relative mx-auto max-w-3xl space-y-6 text-center">
        <Badge variant="volt" className="mx-auto">
          Schedule mode
        </Badge>
        <h1 className="font-display text-3xl font-bold tracking-tight text-white sm:text-5xl">
          No Live Streams Currently Active
        </h1>
        <p className="mx-auto max-w-xl text-sm leading-relaxed text-ink-400">
          Nothing is on air at this moment. Sync the schedule and jump into the first fixture the
          second it kicks off.
        </p>
        {nextKickoff ? (
          <div className="flex flex-col items-center gap-4">
            <p className="font-display text-lg font-semibold text-white">
              {nextKickoff.title} · {sportName(nextKickoff.category, sports)}
            </p>
            <p className="text-3xl font-bold tabular-nums text-gradient-volt">
              {compactCountdown(countdown)}
            </p>
            <button
              type="button"
              onClick={() => onWatch(nextKickoff)}
              className="inline-flex items-center gap-2 rounded-2xl bg-void-700 px-6 py-3.5 text-sm font-semibold text-white transition hover:bg-void-800"
            >
              <Play className="h-4 w-4" fill="currentColor" />
              Preview arena
            </button>
          </div>
        ) : null}
      </div>
    </motion.section>
  );
}
