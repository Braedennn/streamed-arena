'use client';

import * as React from 'react';
import { Gauge, Loader2, SignalHigh, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { lagLabel } from '@/lib/servers';
import type { ServerCandidate } from '@/lib/types';

interface StreamSwitcherProps {
  /** The server that is playing — the app picked the best one and keeps it. */
  server: ServerCandidate | null;
  loading: boolean;
  /**
   * Why the panel looks the way it does.
   *
   * `waiting` means the provider has not switched the match on yet — there is
   * no media to host. `refused` means the app does not carry this feed at all
   * (see lib/broadcasters.ts). `unknown` means the app is looking for a feed
   * the provider does not have video for right now.
   */
  state: 'ready' | 'waiting' | 'unknown' | 'refused';
}

/**
 * The server the app is serving this match from.
 *
 * There is one stream on the screen and it is the app's own: it fetched the
 * media, it holds it on disk, it publishes the playlist and it answers the
 * player. When a feed stops answering, the app walks to its next one by
 * itself and this panel keeps showing the one that is on.
 */
export function StreamSwitcher({ server, loading, state }: StreamSwitcherProps) {
  if (loading) {
    return (
      <div className="space-y-3">
        <BlockLabel label="Personal server" hint="starting" spin />
        <div className="skeleton h-16 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div>
      <BlockLabel
        label="Personal server"
        hint={
          server
            ? undefined
            : state === 'waiting'
              ? 'not started'
              : state === 'refused'
                ? 'not carried'
                : state === 'unknown'
                  ? 'looking'
                  : undefined
        }
      />
      {server ? (
        <div
          className={cn(
            'flex w-full items-center gap-3 rounded-xl border border-volt bg-void-800 p-3 text-left',
          )}
        >
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-volt bg-void-950 font-mono text-[10px] font-bold text-volt">
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
              {server.source ? (
                <span
                  className="truncate rounded-md border border-edge bg-void-700 px-1.5 py-0.5 font-mono text-[9px] font-bold text-ink-300"
                  title="Where this feed comes from"
                >
                  {server.source}
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
              <span className="inline-flex items-center gap-1 text-volt">
                <SignalHigh className="h-3 w-3" />
                on air
              </span>
            </span>
          </span>
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-edge px-3 py-4 text-center text-[11px] leading-relaxed text-ink-500">
          {state === 'refused'
            ? 'This feed is not carried here — the arena does not stream it.'
            : state === 'waiting'
              ? 'The feed has not started yet. The app’s own server hosts it the moment there is media — no reload needed.'
              : state === 'unknown'
                ? 'The app’s own server is looking for this feed. It hosts the match itself: as soon as there is media, the app serves it from its own disk.'
                : 'The app’s own server has nothing to serve yet.'}
        </p>
      )}
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
