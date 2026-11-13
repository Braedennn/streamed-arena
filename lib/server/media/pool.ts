// The servers the app itself runs.
//
// The pool the app used to show was a list of the provider's own doors - the
// CDN, the origin and the mirror. They are the same files on the same
// machines, so choosing between them changed nothing: the list looked like
// a choice between servers and was really a list of one server with three
// names.
//
// What the app shows now is what it actually runs: a personal server. One
// per match, hosted by the app's own server, publishing a playlist the app
// wrote and serving media the app fetched. The provider is behind it and is
// nobody's business - the player is only ever told about this app.
//
// The doors are still used, but as what they are: the ways the personal
// server reaches the media. A match has many of them - every provider that
// publishes the game, and the broadcaster's own pages - and the best one is
// read first. When the one being read stops answering, the server moves to
// the next one by itself: a feed that dies in the middle of a game is a cut,
// not the end of the game.

import { providerReferers } from '@/lib/server/provider';
import { resolveServers, type PoolState, type ResolvedPool, type ResolvedServer } from '@/lib/server/streamfree';
import {
  ensureChannel,
  isSourceChannel,
  MATCH_SLOT,
  sourceChannelId,
  touchChannel,
  type ChannelUpstream,
  type MediaChannel,
} from '@/lib/server/media/channels';
import { personalSourceFor, type PersonalSource } from '@/lib/server/media/sources';
import { strictMode } from '@/lib/server/mode';
import { resolveDirectSources } from '@/lib/server/direct/resolve';
import { resolveMatchSources, type SourceResolution } from '@/lib/server/sources/resolve';
import { isHdQuality, noteFeedCount } from '@/lib/server/sources/counts';
import { upstreamOf } from '@/lib/server/media/upstream';
import type { ServerCandidate } from '@/lib/types';

const QUALITY_WEIGHT: Record<string, number> = {
  '2160p': 40,
  '1080p': 30,
  '720p': 20,
  '540p': 10,
};

