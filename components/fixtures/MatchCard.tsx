'use client';

import * as React from 'react';
import { CalendarClock, Play, Radio, Signal, Users } from 'lucide-react';
import { Badge, LivePill } from '@/components/ui/badge';
import { SafeImage } from '@/components/media/SafeImage';
import { badgeUrl } from '@/lib/api';
import { useCountdown } from '@/lib/hooks';
import { cn, compactCountdown, formatViewers, initials, kickoffParts, slugSource, splitTitle, sportName } from '@/lib/utils';
import type { Fixture, Sport, StreamDto } from '@/lib/types';
import { sportIcon } from '@/components/fixtures/SportsShelf';

interface MatchCardProps {
  fixture: Fixture;
  sports: readonly Sport[];
  streams?: readonly StreamDto[];
  compact?: boolean;
  index?: number;
  onWatch: (fixture: Fixture) => void;
}

export function MatchCard({ fixture, sports, streams, compact = false, index = 0, onWatch }: MatchCardProps) {
  const fallback = splitTitle(fixture.title);
  const home = fixture.home;
  const away = fixture.away;
  const now = Date.now();
  const kickoff = kickoffParts(fixture.date, now);
  const countdown = useCountdown(fixture.status === 'upcoming' ? fixture.date : null);
  const SportIcon = sportIcon(fixture.category);

  const hd = streams?.some((stream) => stream.hd);
  const viewers = streams?.reduce((sum, stream) => sum + (stream.viewers ?? 0), 0);
  const viewerLabel = formatViewers(viewers);

  return (
    <article
      onClick={() => onWatch(fixture)}
      style={{ animationDelay: `${Math.min(index, 8) * 45}ms` }}
      className={cn(
        'group relative lazy-paint animate-enter overflow-hidden rounded-2xl border border-edge bg-void-850 transition-all duration-300 ease-out-expo',
        'hover:-translate-y-1.5 hover:border-edge-hi hover:bg-void-800',
        fixture.status === 'live' && 'border-live hover:border-live',
        compact && 'flex items-stretch gap-3',
      )}
    >
      {compact ? (
        <div className="relative flex w-full items-center gap-3 p-3.5">
          <TeamStack home={home} away={away} fallbackHome={fallback.home} fallbackAway={fallback.away} />
          <CardBody
            fixture={fixture}
            sports={sports}
            streams={streams}
            kickoff={kickoff}
            countdownLabel={compactCountdown(countdown)}
            hd={hd}
            viewerLabel={viewerLabel}
            SportIcon={SportIcon}
            onWatch={onWatch}
          />
        </div>
      ) : (
        <div className="relative flex h-full flex-col gap-4 p-4 sm:p-5">
          <CardMeta
            fixture={fixture}
            sports={sports}
            SportIcon={SportIcon}
            hd={hd}
            viewerLabel={viewerLabel}
          />

          <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
            <TeamColumn
              badge={home?.badge ?? null}
              name={home?.name ?? fallback.home}
            />
            <div className="flex flex-col items-center gap-1">
              <span className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-ink-500">
                VS
              </span>
              <span className="h-8 w-px bg-edge" />
            </div>
            <TeamColumn
              badge={away?.badge ?? null}
              name={away?.name ?? fallback.away}
            />
          </div>

          <CardFooter
            fixture={fixture}
            kickoff={kickoff}
            countdownLabel={compactCountdown(countdown)}
            streams={streams}
            onWatch={onWatch}
          />
        </div>
      )}
    </article>
  );
}

function CardMeta({
  fixture,
  sports,
  SportIcon,
  hd,
  viewerLabel,
}: {
  fixture: Fixture;
  sports: readonly Sport[];
  SportIcon: React.ComponentType<{ className?: string }>;
  hd?: boolean;
  viewerLabel: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {fixture.status === 'live' ? (
        <LivePill />
      ) : fixture.status === 'in-play' ? (
        <Badge variant="volt">In play</Badge>
      ) : fixture.status === 'ended' ? (
        <Badge variant="neutral">Final</Badge>
      ) : (
        <Badge variant="outline">
          <CalendarClock className="h-3 w-3" />
          {kickoffParts(fixture.date, Date.now()).dayLabel}
        </Badge>
      )}

      <span className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-void-800 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-300">
        <SportIcon className="h-3 w-3 text-volt-400" />
        {sportName(fixture.category, sports)}
      </span>

      {hd !== undefined ? (
        <Badge variant={hd ? 'live' : 'neutral'} className="ml-auto">
          <Signal className="h-3 w-3" />
          {hd ? 'HD' : 'SD'}
        </Badge>
      ) : null}

      {viewerLabel ? (
        <Badge variant="neutral">
          <Users className="h-3 w-3" />
          {viewerLabel}
        </Badge>
      ) : null}
    </div>
  );
}

