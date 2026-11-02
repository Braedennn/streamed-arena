'use client';

import * as React from 'react';
import { Check, Copy, Loader2, Radio, RotateCcw, ShieldAlert, ShieldOff, Sparkles } from 'lucide-react';
import { HlsPlayer } from '@/components/arena/HlsPlayer';
import { StreamSwitcher } from '@/components/arena/StreamSwitcher';
import { GameStats } from '@/components/watch/GameStats';
import { useCountdown } from '@/lib/hooks';
import { isFresh, useServerPool } from '@/lib/servers';
import { compactCountdown } from '@/lib/utils';
import type { Fixture } from '@/lib/types';

export function ArenaWatch({ fixture }: { fixture: Fixture }) {
  // The app is the provider.
  //
  // There is one player here and it is the app's own server: it fetches the
  // media ahead of the player, holds it on disk, publishes a playlist of its
  // own and serves every segment itself. The provider is only the way the app
  // reaches the media - it is never named to the player, and its own player
  // is never put on the screen.
  //
  // The pool is resolved even before kick-off: a match that has not started
  // costs one cheap check (no candidate is probed until there is media), and
  // the page switches to the app's own server the moment the feed goes live.
  const pool = useServerPool(fixture.id);
  /** A server the user picked by hand wins over the ranking. */
  const [pinnedDirectId, setPinnedDirectId] = React.useState<string | null>(null);
  const [activeDirectId, setActiveDirectId] = React.useState<string | null>(null);
  const [failedDirectIds, setFailedDirectIds] = React.useState<readonly string[]>([]);
  /** Bumped to remount the player (a fresh start on the same server). */
  const [reloadToken, setReloadToken] = React.useState(0);
  const [copied, setCopied] = React.useState(false);

  const healthyDirect = React.useMemo(
    () => pool.servers.filter((server) => !failedDirectIds.includes(server.id)),
    [pool.servers, failedDirectIds],
  );

  const directServer = React.useMemo(() => {
    if (pinnedDirectId) {
      const pinned = healthyDirect.find((server) => server.id === pinnedDirectId);
      if (pinned) return pinned;
    }
    // Stickiness matters: the pool refreshes every 30s and the ranking moves
    // as the measured lag fluctuates. Re-picking the "best" server on every
    // refresh would restart the player mid-match, so the running one stays
    // until it actually fails.
    if (activeDirectId) {
      const current = healthyDirect.find((server) => server.id === activeDirectId);
      if (current) return current;
    }
    return healthyDirect.find((server) => isFresh(server.edgeAgeSeconds)) ?? healthyDirect[0] ?? null;
  }, [pinnedDirectId, activeDirectId, healthyDirect]);

  // Remember the server we started on so a later refresh keeps it.
  React.useEffect(() => {
    if (pinnedDirectId) return;
    if (directServer && directServer.id !== activeDirectId) setActiveDirectId(directServer.id);
  }, [pinnedDirectId, directServer, activeDirectId]);

  // A server that comes back to life is tried again.
  //
  // The failure list is a list of servers that were down when the player
  // gave up on them. A feed that comes back — the provider switched it on
  // late, or the app's server fetched it after a hiccup — has to be tried
  // again, and the player has to be remounted to ask for it.
  React.useEffect(() => {
    if (failedDirectIds.length === 0) return;
    const recovered = failedDirectIds.some((id) => {
      const server = pool.servers.find((entry) => entry.id === id);
      return server && server.state !== 'error';
    });
    if (!recovered) return;
    setFailedDirectIds((previous) =>
      previous.filter((id) => {
        const server = pool.servers.find((entry) => entry.id === id);
        return server ? server.state === 'error' : false;
      }),
    );
    setReloadToken((value) => value + 1);
  }, [pool.servers, failedDirectIds]);

  // The app's own server starts fetching the feed as soon as the page is
  // open, so the first playlist is there when the player asks for it. When
  // the page is closed the server stops - a feed nobody watches is not worth
  // pulling.
  React.useEffect(() => {
    const key = fixture.id;
    void fetch(`/api/media/subscribe?key=${encodeURIComponent(key)}`, { method: 'POST' }).catch(
      () => undefined,
    );
    return () => {
      void fetch(`/api/media/subscribe?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    };
  }, [fixture.id]);

  const effectiveUrl = directServer?.proxyUrl ?? '';
  // While the app's own server is still starting, wait for it instead of
  // showing anything else - the app's server is the only player there is.
  const waitingForServers = pool.isLoading && !directServer && fixture.status !== 'upcoming';
  const isLoadingStreams = waitingForServers;
  // The provider has not switched this match on yet: there is no media to
  // host, so the server list stays empty on purpose.
  const feedNotStarted = pool.state === 'waiting';
  // The app does not carry this feed at all (see lib/broadcasters.ts). It is
  // not a failure and it will not change, so no player is started.
  const feedRefused = pool.state === 'refused';
  // The app is looking for a feed the provider has no video for right now.
  const feedMissing = pool.state === 'unknown';
  const countdown = useCountdown(fixture.status === 'upcoming' ? fixture.date : null);

  // A dead feed must not end the session: walk to the next server the app
  // runs, and keep looking for one when there is none left.
  const handlePlaybackError = React.useCallback(() => {
    if (!directServer) {
      pool.refresh();
      return;
    }
    const next = healthyDirect.find((server) => server.id !== directServer.id);
    setFailedDirectIds((previous) => [...previous, directServer.id]);
    setPinnedDirectId(null);
    if (next) {
      setActiveDirectId(next.id);
      return;
    }
    setActiveDirectId(null);
  }, [directServer, healthyDirect, pool]);

  const handleSelectDirect = React.useCallback((id: string) => {
    // Picking a server by hand also clears an earlier failure for it, so the
    // user can retry one that just came back to life.
    setFailedDirectIds((previous) => previous.filter((entry) => entry !== id));
    setPinnedDirectId(id);
    setActiveDirectId(id);
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
                  Starting the app’s own server
                </p>
              </div>
            </div>
          ) : feedRefused && !directServer ? (
            /* The app does not carry this feed. Starting a third party's own
               player would only put a feed nobody asked for on the screen. */
            <StreamNotCarried />
          ) : (feedNotStarted || fixture.status === 'upcoming') && !directServer ? (
            /* The provider has not switched the feed on. Its own player would
               only load ads and an offline message, so the app says what is
               really going on and keeps checking for the feed. */
            <StreamStartingSoon countdownLabel={compactCountdown(countdown)} status={fixture.status} />
          ) : !directServer ? (
            /* The app's server is looking for the feed. It hosts the match
               itself - there is no third-party player to fall back to. */
            <StreamNoMedia
              onRetry={() => pool.refresh()}
              status={fixture.status}
              countdownLabel={compactCountdown(countdown)}
              missing={feedMissing}
            />
          ) : (
            <HlsPlayer
              key={`${reloadToken}-${effectiveUrl}`}
              src={effectiveUrl}
              onError={handlePlaybackError}
            />
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
              {directServer.backendLabel}
              {directServer.quality ? ` · ${directServer.quality}` : ''} · {directServer.slotLabel}
            </span>
          ) : null}
        </div>
      </div>

      {/* Phones get player -> servers -> stats; desktop keeps servers as a side rail. */}
      <aside className="min-w-0 rounded-md border border-edge bg-void-800 p-4 lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <StreamSwitcher
          servers={healthyDirect}
          loading={pool.isLoading}
          state={pool.state}
          selectedId={directServer?.id ?? null}
          onSelect={handleSelectDirect}
        />
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

function StreamStartingSoon({
  countdownLabel,
  status,
}: {
  countdownLabel: string;
  status: string;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-void-950 px-6 text-center">
      <div className="max-w-md space-y-4">
        {status === 'upcoming' ? (
          <p className="font-mono text-4xl font-bold tabular-nums text-white sm:text-5xl">
            {countdownLabel}
          </p>
        ) : (
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-md border border-edge bg-void-800">
            <Radio className="h-6 w-6 text-volt" />
          </span>
        )}
        <h3 className="font-display text-lg font-semibold text-white">Stream starting soon</h3>
        <p className="text-xs leading-relaxed text-ink-400">
          The feed has not started yet, so there is nothing to host. This app runs the server
          itself — it starts hosting the feed the moment it goes live, with no reload and no
          third-party player.
        </p>
      </div>
    </div>
  );
}

function StreamNotCarried() {
  return (
    <div className="absolute inset-0 grid place-items-center bg-void-950 px-6 text-center">
      <div className="max-w-md space-y-4">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-md border border-edge bg-void-800">
          <ShieldOff className="h-6 w-6 text-ink-400" />
        </span>
        <h3 className="font-display text-lg font-semibold text-white">Not carried here</h3>
        <p className="text-xs leading-relaxed text-ink-400">
          The arena does not stream this feed, so there is nothing to host. Try another game from
          the arena.
        </p>
      </div>
    </div>
  );
}

function StreamNoMedia({
  onRetry,
  status,
  countdownLabel,
  missing,
}: {
  onRetry: () => void;
  status: string;
  countdownLabel: string;
  missing: boolean;
}) {
  return (
    <div className="absolute inset-0 grid place-items-center bg-void-950 px-6 text-center">
      <div className="max-w-md space-y-4">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-md border border-edge bg-void-800">
          {missing ? <ShieldAlert className="h-6 w-6 text-volt" /> : <Sparkles className="h-6 w-6 text-volt" />}
        </span>
        <h3 className="font-display text-lg font-semibold text-white">The app is hosting this feed</h3>
        <p className="text-xs leading-relaxed text-ink-400">
          {status === 'upcoming'
            ? `The feed opens at kick-off — ${countdownLabel} to go. The app's own server starts fetching it as soon as there is media.`
            : missing
              ? 'There is no video for this feed right now. The app checks again by itself and starts playing the moment there is media — there is no third-party player to fall back to.'
              : 'The app’s own server is looking for this feed. It fetches the media ahead of the player and serves it from its own disk — the moment there is media, it starts playing.'}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="inline-flex items-center gap-2 rounded-md border border-edge px-4 py-2.5 text-xs font-semibold text-white transition hover:border-edge-hi"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Look again
        </button>
      </div>
    </div>
  );
}