function referersFor(manifestUrl: string): string[] {
  try {
    return providerReferers(new URL(manifestUrl).hostname);
  } catch {
    return [''];
  }
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
  const name = label || channel.feedLabel || channel.sourceLabel || 'Personal server';

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
    channelId: channel.id,
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
 * The provider's own doors of a feed, as doors the channel can open.
 *
 * These are the same files on the same machines: the CDN, the origin and the
 * mirror of one feed. They are kept as doors of the match's channel, so the
 * app has a way in even when the address the provider's API handed out is
 * gone.
 */
function upstreamOfServer(server: ResolvedServer): ChannelUpstream {
  return {
    serverId: server.id,
    manifestUrl: server.manifestUrl,
    referers: referersFor(server.manifestUrl),
    personal: false,
    quality: server.quality,
    label: server.label,
    providerLabel: server.backendLabel,
  };
}

/**
 * The personal server of a match.
 *
 * One channel per match: the doors behind it are the feeds of that match -
 * every provider that publishes it and, when the app is on its own, the
 * broadcaster's own pages. The app reads the best one and moves to the next
 * by itself when it stops answering, so the player keeps its address and the
 * game keeps playing.
 */
function matchChannel(
  streamKey: string,
  resolution: SourceResolution,
  pool: ResolvedPool,
  fallback?: PersonalSource,
  localHost?: string,
): ServerCandidate | null {
  // Every way to the media, the best measured one first. The doors of the
  // provider's own pages and the feeds every provider publishes are one
  // list: they are all doors to the same game.
  const doors: { upstream: ChannelUpstream; score: number }[] = [];

  for (const server of pool.servers) {
    doors.push({ upstream: upstreamOfServer(server), score: server.score });
  }
  for (const source of resolution.sources) {
    const upstream = upstreamOf(source);
    if (!upstream) continue;
    doors.push({ upstream, score: source.score });
  }
  // A fallback of the user's own comes last: it takes over when every door
  // of the providers stops answering.
  if (fallback) {
    doors.push({
      upstream: {
        serverId: 'personal',
        manifestUrl: fallback.url,
        referers: fallback.referer ? [fallback.referer, ''] : [''],
        personal: true,
        quality: '',
        label: fallback.label,
        providerLabel: fallback.label,
      },
      score: -1_000,
    });
  }

  if (doors.length === 0) return null;
  doors.sort((a, b) => b.score - a.score);

  const best = doors[0];
  if (!best) return null;

  const channel = ensureChannel({
    streamKey,
    slot: MATCH_SLOT,
    quality: best.upstream.quality ?? '',
    id: sourceChannelId(streamKey, MATCH_SLOT),
    sourceLabel: best.upstream.providerLabel ?? '',
    upstreams: doors.map((door) => door.upstream),
  });
  // What the probe measured is the truth until the server has fetched
  // something of its own.
  const measured = resolution.sources[0];
  if (measured && !Number.isFinite(channel.measuredAgeSeconds)) {
    channel.measuredAgeSeconds = measured.edgeAgeSeconds;
  }
  if (measured && !channel.latencyMs) channel.latencyMs = measured.latencyMs;
  // The page is open and asking about this match: the server keeps
  // fetching for as long as that goes on.
  touchChannel(channel.id);

  return rowFor(channel, undefined, undefined, localHost);
}

/**
 * The personal servers of a match.
 *
 * The app resolves what is out there, measures it, and turns every feed it
 * found into a door of the match's own server. The best door is read first
 * and the rest are the way out when it stops answering.
 */
export async function resolvePersonalPool(
  streamKey: string,
  localHost?: string,
): Promise<PersonalPool> {
  const personal = await personalSourceFor(streamKey);

  if (personal?.kind === 'match') {
    const channel = ensureChannel({
      streamKey,
      slot: MATCH_SLOT,
      quality: '',
      id: sourceChannelId(streamKey, MATCH_SLOT),
      sourceLabel: personal.label,
      upstreams: [
        {
          serverId: 'personal',
          manifestUrl: personal.url,
          referers: personal.referer ? [personal.referer, ''] : [''],
          personal: true,
          label: personal.label,
          providerLabel: personal.label,
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

    const upstreams: ChannelUpstream[] = direct.sources.map((source, index) => ({
      serverId: `direct-${index}`,
      manifestUrl: source.manifestUrl,
      referers: source.referers,
      personal: false,
      direct: true,
      quality: source.quality,
      label: source.title || source.carrierLabel,
      providerLabel: source.carrierLabel,
    }));
    if (personal?.kind === 'default') {
      upstreams.push({
        serverId: 'personal',
        manifestUrl: personal.url,
        referers: personal.referer ? [personal.referer, ''] : [''],
        personal: true,
        label: personal.label,
        providerLabel: personal.label,
      });
    }

    if (upstreams.length > 0) {
      const channel = ensureChannel({
        streamKey,
        slot: MATCH_SLOT,
        quality: direct.sources[0]?.quality ?? '',
        id: sourceChannelId(streamKey, MATCH_SLOT),
        sourceLabel: direct.sources[0]?.carrierLabel ?? '',
        upstreams,
      });
      const measured = direct.sources[0];
      if (measured && !Number.isFinite(channel.measuredAgeSeconds)) {
        channel.measuredAgeSeconds = measured.edgeAgeSeconds;
      }
      if (measured && !channel.latencyMs) channel.latencyMs = measured.latencyMs;
      touchChannel(channel.id);
      rows.push(rowFor(channel, undefined, undefined, localHost));
    }

    // The user's own source takes over when the broadcaster has nothing.
    if (rows.length === 0 && personal?.kind === 'default') {
      const channel = ensureChannel({
        streamKey,
        slot: MATCH_SLOT,
        quality: '',
        id: sourceChannelId(streamKey, MATCH_SLOT),
        sourceLabel: personal.label,
        upstreams: [
          {
            serverId: 'personal',
            manifestUrl: personal.url,
            referers: personal.referer ? [personal.referer, ''] : [''],
            personal: true,
            label: personal.label,
            providerLabel: personal.label,
          },
        ],
      });
      touchChannel(channel.id);
      rows.push(rowFor(channel, undefined, personal.label, localHost));
      return { rows, state: 'ready' };
    }

    rows.sort((a, b) => b.score - a.score);
    return {
      rows,
      state: direct.state === 'walled' ? 'refused' : direct.state === 'ready' ? 'ready' : 'waiting',
    };
  }

  // Every source at once: the provider's own doors, the feeds every provider
  // publishes, and the broadcaster's own pages.
  //
  // The provider is asked first because it is the one that knows the match
  // by its own name - but it is only one of the ways in. A provider that
  // answers with an advertisement instead of the match is refused by the
  // probe, and the other doors carry the game on their own.
  const [pool, resolution] = await Promise.all([
    resolveServers(streamKey),
    resolveMatchSources(streamKey),
  ]);

  // What the app measured for this match is the truth about its feeds, and
  // the board shows it: the card of a match the user has opened carries the
  // number of feeds that really played.
  //
  // A measurement that found nothing is not written over what the providers
  // publish: the providers still publish those feeds - the app could not
  // play them from this machine - and the board should not tell the user
  // that the match has none.
  noteFeedCount(
    streamKey,
    resolution.sources.length,
    resolution.sources.some((source) => isHdQuality(source.quality)),
  );

  const row = matchChannel(streamKey, resolution, pool, personal ?? undefined, localHost);
  const rows = row ? [row] : [];

  // A pool that has feeds is ready, whatever the provider thinks of the
  // match: the user is watching the game.
  const state: PoolState = rows.length > 0 ? 'ready' : pool.state;
  return { rows, state };
}
