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
  isSourceChannel,
  sourceChannelId,
  touchChannel,
  type ChannelUpstream,
  type MediaChannel,
} from '@/lib/server/media/channels';
import { personalSourceFor, type PersonalSource } from '@/lib/server/media/sources';
import { strictMode } from '@/lib/server/mode';
import { resolveDirectSources } from '@/lib/server/direct/resolve';
import { resolveMatchSources, type SourceResolution } from '@/lib/server/sources/resolve';
import type { ServerCandidate } from '@/lib/types';

const QUALITY_WEIGHT: Record<string, number> = {
  '2160p': 40,
  '1080p': 30,
  '720p': 20,
  '540p': 10,
};

/** How many free channels the list offers at most. */
const MAX_SOURCE_ROWS = 4;

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
  localHost?: string,
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
      // Where this feed comes from, for the server list: the provider's own
      // doors are the way in to the match the provider publishes.
      sourceLabel: 'StreamFree',
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

    rows.push(rowFor(channel, best, undefined, localHost));
  }

  rows.sort((a, b) => b.score - a.score);
  return rows;
}

/**
 * The little mark that names a source in the server list.
 *
 * The words of the name, one letter each: "Free TV index" is FTI, "Pluto TV"
 * is PT. A single word keeps its first three letters.
 */
function sourceMark(label: string): string {
  const words = label.split(/[\s\-_]+/).filter(Boolean);
  if (words.length === 0) return 'SRC';
  if (words.length === 1) return (words[0] ?? 'SRC').slice(0, 3).toUpperCase();
  return words
    .slice(0, 3)
    .map((word) => (word[0] ?? '').toUpperCase())
    .join('');
}

