'use client';

import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import type { ServerCandidate } from '@/lib/types';

// Client side of the server pool. The heavy lifting (reading the embed pages,
// probing every quality/slot/backend combination, measuring live-edge lag) all
// happens in the app's own server — see lib/server/streamfree.ts. The renderer
// only ever sees the survivors, already ranked.

export interface ServerPool {
  /** Every healthy mirror, ranked. Used for failover. */
  readonly servers: readonly ServerCandidate[];
  /**
   * The mirrors the list shows: one row per mirror (the CDN / Origin / Mirror
   * copies of a feed), capped so the rail stays short.
   */
  readonly rows: readonly ServerCandidate[];
  /**
   * Why the pool looks the way it does.
   *
   * `waiting` means the provider has not switched the match on yet — there is
   * no media to play, and the pool keeps checking so the feed appears by
   * itself the moment it starts.
   */
  readonly state: 'ready' | 'waiting' | 'unknown';
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly refresh: () => void;
}

/** How many mirrors the server list shows at most. */
export const MAX_SERVER_ROWS = 6;

/** The feed a mirror belongs to: slot + quality. */
export function serverGroupId(server: Pick<ServerCandidate, 'slot' | 'quality'>): string {
  return `${server.slot}-${server.quality}`;
}

/**
 * The rows the list shows.
 *
 * One row per mirror: a feed is served by several mirrors (CDN, Origin,
 * Mirror) and the user picks between them. The list is capped so a match
 * with many feeds cannot turn the rail into a wall of buttons — the mirrors
 * that do not fit stay behind the scenes for automatic failover.
 */
export function serverRows(
  servers: readonly ServerCandidate[],
  limit = MAX_SERVER_ROWS,
): ServerCandidate[] {
  return servers.slice(0, limit);
}

export function useServerPool(streamKey: string | null, enabled = true): ServerPool {
  const query = useQuery({
    queryKey: ['servers', streamKey ?? 'none'],
    queryFn: async () => {
      const response = await fetch(`/api/servers?key=${encodeURIComponent(streamKey ?? '')}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Server resolution failed (${response.status})`);
      const payload = (await response.json()) as {
        servers?: ServerCandidate[];
        state?: 'ready' | 'waiting' | 'unknown';
      };
      return { servers: payload.servers ?? [], state: payload.state ?? 'unknown' };
    },
    enabled: enabled && Boolean(streamKey),
    // The pool is a live health report: refresh it while the page is open so
    // a server that dies gets dropped from the list. A match that has not
    // started yet is checked faster, because that is the moment the feed
    // appears and the page should pick it up without a reload.
    staleTime: 15_000,
    refetchInterval: (report) => (report.state.data?.state === 'waiting' ? 15_000 : 30_000),
    retry: 1,
  });

  // Order: the best feed first — quality, and a feed that has fallen behind
  // the live edge goes below the ones that are still fresh. Inside a feed the
  // mirrors keep their place: the measured lag wobbles by a second or two
  // between health checks, and rows that swap places on every refresh read as
  // the player switching servers when it is only the ranking moving.
  const orderRef = React.useRef<string[]>([]);
  const servers = React.useMemo(() => {
    // The same mirror can arrive twice if the resolver changed shape — the id
    // is the identity, so keep the first and drop the rest.
    const seen = new Set<string>();
    const list: ServerCandidate[] = [];
    for (const server of query.data?.servers ?? []) {
      if (seen.has(server.id)) continue;
      seen.add(server.id);
      list.push(server);
    }
    const position = new Map(orderRef.current.map((id, index) => [id, index]));
    // The mirrors of one feed stay together: the list reads as "this feed,
    // served by three mirrors" instead of mixing the feeds up.
    const slotOrder = new Map<string, number>();
    orderRef.current.forEach((id, index) => {
      const slot = id.split('-')[0] ?? '';
      if (slot && !slotOrder.has(slot)) slotOrder.set(slot, index);
    });
    const qualityRank: Record<string, number> = { '2160p': 3, '1080p': 2, '720p': 1, '540p': 0 };
    const tier = (server: ServerCandidate) =>
      (isFresh(server.edgeAgeSeconds) ? 10 : 0) + (qualityRank[server.quality] ?? 1);
    list.sort((a, b) => {
      const tierA = tier(a);
      const tierB = tier(b);
      if (tierA !== tierB) return tierB - tierA;
      const slotA = slotOrder.get(a.slot) ?? Number.MAX_SAFE_INTEGER;
      const slotB = slotOrder.get(b.slot) ?? Number.MAX_SAFE_INTEGER;
      if (slotA !== slotB) return slotA - slotB;
      return (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER);
    });
    orderRef.current = list.map((server) => server.id);
    return list;
  }, [query.data]);

  return {
    servers,
    rows: serverRows(servers),
    state: query.data?.state ?? 'unknown',
    isLoading: query.isPending && Boolean(streamKey),
    isError: query.isError,
    refresh: () => void query.refetch(),
  };
}

/** Human-readable lag badge: fresh feeds read as "LIVE", stale ones in seconds. */
export function lagLabel(edgeAgeSeconds: number): string {
  if (!Number.isFinite(edgeAgeSeconds)) return 'STALE';
  if (edgeAgeSeconds <= 3) return 'LIVE';
  if (edgeAgeSeconds < 60) return `+${Math.round(edgeAgeSeconds)}s`;
  const minutes = Math.floor(edgeAgeSeconds / 60);
  return `+${minutes}m`;
}

/** True when a server is close enough to the live edge to be worth showing first. */
export function isFresh(edgeAgeSeconds: number): boolean {
  return Number.isFinite(edgeAgeSeconds) && edgeAgeSeconds <= 12;
}
