'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { Gauge, Loader2, SignalHigh, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { isFresh, lagLabel } from '@/lib/servers';
import type { ServerCandidate } from '@/lib/types';

interface StreamSwitcherProps {
  /** The servers the app runs — one row per feed it hosts. */
  servers: readonly ServerCandidate[];
  loading: boolean;
  /**
   * Why the list looks the way it does.
   *
   * `waiting` means the provider has not switched the match on yet — there is
   * no media to host. `refused` means the app does not carry this feed at all
   * (see lib/broadcasters.ts). `unknown` means the app is looking for a feed
   * the provider does not have video for right now.
   */
  state: 'ready' | 'waiting' | 'unknown' | 'refused';
  /** The server that is playing, if any. */
  selectedId: string | null;
  onSelect: (id: string) => void;
}

/**
 * The servers this app runs.
 *
 * Every row is a server of the app's own: it fetched the media, it holds it
 * on disk, it publishes the playlist and it answers the player. There is no
 * provider's server in this list, and nothing here is a mirror of somebody
 * else's.
 */
export function StreamSwitcher({
  servers,
  loading,
  state,
  selectedId,
  onSelect,
}: StreamSwitcherProps) {
  const hasServers = servers.length > 0;

  if (loading) {
    return (
      <div className="space-y-3">
        <BlockLabel label="Personal servers" />
        <div className="space-y-2">
          {Array.from({ length: 2 }, (_, index) => (
            <div key={index} className="skeleton h-16 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <BlockLabel
          label="Personal servers"
          hint={
            loading
              ? 'starting'
              : state === 'waiting'
                ? 'not started'
                : state === 'refused'
                  ? 'not carried'
                  : state === 'unknown'
                    ? 'looking'
                    : undefined
          }
          spin={loading}
        />
        <div className="space-y-2">
          {servers.map((server) => {
            const active = server.id === selectedId;
            const fresh = isFresh(server.edgeAgeSeconds);
            return (
              <motion.button
                key={server.id}
                type="button"
                onClick={() => onSelect(server.id)}
                whileTap={{ scale: 0.985 }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all duration-300 ease-out-expo',
                  active
                    ? 'border-volt bg-void-800'
                    : 'border-edge bg-void-800 hover:border-edge-hi hover:bg-void-700',
                )}
              >
                <span
                  className={cn(
                    'grid h-9 w-9 shrink-0 place-items-center rounded-lg border font-mono text-[10px] font-bold',
                    active
                      ? 'border-volt bg-void-950 text-volt'
                      : 'border-edge bg-void-700 text-ink-400',
                  )}
                >
                  {server.slotLabel}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-white">
                      {server.backendLabel}
                    </span>
                    {server.quality ? (
                      <span className="rounded-md bg-live px-1.5 py-0.5 font-mono text-[9px] font-bold text-void">
                        {server.quality}
                      </span>
                    ) : null}
                    {server.localHost ? (
                      <span
                        className="truncate rounded-md border border-edge bg-void-700 px-1.5 py-0.5 font-mono text-[9px] font-bold text-ink-300"
                        title="Served by this app, on this machine"
                      >
                        {server.localHost}
                      </span>
                    ) : null}
                  </span>
                  <span className="mt-1 flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-ink-500">
                    {server.state === 'warming' ? (
                      <span className="inline-flex items-center gap-1 text-ink-400">
                        <Loader2 className="h-3 w-3 animate-spin" />
                        fetching
                      </span>
                    ) : server.state === 'error' ? (
                      <span className="inline-flex items-center gap-1 text-flare">
                        <SignalHigh className="h-3 w-3" />
                        offline
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Gauge className="h-3 w-3" />
                        {lagLabel(server.edgeAgeSeconds)}
                      </span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <Zap className="h-3 w-3" />
                      {server.latencyMs}ms
                    </span>
                  </span>
                </span>

                {active ? (
                  <SignalHigh className="h-4 w-4 shrink-0 text-volt" />
                ) : fresh ? (
                  <span className="shrink-0 rounded-md border border-live bg-live/10 px-1.5 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.12em] text-live">
                    live
                  </span>
                ) : null}
              </motion.button>
            );
          })}

          {!hasServers ? (
            <p className="rounded-xl border border-dashed border-edge px-3 py-4 text-center text-[11px] leading-relaxed text-ink-500">
              {state === 'refused'
                ? 'This feed is not carried here — the arena does not stream it.'
                : state === 'waiting'
                  ? 'The feed has not started yet. The app’s own server hosts it the moment there is media — no reload needed.'
                  : state === 'unknown'
                    ? 'The app’s own server is looking for this feed. It hosts the match itself: as soon as there is media, the app serves it from its own disk.'
                    : 'The app’s own server has nothing to serve yet.'}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BlockLabel({ label, hint, spin = false }: { label: string; hint?: string; spin?: boolean }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-500">{label}</p>
      {hint ? (
        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-ink-500">
          {spin ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {hint}
        </span>
      ) : null}
    </div>
  );
}
