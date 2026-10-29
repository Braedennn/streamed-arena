'use client';

import * as React from 'react';
import { Check, Copy, Loader2, RotateCcw, ShieldAlert, Sparkles } from 'lucide-react';
import { HlsPlayer } from '@/components/arena/HlsPlayer';
import { IframePlayer } from '@/components/arena/IframePlayer';
import { StreamSwitcher } from '@/components/arena/StreamSwitcher';
import { GameStats } from '@/components/watch/GameStats';
import { isHlsUrl } from '@/lib/api';
import { useCountdown, useMatchStreams, useStreamSelection } from '@/lib/hooks';
import { isFresh, useServerPool } from '@/lib/servers';
import { compactCountdown, streamKey } from '@/lib/utils';
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

  // Direct servers: the app resolves every quality/slot/backend combination,
  // probes it and keeps only the ones that answer close to the live edge.
  const pool = useServerPool(fixture.id, fixture.status !== 'upcoming');
  const [directPreference, setDirectPreference] = React.useState<'auto' | 'embed' | string>('auto');
  const [failedDirectIds, setFailedDirectIds] = React.useState<readonly string[]>([]);

  const healthyDirect = React.useMemo(
    () => pool.servers.filter((server) => !failedDirectIds.includes(server.id)),
    [pool.servers, failedDirectIds],
  );

  const directServer = React.useMemo(() => {
    if (directPreference === 'embed') return null;
    if (directPreference === 'auto') {
      return healthyDirect.find((server) => isFresh(server.edgeAgeSeconds)) ?? healthyDirect[0] ?? null;
    }
    return healthyDirect.find((server) => server.id === directPreference) ?? null;
  }, [directPreference, healthyDirect]);

  const [reloadToken, setReloadToken] = React.useState(0);
  const [copied, setCopied] = React.useState(false);

  const embedUrl = selectedStream?.embedUrl ?? '';
  const effectiveUrl = directServer?.proxyUrl ?? embedUrl;
  const useHls = Boolean(directServer) || (Boolean(embedUrl) && isHlsUrl(embedUrl));
  // While the direct pool is still being resolved, wait for it instead of
  // flashing the embed player — the direct feed is cleaner (no ads, no
  // third-party scripts) and it is the path that should win anyway.
  const waitingForServers = pool.isLoading && !directServer;
  const isLoadingStreams =
    waitingForServers || (streamsQuery.isPending && streams.length === 0 && !directServer);
  const streamError = streamsQuery.isError && streams.length === 0 && !directServer;
  const countdown = useCountdown(fixture.status === 'upcoming' ? fixture.date : null);

  // A dead feed must not end the session: walk to the next healthy server
  // (direct first, then the embed players) instead of sitting on an error.
  const handlePlaybackError = React.useCallback(() => {
    if (directServer) {
      const next = healthyDirect.find((server) => server.id !== directServer.id);
      setFailedDirectIds((previous) => [...previous, directServer.id]);
      if (next) {
        setDirectPreference(next.id);
      } else {
        setDirectPreference('embed');
      }
      return;
    }

    // Embed players can't be inspected cross-origin, so rotate them by hand:
    // move to the next server group and let the player remount.
    if (groups.length > 1) {
      const index = groups.findIndex((group) => group.source === source);
      const next = groups[(index + 1) % groups.length];
      if (next) selectSource(next.source);
    }
  }, [directServer, healthyDirect, groups, source, selectSource]);

  const handleSelectDirect = React.useCallback((id: string | null) => {
    if (!id) {
      setDirectPreference('embed');
      return;
    }
    // Picking a server by hand also clears an earlier failure for it, so the
    // user can retry a mirror that just came back to life.
    setFailedDirectIds((previous) => previous.filter((entry) => entry !== id));
    setDirectPreference(id);
  }, []);

  const handleCopy = React.useCallback(() => {
    const payload = effectiveUrl;
    if (!payload) return;
    void navigator.clipboard?.writeText(payload).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }, [effectiveUrl]);

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
          ) : streams.length === 0 && !directServer ? (
            <StreamFailure
              onRetry={() => {
                void streamsQuery.refetch();
                pool.refresh();
              }}
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
            <HlsPlayer
              key={`${reloadToken}-${effectiveUrl}`}
              src={effectiveUrl}
              onError={handlePlaybackError}
            />
          ) : (
            <IframePlayer src={effectiveUrl} title={`${fixture.title} stream player`} reloadToken={reloadToken} />
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <ActionChip
            onClick={() => setReloadToken((value) => value + 1)}
            icon={RotateCcw}
            label="Reload player"
            disabled={!effectiveUrl}
          />
          <ActionChip
            onClick={handleCopy}
            icon={copied ? Check : Copy}
            label={copied ? 'Copied' : 'Copy stream link'}
            disabled={!effectiveUrl}
          />
          {directServer ? (
            <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-volt">
              {directServer.backendLabel} · {directServer.quality} · {directServer.slotLabel}
            </span>
          ) : selectedStream ? (
            <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-ink-500">
              {selectedStream.source} · #{selectedStream.streamNo}
              {selectedStream.language ? ` · ${selectedStream.language}` : ''}
              {selectedStream.hd ? ' · HD' : ''}
            </span>
          ) : null}
        </div>

      </div>

      {/* Phones get player -> servers -> stats; desktop keeps servers as a side rail. */}
      <aside className="min-w-0 rounded-md border border-edge bg-void-800 p-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <StreamSwitcher
          groups={groups}
          selectedSource={source}
          selectedKey={selectedKey}
          onSelectSource={(next) => {
            setDirectPreference('embed');
            selectSource(next);
          }}
          onSelectStream={(next) => {
            setDirectPreference('embed');
            selectStream(next);
          }}
          loading={isLoadingStreams}
          directServers={healthyDirect}
          selectedDirectId={directServer?.id ?? null}
          onSelectDirect={handleSelectDirect}
          directLoading={pool.isLoading}
        />

        {streamError ? (
          <button
            type="button"
            onClick={() => {
              void streamsQuery.refetch();
              pool.refresh();
            }}
            className="mt-4 flex w-full items-center justify-center gap-2 rounded-md border border-flare bg-void-800 px-3 py-2.5 text-xs font-semibold text-flare transition hover:border-flare hover:bg-flare hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry servers
          </button>
        ) : null}
      </aside>

      <div className="min-w-0 lg:col-start-1">
        <GameStats fixture={fixture} />
      </div>
    </div>
  );
}

function ActionChip({
  onClick,
  icon: Icon,
  label,
  disabled = false,
}: {
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-2 rounded-md border border-edge bg-void-800 px-3 py-2 text-xs text-ink-300 transition-all duration-300 hover:-translate-y-0.5 hover:border-edge-hi hover:text-white disabled:pointer-events-none disabled:opacity-40"
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
        {status === 'upcoming' ? (
          <p className="font-mono text-4xl font-bold tabular-nums text-white sm:text-5xl">
            {countdownLabel}
          </p>
        ) : (
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-md border border-flare bg-void-800">
            <ShieldAlert className="h-6 w-6 text-flare" />
          </span>
        )}
        <h3 className="font-display text-lg font-semibold text-white">
          {status === 'upcoming' ? 'Feed opens at kick-off' : 'No streams available right now'}
        </h3>
        <p className="text-xs leading-relaxed text-ink-400">
          {status === 'upcoming'
            ? 'Streams usually appear moments before the whistle. This page checks again every 30 seconds and starts on its own.'
            : 'None of the sources returned a playable stream. This page checks again every 30 seconds — or re-resolve now.'}
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
