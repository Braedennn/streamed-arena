// The servers the app itself runs.
//
// The pool the app used to show was a list of the provider's own doors - the
// CDN, the origin and the mirror. They are the same files on the same
// machines, so choosing between them changed nothing: the list looked like
// a choice between servers and was really a list of one server with three
// names.
//
// What the app shows now is what it actually runs: a personal server. One
// per feed, hosted by the app's own server, publishing a playlist the app
// wrote and serving media the app fetched. The provider is behind it and is
// nobody's business - the player is only ever told about this app.
//
// The doors are still used, but as what they are: the ways the personal
// server reaches the media. The best one is used first, and when it stops
// answering the server moves to the next one on its own.

import { providerReferers } from '@/lib/server/provider';
import { resolveServers, type PoolState, type ResolvedPool, type ResolvedServer } from '@/lib/server/streamfree';
import {
  ensureChannel,
  touchChannel,
  type ChannelUpstream,
  type MediaChannel,
} from '@/lib/server/media/channels';
import { personalSourceFor, type PersonalSource } from '@/lib/server/media/sources';
import type { ServerCandidate } from '@/lib/types';

const QUALITY_WEIGHT: Record<string, number> = {
  '2160p': 40,
  '1080p': 30,
  '720p': 20,
  '540p': 10,
};

/** The feed a personal server hosts: one source slot at one quality. */
function feedKey(server: Pick<ServerCandidate, 'slot' | 'quality'>): string {
  return `${server.slot}-${server.quality}`;
}

function referersFor(manifestUrl: string): string[] {
  try {
    return providerReferers(new URL(manifestUrl).hostname);
  } catch {
    return [''];
  }
}

/**
 * The personal servers of a match.
 *
 * One per feed: the slots and qualities the app can reach, each hosted by the
 * app's own server. The doors behind a feed are kept in the order they
 * measured, so the server can move to the next one when the first stops
 * answering.
 */
export async function personalServers(
  streamKey: string,
  pool: ResolvedPool,
  fallback?: PersonalSource,
): Promise<ServerCandidate[]> {
  const feeds = new Map<string, ResolvedServer[]>();
  for (const server of pool.servers) {
    const key = feedKey(server);
    const list = feeds.get(key);
    if (list) list.push(server);
    else feeds.set(key, [server]);
  }

  const rows: ServerCandidate[] = [];

  for (const servers of feeds.values()) {
    // The best measured door first, the rest as the way out when it dies.
    const ordered = [...servers].sort((a, b) => b.score - a.score);
    const best = ordered[0];
    if (!best) continue;

    const upstreams: ChannelUpstream[] = [];
    for (const server of ordered) {
      upstreams.push({
        serverId: server.id,
        manifestUrl: server.manifestUrl,
        referers: referersFor(server.manifestUrl),
        personal: false,
      });
    }
    // A fallback of the user's own comes last: the provider is used while it
    // works, and this one takes over when it does not.
    if (fallback) {
      upstreams.push({
        serverId: 'personal',
        manifestUrl: fallback.url,
        referers: fallback.referer ? [fallback.referer, ''] : [''],
        personal: true,
      });
    }

    const channel = ensureChannel({
      streamKey,
      slot: best.slot,
      quality: best.quality,
      upstreams,
    });
    // What the probe measured is the truth until the server has fetched
    // something of its own.
    if (!Number.isFinite(channel.measuredAgeSeconds)) {
      channel.measuredAgeSeconds = best.edgeAgeSeconds;
    }
    if (!channel.latencyMs) channel.latencyMs = best.latencyMs;
    // The page is open and asking about this match: the server keeps
    // fetching for as long as that goes on.
    touchChannel(channel.id);

    rows.push(rowFor(channel, best));
  }

  rows.sort((a, b) => b.score - a.score);
  return rows;
}

/** The row the server list shows for a personal server. */
export function rowFor(
  channel: MediaChannel,
  measured?: ResolvedServer,
  label?: string,
): ServerCandidate {
  const age = Number.isFinite(channel.edgeAgeSeconds)
    ? channel.edgeAgeSeconds
    : Number.isFinite(channel.measuredAgeSeconds)
      ? channel.measuredAgeSeconds
      : 90;
  const qualityWeight = QUALITY_WEIGHT[channel.quality] ?? 12;
  const lag = Number.isFinite(age) ? Math.min(age, 90) : 90;
  const name = label ?? 'Personal server';

  return {
    id: `personal-${channel.slot}-${channel.quality}`,
    slot: channel.slot,
    slotLabel: `S${channel.slot}`,
    quality: channel.quality,
    backend: 'personal',
    backendLabel: name,
    proxyUrl: `/api/media/manifest?channel=${encodeURIComponent(channel.id)}`,
    latencyMs: channel.latencyMs,
    edgeAgeSeconds: age,
    mediaSequence: channel.mediaSequence || measured?.mediaSequence || 0,
    score: qualityWeight - lag * 0.5,
    label: channel.quality ? `${name} · ${channel.quality}` : name,
    state: channel.state,
  };
}

/** Re-reads a channel and refreshes its row. */
export function refreshRow(channel: MediaChannel): ServerCandidate {
  return rowFor(channel);
}

export interface PersonalPool {
  readonly rows: ServerCandidate[];
  /** Why the pool looks the way it does. */
  readonly state: PoolState;
}

/**
 * The personal servers of a match.
 *
 * The app resolves what is out there, measures it, and turns every feed it
 * found into a server it hosts itself.
 *
 * A source the user set for this one match wins outright: the app hosts it
 * and does not ask a third party anything.
 */
export async function resolvePersonalPool(streamKey: string): Promise<PersonalPool> {
  const personal = await personalSourceFor(streamKey);

  if (personal?.kind === 'match') {
    const channel = ensureChannel({
      streamKey,
      slot: '1',
      quality: '',
      upstreams: [
        {
          serverId: 'personal',
          manifestUrl: personal.url,
          referers: personal.referer ? [personal.referer, ''] : [''],
          personal: true,
        },
      ],
    });
    touchChannel(channel.id);
    return { rows: [rowFor(channel, undefined, personal.label)], state: 'ready' };
  }

  const pool = await resolveServers(streamKey);
  const rows = await personalServers(streamKey, pool, personal ?? undefined);
  return { rows, state: pool.state };
}
