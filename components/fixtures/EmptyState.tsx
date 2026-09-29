'use client';

import { CalendarClock, RadioTower, RefreshCw, Sparkles } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useCountdown } from '@/lib/hooks';
import { cn, compactCountdown, kickoffParts, splitTitle } from '@/lib/utils';
import type { Fixture, Sport } from '@/lib/types';

interface EmptyStateProps {
  upcoming: readonly Fixture[];
  sports: readonly Sport[];
  onRefresh: () => void;
  onBrowse: () => void;
}

export function EmptyState({ upcoming, sports, onRefresh, onBrowse }: EmptyStateProps) {
  const next = upcoming.slice(0, 4);

  return (
    <div
      className="animate-enter relative overflow-hidden rounded-3xl border border-edge bg-void-850 p-8 text-center sm:p-14"
    >
      <div className="relative mx-auto max-w-xl space-y-4">
        <span className="mx-auto grid h-16 w-16 place-items-center rounded-2xl border border-edge bg-void-800">
          <RadioTower className="h-7 w-7 text-live-400" />
        </span>
        <h3 className="font-display text-2xl font-semibold text-white sm:text-3xl">
          No Live Streams Currently Active
        </h3>
        <p className="text-sm leading-relaxed text-ink-400">
          The arena is quiet right now. Nothing is broadcasting on your selected filters — here is
          what is locked in next.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
          <Button variant="primary" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" />
            Refresh feed
          </Button>
          <Button variant="outline" onClick={onBrowse}>
            <Sparkles className="h-4 w-4" />
            View upcoming fixtures
          </Button>
        </div>
      </div>

      {next.length > 0 ? (
        <div className="relative mx-auto mt-9 grid max-w-4xl gap-3 text-left sm:grid-cols-2">
          {next.map((fixture) => (
            <UpcomingRow key={fixture.id} fixture={fixture} sports={sports} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function UpcomingRow({ fixture, sports }: { fixture: Fixture; sports: readonly Sport[] }) {
  const countdown = useCountdown(fixture.date);
  const kickoff = kickoffParts(fixture.date, Date.now());
  const fallback = splitTitle(fixture.title);
  const sportLabel =
    sports.find((sport) => sport.id === fixture.category)?.name ?? fixture.category;

  return (
    <div className="flex items-center gap-3 rounded-2xl border border-edge bg-void-800 p-3.5 transition-colors hover:border-edge-hi">
      <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-edge bg-void-700">
        <CalendarClock className="h-4 w-4 text-volt-400" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-white">
          {fixture.home?.name ?? fallback.home} vs {fixture.away?.name ?? fallback.away}
        </p>
        <p className="mt-0.5 text-[11px] uppercase tracking-[0.14em] text-ink-500">
          {sportLabel} · {kickoff.dayLabel} {kickoff.timeLabel}
        </p>
      </div>
      <Badge variant="volt" className={cn('shrink-0')}>
        {compactCountdown(countdown)}
      </Badge>
    </div>
  );
}
