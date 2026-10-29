'use client';

import { useQuery } from '@tanstack/react-query';
import type { ServerCandidate } from '@/lib/types';

// Client side of the server pool. The heavy lifting (reading the embed pages,
// probing every quality/slot/backend combination, measuring live-edge lag) all
// happens in the app's own server — see lib/server/streamfree.ts. The renderer
// only ever sees the survivors, already ranked.

export interface ServerPool {
  readonly servers: readonly ServerCandidate[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly refresh: () => void;
}

export function useServerPool(streamKey: string | null, enabled = true): ServerPool {
  const query = useQuery({
    queryKey: ['servers', streamKey ?? 'none'],
    queryFn: async () => {
      const response = await fetch(`/api/servers?key=${encodeURIComponent(streamKey ?? '')}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`Server resolution failed (${response.status})`);
      const payload = (await response.json()) as { servers?: ServerCandidate[] };
      return payload.servers ?? [];
    },
    enabled: enabled && Boolean(streamKey),
    // The pool is a live health report: refresh it while the page is open so
    // a server that dies gets dropped from the list.
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: 1,
  });

  return {
    servers: query.data ?? [],
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