function CardFooter({
  fixture,
  kickoff,
  countdownLabel,
  streams,
  onWatch,
}: {
  fixture: Fixture;
  kickoff: { dayLabel: string; timeLabel: string };
  countdownLabel: string;
  streams?: readonly StreamDto[];
  onWatch: (fixture: Fixture) => void;
}) {
  return (
    <div className="mt-auto flex items-end justify-between gap-3 border-t border-edge pt-3.5">
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap gap-1.5">
          {(fixture.sources ?? []).slice(0, 3).map((source) => (
            <span
              key={`${source.source}-${source.id}`}
              className="rounded-md border border-edge bg-void-800 px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-ink-400"
            >
              {slugSource(source.source)}
            </span>
          ))}
        </div>
        <p className="text-[11px] text-ink-400">
          {fixture.status === 'upcoming' ? (
            <>
              Kick-off in{' '}
              <span className="font-semibold text-white">{countdownLabel}</span>
            </>
          ) : fixture.status === 'live' ? (
            <span className="inline-flex items-center gap-1.5 text-live-400">
              <Radio className="h-3 w-3" /> {streams?.length ?? fixture.sources.length} feed
              {(streams?.length ?? fixture.sources.length) === 1 ? '' : 's'} available
            </span>
          ) : (
            <>
              {kickoff.dayLabel} · <span className="text-ink-200">{kickoff.timeLabel}</span>
            </>
          )}
        </p>
      </div>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onWatch(fixture);
        }}
        className={cn(
          'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-xs font-semibold transition-all duration-300 ease-out-expo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-volt',
          fixture.status === 'live'
            ? 'border border-live bg-live text-void hover:-translate-y-0.5 hover:bg-live-600'
            : 'border border-edge bg-void-800 text-white hover:-translate-y-0.5 hover:border-edge-hi',
        )}
      >
        <Play className="h-3.5 w-3.5" fill="currentColor" />
        {fixture.status === 'live' ? 'Watch' : 'Open'}
      </button>
    </div>
  );
}

function TeamColumn({ badge, name }: { badge: string | null; name: string }) {
  const url = badgeUrl(badge);
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-2xl border border-edge bg-void-800 p-2 transition-transform duration-300 group-hover:scale-105 sm:h-16 sm:w-16">
        <SafeImage
          src={url}
          alt={name}
          width={56}
          height={56}
          fallbackText={initials(name)}
          imgClassName="object-contain"
        />
      </span>
      <span className="line-clamp-2 w-full text-[12px] font-semibold leading-tight text-ink-100 sm:text-[13px]">
        {name}
      </span>
    </div>
  );
}

function TeamStack({
  home,
  away,
  fallbackHome,
  fallbackAway,
}: {
  home: { name: string; badge: string } | null;
  away: { name: string; badge: string } | null;
  fallbackHome: string;
  fallbackAway: string;
}) {
  return (
    <div className="flex shrink-0 -space-x-2">
      {[home, away].map((team, index) => (
        <span
          key={index}
          className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-void-800 p-1.5"
        >
          <SafeImage
            src={badgeUrl(team?.badge ?? null)}
            alt={team?.name ?? (index === 0 ? fallbackHome : fallbackAway)}
            width={36}
            height={36}
            fallbackText={initials(team?.name ?? (index === 0 ? fallbackHome : fallbackAway))}
          />
        </span>
      ))}
    </div>
  );
}

function CardBody({
  fixture,
  sports,
  streams,
  kickoff,
  countdownLabel,
  hd,
  viewerLabel,
  SportIcon,
  onWatch,
}: {
  fixture: Fixture;
  sports: readonly Sport[];
  streams?: readonly StreamDto[];
  kickoff: { dayLabel: string; timeLabel: string };
  countdownLabel: string;
  hd?: boolean;
  viewerLabel: string | null;
  SportIcon: React.ComponentType<{ className?: string }>;
  onWatch: (fixture: Fixture) => void;
}) {
  return (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2">
        {fixture.status === 'live' ? <LivePill /> : <Badge variant="outline">{kickoff.dayLabel} · {kickoff.timeLabel}</Badge>}
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-400">
          <SportIcon className="h-3 w-3" />
          {sportName(fixture.category, sports)}
        </span>
        {hd !== undefined ? <Badge variant={hd ? 'live' : 'neutral'}>{hd ? 'HD' : 'SD'}</Badge> : null}
      </div>
      <p className="mt-2 truncate font-display text-sm font-semibold text-white">{fixture.title}</p>
      <div className="mt-1 flex items-center gap-3 text-[11px] text-ink-400">
        <span className="inline-flex items-center gap-1">
          <Radio className="h-3 w-3" /> {streams?.length ?? fixture.sources.length} feeds
        </span>
        {viewerLabel ? (
          <span className="inline-flex items-center gap-1">
            <Users className="h-3 w-3" /> {viewerLabel}
          </span>
        ) : null}
        {fixture.status === 'upcoming' ? <span className="text-white">{countdownLabel}</span> : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onWatch(fixture);
          }}
          className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-live bg-live px-3 text-[11px] font-bold text-void transition hover:bg-live-600"
        >
          <Play className="h-3 w-3" fill="currentColor" /> Watch
        </button>
      </div>
    </div>
  );
}

