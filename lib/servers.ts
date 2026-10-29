'use client';

import * as React from 'react';
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

  // Order: best quality first, then the freshest feed — but lag is compared in
  // 2-second buckets and the previous order breaks ties. Without that the rows
  // swap places on every refresh (the measured lag moves constantly), which
  // reads as the player switching servers when it is only the ranking moving.
  const orderRef = React.useRef<string[]>([]);
  const servers = React.useMemo(() => {
    const list = [...(query.data ?? [])];
    const position = new Map(orderRef.current.map((id, index) => [id, index]));
    const qualityRank: Record<string, number> = { '2160p': 3, '1080p': 2, '720p': 1, '540p': 0 };
    list.sort((a, b) => {
      const quality = (qualityRank[b.quality] ?? 1) - (qualityRank[a.quality] ?? 1);
      if (quality !== 0) return quality;
      const bucketA = Math.floor(a.edgeAgeSeconds / 2);
      const bucketB = Math.floor(b.edgeAgeSeconds / 2);
      if (bucketA !== bucketB) return bucketA - bucketB;
      return (position.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (position.get(b.id) ?? Number.MAX_SAFE_INTEGER);
    });
    orderRef.current = list.map((server) => server.id);
    return list;
  }, [query.data]);

  return {
    servers,
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
