'use client';

import * as React from 'react';
import { CalendarClock, Play, Radio, Signal, Star, Users } from 'lucide-react';
import { Badge, LivePill } from '@/components/ui/badge';
import { SafeImage } from '@/components/media/SafeImage';
import { badgeUrl } from '@/lib/api';
import { useCountdown } from '@/lib/hooks';
import { useFavorites } from '@/lib/favorites';
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
  const { isFavorite, toggleFavorite } = useFavorites();

  const homeName = home?.name ?? fallback.home;
  const awayName = away?.name ?? fallback.away;

  const hd = streams?.some((stream) => stream.hd);
  // All quality variants share the match-level viewer counter — take max,
  // never sum. Fall back to the board's count before previews resolve.
  const viewerCount = streams
    ? streams.reduce((acc, stream) => Math.max(acc, stream.viewers ?? 0), 0)
    : fixture.viewers;
  const viewerLabel = formatViewers(viewerCount);

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
          <TeamStack
            home={home}
            away={away}
            fallbackHome={fallback.home}
            fallbackAway={fallback.away}
            favoriteHome={isFavorite(homeName)}
            favoriteAway={isFavorite(awayName)}
            onToggleFavorite={toggleFavorite}
          />
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
          />

          <div className="grid grid-cols-[1fr_auto_1fr] items-start gap-2">
            <TeamColumn
              badge={home?.badge ?? null}
              name={homeName}
              favorite={isFavorite(homeName)}
              onToggleFavorite={toggleFavorite}
            />
            <div className="flex flex-col items-center gap-1 pt-3 sm:pt-4">
              <span className="font-display text-[11px] font-bold uppercase tracking-[0.3em] text-ink-500">
                VS
              </span>
              <span className="h-8 w-px bg-edge" />
            </div>
            <TeamColumn
              badge={away?.badge ?? null}
              name={awayName}
              favorite={isFavorite(awayName)}
              onToggleFavorite={toggleFavorite}
            />
          </div>

          <CardFooter
            fixture={fixture}
            kickoff={kickoff}
            countdownLabel={compactCountdown(countdown)}
            streams={streams}
            viewerLabel={viewerLabel}
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
}: {
  fixture: Fixture;
  sports: readonly Sport[];
  SportIcon: React.ComponentType<{ className?: string }>;
  hd?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
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

      <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md border border-edge bg-void-800 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-300">
        <SportIcon className="h-3 w-3 shrink-0 text-volt-400" />
        <span className="truncate">{sportName(fixture.category, sports)}</span>
      </span>

      {hd !== undefined ? (
        <Badge variant={hd ? 'live' : 'neutral'} className="ml-auto shrink-0">
          <Signal className="h-3 w-3" />
          {hd ? 'HD' : 'SD'}
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
  viewerLabel,
  onWatch,
}: {
  fixture: Fixture;
  kickoff: { dayLabel: string; timeLabel: string };
  countdownLabel: string;
  streams?: readonly StreamDto[];
  viewerLabel: string | null;
  onWatch: (fixture: Fixture) => void;
}) {
  const feeds = streams?.length ?? fixture.sources.length;
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
              <span className="text-ink-200">{kickoff.timeLabel}</span> · in{' '}
              <span className="font-semibold text-white">{countdownLabel}</span>
            </>
          ) : fixture.status === 'live' ? (
            <span className="inline-flex items-center gap-1.5 text-live-400">
              <Radio className="h-3 w-3" /> {feeds} feed{feeds === 1 ? '' : 's'}
              {viewerLabel ? (
                <span className="inline-flex items-center gap-1 text-ink-300">
                  <Users className="ml-1 h-3 w-3" /> {viewerLabel}
                </span>
              ) : null}
            </span>
          ) : (
            <>
              Started {kickoff.dayLabel === 'Today' ? '' : `${kickoff.dayLabel} · `}
              <span className="text-ink-200">{kickoff.timeLabel}</span>
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

function TeamColumn({
  badge,
  name,
  favorite,
  onToggleFavorite,
}: {
  badge: string | null;
  name: string;
  favorite: boolean;
  onToggleFavorite: (teamName: string) => void;
}) {
  const url = badgeUrl(badge);
  return (
    <div className="flex min-w-0 flex-col items-center gap-2 text-center">
      <span className="relative grid h-14 w-14 place-items-center rounded-2xl border border-edge bg-void-800 p-2 transition-transform duration-300 group-hover:scale-105 sm:h-16 sm:w-16">
        <SafeImage
          src={url}
          alt={name}
          width={56}
          height={56}
          fallbackText={initials(name)}
          imgClassName="object-contain"
        />
        <span className="absolute -right-2 -top-2 z-10">
          <TeamFavoriteStar
            teamName={name}
            active={favorite}
            onToggle={onToggleFavorite}
          />
        </span>
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
  favoriteHome,
  favoriteAway,
  onToggleFavorite,
}: {
  home: { name: string; badge: string } | null;
  away: { name: string; badge: string } | null;
  fallbackHome: string;
  fallbackAway: string;
  favoriteHome: boolean;
  favoriteAway: boolean;
  onToggleFavorite: (teamName: string) => void;
}) {
  const entries = [
    { team: home, fallback: fallbackHome, name: home?.name ?? fallbackHome, favorite: favoriteHome },
    { team: away, fallback: fallbackAway, name: away?.name ?? fallbackAway, favorite: favoriteAway },
  ];
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      <div className="flex -space-x-2">
        {entries.map((entry, index) => (
          <span
            key={index}
            className="grid h-11 w-11 place-items-center rounded-xl border border-edge bg-void-800 p-1.5"
          >
            <SafeImage
              src={badgeUrl(entry.team?.badge ?? null)}
              alt={entry.name}
              width={36}
              height={36}
              fallbackText={initials(entry.name)}
            />
          </span>
        ))}
      </div>
      <div className="flex flex-col gap-1">
        {entries.map((entry, index) => (
          <TeamFavoriteStar
            key={index}
            teamName={entry.name}
            active={entry.favorite}
            onToggle={onToggleFavorite}
            size="xs"
          />
        ))}
      </div>
    </div>
  );
}

function TeamFavoriteStar({
  teamName,
  active,
  onToggle,
  size = 'sm',
}: {
  teamName: string;
  active: boolean;
  onToggle: (teamName: string) => void;
  size?: 'sm' | 'xs';
}) {
  const action = active ? `Remove ${teamName} from favorites` : `Favorite ${teamName}`;
  return (
    <button
      type="button"
      title={action}
      aria-label={active ? `Unfavorite ${teamName}` : `Favorite ${teamName}`}
      aria-pressed={active}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(teamName);
      }}
      className={cn(
        'grid cursor-pointer place-items-center rounded-full border bg-void-950 transition-all duration-200 hover:scale-110',
        size === 'xs' ? 'h-6 w-6' : 'h-7 w-7',
        active
          ? 'border-volt text-volt'
          : 'border-edge text-ink-500 hover:border-edge-hi hover:text-white',
      )}
    >
      <Star className={size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'} fill={active ? 'currentColor' : 'none'} />
    </button>
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

