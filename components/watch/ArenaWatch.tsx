'use client';

import * as React from 'react';
import {
  Check,
  Copy,
  Loader2,
  RotateCcw,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { HlsPlayer } from '@/components/arena/HlsPlayer';
import { IframePlayer } from '@/components/arena/IframePlayer';
import { StreamSwitcher } from '@/components/arena/StreamSwitcher';
import { GameStats } from '@/components/watch/GameStats';
import { badgeUrl, isHlsUrl } from '@/lib/api';
import { useCountdown, useMatchStreams, useStreamSelection } from '@/lib/hooks';
import { compactCountdown, splitTitle, streamKey } from '@/lib/utils';
import type { Fixture } from '@/lib/types';

export function ArenaWatch({ fixture }: { fixture: Fixture }) {
  const streamsQuery = useMatchStreams(fixture.sources, true);
  const streams = React.useMemo(() => streamsQuery.data ?? [], [streamsQuery.data]);
  const { groups, source, selectedKey, selectSource, selectStream } = useStreamSelection(
    streams,
    fixture.id,
  );
  const selectedStream =
    streams.find(
      (stream) => streamKey(stream.source, stream.streamNo, stream.id) === selectedKey,
    ) ?? null;

  const [manualUrl, setManualUrl] = React.useState('');
  const [copied, setCopied] = React.useState(false);

  const effectiveUrl = manualUrl || selectedStream?.embedUrl || '';
  const useHls = Boolean(effectiveUrl) && isHlsUrl(effectiveUrl);
  const isLoadingStreams = streamsQuery.isPending && streams.length === 0;
  const streamError = streamsQuery.isError && streams.length === 0;
  const countdown = useCountdown(fixture.status === 'upcoming' ? fixture.date : null);

  const handleCopy = React.useCallback(() => {
    const payload = manualUrl || selectedStream?.embedUrl || '';
    if (!payload) return;
    void navigator.clipboard?.writeText(payload).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [manualUrl, selectedStream]);

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-4">
        <div className="relative aspect-video w-full overflow-hidden rounded-md border border-edge bg-void-950">
          {isLoadingStreams ? (
            <div className="absolute inset-0 grid place-items-center bg-void-950">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-7 w-7 animate-spin text-live" />
                <p className="text-[11px] uppercase tracking-[0.28em] text-ink-400">
                  Resolving stream sources
                </p>
              </div>
            </div>
          ) : streamError && !effectiveUrl ? (
            <StreamFailure
              onRetry={() => void streamsQuery.refetch()}
              status={fixture.status}
              countdownLabel={compactCountdown(countdown)}
              sources={fixture.sources.map((entry) => entry.source)}
            />
          ) : !effectiveUrl ? (
            <div className="absolute inset-0 grid place-items-center bg-void-950 px-6 text-center">
              <div className="space-y-3">
                <Sparkles className="mx-auto h-7 w-7 text-volt" />
                <p className="text-sm text-ink-300">
                  No playable channel selected yet — pick a server on the right.
                </p>
              </div>
            </div>
          ) : useHls ? (
            <HlsPlayer src={effectiveUrl} />
          ) : (
            <IframePlayer src={effectiveUrl} title={`${fixture.title} stream player`} reloadToken={0} />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ActionChip onClick={() => setManualUrl('')} icon={RotateCcw} label="Reset feed" />
          <ActionChip onClick={handleCopy} icon={copied ? Check : Copy} label={copied ? 'Copied' : 'Copy link'} />
        </div>

        <GameStats fixture={fixture} />
      </div>

      <aside className="min-w-0 rounded-md border border-edge bg-void-800 p-4">
        <StreamSwitcher
          groups={groups}
          selectedSource={source}
          selectedKey={selectedKey}
          onSelectSource={selectSource}
          onSelectStream={selectStream}
          loading={isLoadingStreams}
        />

        {streamError ? (
          <button
            type="button"
            onClick={() => void streamsQuery.refetch()}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-md border border-flare bg-void-800 px-3 py-2.5 text-xs font-semibold text-flare transition hover:border-flare hover:bg-flare hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry servers
          </button>
        ) : null}
      </aside>
    </div>
  );
}

function ActionChip({
  onClick,
  icon: Icon,
  label,
}: {
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-md border border-edge bg-void-800 px-3 py-2 text-xs text-ink-300 transition-all duration-300 hover:-translate-y-0.5 hover:border-edge-hi hover:text-white"
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function StreamFailure({
  onRetry,
  status,
  countdownLabel,
  sources,
}: {
  onRetry: () => void;
  status: string;
  countdownLabel: string;
  sources: string[];
}) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-void-950 px-6 text-center">
      <div className="max-w-md space-y-4">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-md border border-flare bg-void-800">
          <ShieldAlert className="h-6 w-6 text-flare" />
        </span>
        <h3 className="font-display text-lg font-semibold text-white">
          {status === 'upcoming' ? 'Feed opens at kick-off' : 'All servers are unresponsive'}
        </h3>
        <p className="text-xs leading-relaxed text-ink-400">
          {status === 'upcoming'
            ? `Streams for this fixture usually appear moments before the whistle — kickoff in ${countdownLabel}.`
            : 'Every source failed to respond. Try re-resolving the sources or check back closer to kick-off.'}
        </p>
        {sources.length > 0 ? (
          <div className="flex flex-wrap justify-center gap-1.5">
            {sources.map((name) => (
              <span
                key={name}
                className="rounded-md border border-edge bg-void-800 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-ink-400"
              >
                {name}
              </span>
            ))}
          </div>
        ) : null}
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-md border border-edge px-4 py-2.5 text-xs font-semibold text-white transition hover:border-edge-hi"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Re-resolve sources
        </button>
      </div>
    </div>
  );
}