/** The row the server list shows for a personal server. */
export function rowFor(
  channel: MediaChannel,
  measured?: ResolvedServer,
  label?: string,
  localHost?: string,
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
    // A free channel keeps its name when its quality changes: the name is
    // the channel's identity, and a player that is watching it must not be
    // restarted because a measurement moved.
    id: isSourceChannel(channel.id)
      ? `personal-${channel.slot}`
      : `personal-${channel.slot}-${channel.quality}`,
    slot: channel.slot,
    slotLabel: isSourceChannel(channel.id) ? sourceMark(channel.sourceLabel) : `S${channel.slot}`,
    quality: channel.quality,
    backend: 'personal',
    backendLabel: name,
    proxyUrl: `/api/media/manifest?channel=${encodeURIComponent(channel.id)}`,
    latencyMs: channel.latencyMs,
    edgeAgeSeconds: age,
    mediaSequence: channel.mediaSequence || measured?.mediaSequence || 0,
    score: qualityWeight - lag * 0.5,
    label: channel.quality ? `${name} · ${channel.quality}` : name,
    localHost,
    state: channel.state,
    source: channel.sourceLabel || undefined,
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
 * The free channels and the provider feeds of a match, as servers the app runs.
 *
 * Each channel is a server of the app's own: the app fetches it ahead of the
 * player, keeps it on disk and publishes a playlist of its own. The channel
 * is known by its own id, so it keeps its name when the measurements move and
 * the player is never restarted for that.
 *
 * A feed the app cannot fetch is the provider's own player: the match is
 * inside the provider's page. The app shows that page rather than pretending
 * it has nothing - there is nothing to host in that case.
 */
function sourceRows(
  streamKey: string,
  resolution: SourceResolution,
  localHost?: string,
): ServerCandidate[] {
  const rows: ServerCandidate[] = [];

  for (const source of resolution.sources.slice(0, MAX_SOURCE_ROWS)) {
    const candidate = source.candidate;

    // The provider's own player: there is nothing for the app to host.
    if (candidate.playerUrl) {
      rows.push({
        id: `player-${source.id}`,
        slot: source.id,
        slotLabel: sourceMark(candidate.providerLabel),
        quality: source.quality,
        backend: 'personal',
        backendLabel: candidate.title,
        proxyUrl: '',
        playerUrl: candidate.playerUrl,
        latencyMs: source.latencyMs,
        edgeAgeSeconds: source.edgeAgeSeconds,
        mediaSequence: 0,
        score: source.score,
        label: `${candidate.providerLabel} · ${source.quality}`,
        source: candidate.providerLabel,
        localHost,
        state: 'ready',
      });
      continue;
    }

    const isDirect = candidate.providerId === 'direct';
    const providerId = candidate.providerId.startsWith('api:')
      ? candidate.providerId.slice(4)
      : '';
    const eventId = candidate.eventId ?? '';

    const channel = ensureChannel({
      streamKey,
      slot: source.id,
      quality: source.quality,
      id: sourceChannelId(streamKey, source.id),
      sourceLabel: candidate.providerLabel,
      upstreams: [
        {
          serverId: `source-${source.id}`,
          manifestUrl: candidate.manifestUrl,
          referers: candidate.referers,
          personal: false,
          // A free channel is addressed by one address that does not change.
          // A broadcaster's address does change - the app reads the new one
          // instead of giving up on the game. A provider's address carries a
          // token, so it is read again when the feed stops answering.
          fixed: !isDirect && !providerId,
          direct: isDirect,
          provider: providerId && eventId
            ? {
                providerId,
                eventId,
                // The quality the provider gave the feed, not the one it was
                // measured at: the provider is asked again for the same feed
                // when its address stops answering, and it knows its feeds by
                // their own names.
                quality: candidate.quality || source.quality,
                // The page the address came from, when it came from one.
                embedUrl: candidate.identity,
              }
            : undefined,
        },
      ],
    });
    if (!Number.isFinite(channel.measuredAgeSeconds)) {
      channel.measuredAgeSeconds = source.edgeAgeSeconds;
    }
    if (!channel.latencyMs) channel.latencyMs = source.latencyMs;
    touchChannel(channel.id);
    rows.push(rowFor(channel, undefined, candidate.title, localHost));
  }

  return rows;
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
export async function resolvePersonalPool(
  streamKey: string,
  localHost?: string,
): Promise<PersonalPool> {
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
    return { rows: [rowFor(channel, undefined, personal.label, localHost)], state: 'ready' };
  }

  // The app on its own: the feed comes from the broadcaster's own pages and
  // from nowhere else. When the broadcaster cannot be reached, the app says
  // so - it does not fall back to a mirror behind the user's back.
  if (await strictMode()) {
    const direct = await resolveDirectSources(streamKey);
    const rows: ServerCandidate[] = [];

    for (const [index, source] of direct.sources.entries()) {
      const channel = ensureChannel({
        streamKey,
        slot: String(index + 1),
        quality: source.quality,
        sourceLabel: source.carrierLabel,
        upstreams: [
          {
            serverId: `direct-${index}`,
            manifestUrl: source.manifestUrl,
            referers: source.referers,
            personal: false,
            direct: true,
          },
        ],
      });
      if (!Number.isFinite(channel.measuredAgeSeconds)) {
        channel.measuredAgeSeconds = source.edgeAgeSeconds;
      }
      if (!channel.latencyMs) channel.latencyMs = source.latencyMs;
      touchChannel(channel.id);
      rows.push(rowFor(channel, undefined, source.carrierLabel, localHost));
    }

    // The user's own source takes over when the broadcaster has nothing.
    if (rows.length === 0 && personal?.kind === 'default') {
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
      rows.push(rowFor(channel, undefined, personal.label, localHost));
      return { rows, state: 'ready' };
    }

    rows.sort((a, b) => b.score - a.score);
    return { rows, state: direct.state === 'walled' ? 'refused' : direct.state === 'ready' ? 'ready' : 'waiting' };
  }

  // Every source at once: the provider's own doors, the broadcaster's own
  // feed, and the free channels of the network that carries the game.
  //
  // The provider is asked first because it is the one that knows the match
  // by its own name - but it is only one of the ways in. A provider that
  // answers with an advertisement instead of the match is refused by the
  // probe, and the free channels carry the game on their own.
  const [pool, resolution] = await Promise.all([
    resolveServers(streamKey),
    resolveMatchSources(streamKey),
  ]);

  const rows = await personalServers(streamKey, pool, personal ?? undefined, localHost);
  rows.push(...sourceRows(streamKey, resolution, localHost));
  rows.sort((a, b) => b.score - a.score);

  // A pool that has feeds is ready, whatever the provider thinks of the
  // match: the user is watching the game.
  const state: PoolState = rows.length > 0 ? 'ready' : pool.state;
  return { rows, state };
}
