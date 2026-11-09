// The feeds of a match, from every source the app knows.
//
// The app does not depend on one service any more. It asks all of them:
//   - the app's own mirror scraper (lib/server/mirror) - the schedule of a
//     mirror family, matched to the game by the names of the teams
//   - the provider APIs (lib/server/sources/providers) - the boards those
//     services publish, matched the same way
//   - the broadcaster's own pages (lib/server/direct) - the feed of this very
//     game, taken from the carrier that carries it, when the app is on its own
//
// Every answer is measured the same way - the playlist has to answer, the
// newest segment has to be video, and the age of that segment is the real lag
// - and the best feed wins. A source that is down costs nothing but the time
// it took to say so.
//
// The free channel indexes (iptv-org, Pluto) are no longer asked at all. A
// station that carries the network's name carries its news loop, not its
// game - a national game matched to a local station is a wrong feed that
// plays, and a wrong feed that plays is worse than no feed.

import { sameTeam } from '@/lib/espn';
import { splitTitle } from '@/lib/utils';
import {
  espnBoard,
  espnGameById,
  parseEspnGameId,
  type EspnBoardGame,
} from '@/lib/server/board';
import { strictMode } from '@/lib/server/mode';
import { providerMatchName } from '@/lib/server/streamfree';
import { resolveDirectSources } from '@/lib/server/direct/resolve';
import { probeCandidate } from '@/lib/server/direct/probe';
import { providerFeedsFor, providerMatchById, providerMatchesForMatch } from '@/lib/server/sources/providers';
import { teamsOfTitle } from '@/lib/server/sources/providers/names';
import type { ProviderMatch } from '@/lib/server/sources/providers';
import type { SourceCandidate } from '@/lib/server/sources/types';

const CACHE_TTL_MS = 20_000;
/** How many candidates are measured at the same time. */
const PROBE_CONCURRENCY = 4;
/** How many candidates are measured at all. */
const MAX_PROBES = 12;

const QUALITY_WEIGHT: Record<string, number> = {
  '2160p': 40,
  '1080p': 30,
  '720p': 20,
  '540p': 10,
};

/**
 * What a feed of a provider's own API is worth over a free channel.
 *
 * The provider APIs are what the app is for: they carry the games behind a
 * subscription, and the free channels do not. So a feed from a provider API
 * is offered first when both are the same quality.
 */
const PROVIDER_BONUS = 5;

/**
 * What the provider's own player is worth under a feed the app hosts.
 *
 * A player is the provider's page with the match inside it: it plays, but the
 * app does not host it and cannot measure it. So it is offered after a feed
 * the app fetches itself - and it is still offered, because a match that
 * plays is a match that plays.
 */
const PLAYER_PENALTY = 4;

/** A feed the app can host, and what it measured. */
export interface ResolvedSource {
  /** The channel's own id - it does not move when the ranking moves. */
  readonly id: string;
  readonly candidate: SourceCandidate;
  /** The quality the feed was measured at. */
  readonly quality: string;
  readonly latencyMs: number;
  /** Seconds between the newest segment and now. */
  readonly edgeAgeSeconds: number;
  readonly mediaSequence: number;
  /** The ranking: the sharper and the fresher, the better. */
  readonly score: number;
}

/**
 * The id of a feed.
 *
 * It is derived from the service and the address of the feed, so the same
 * channel keeps the same id however the measurements move - and the player
 * that is watching it is never restarted because a list changed places.
 */
export function sourceId(candidate: SourceCandidate): string {
  let hash = 0x811c9dc5;
  const text = `${candidate.providerId}|${candidate.identity ?? candidate.manifestUrl}|${candidate.playerUrl ?? ''}`;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `s${hash.toString(16).padStart(8, '0')}`;
}

export interface SourceResolution {
  readonly sources: readonly ResolvedSource[];
  /** The game the feeds belong to, when the app found it. */
  readonly game: EspnBoardGame | null;
  /** The name the provider gives the match, when it knows one. */
  readonly providerName: string;
}

/* ------------------------------------------------------------------ */
/* The match                                                           */
/* ------------------------------------------------------------------ */

/**
 * The game a match really is.
 *
 * A match of the app's own board is asked for by its id. A match of the
 * provider's board carries the names of the teams, and the scoreboard is read
 * to find the game that carries those names - the same way the carriers' own
 * feeds are matched to a game.
 *
 * The provider is only asked when the app is allowed to ask it: the app on
 * its own never contacts a third party, not even to learn the name of a
 * match.
 */
/**
 * The name a provider gives the match, whichever provider it is.
 *
 * The match may be published by one of the provider APIs under its own id, or
 * by the app's own provider. Either way the name comes from a board - and the
 * name is what the scoreboards are searched with.
 */
async function providerNameFor(streamKey: string): Promise<string> {
  try {
    const own = await providerMatchById(streamKey);
    if (own?.event.title) return own.event.title;
  } catch {
    // A provider that does not answer is asked again later.
  }
  return providerMatchName(streamKey);
}

async function gameFor(
  streamKey: string,
  allowProvider: boolean,
): Promise<EspnBoardGame | null> {
  const parsed = parseEspnGameId(streamKey);
  if (parsed) {
    const game = await espnGameById(parsed.sport, parsed.league, parsed.eventId);
    if (game) return game;
  }

  if (!allowProvider) return null;

  const providerName = await providerNameFor(streamKey);
  if (!providerName) return null;

  const { home, away } = splitTitle(providerName);
  if (away === 'TBD' || !home || !away) return null;

  const games = await espnBoard();
  for (const game of games) {
    const gameHome = game.home?.name ?? '';
    const gameAway = game.away?.name ?? '';
    if (!gameHome || !gameAway) continue;
    const straight = sameTeam(gameHome, home) && sameTeam(gameAway, away);
    const crossed = sameTeam(gameHome, away) && sameTeam(gameAway, home);
    if (straight || crossed) return game;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* The feeds                                                           */
/* ------------------------------------------------------------------ */

/** True when a feed came from one of the provider APIs. */
function isProviderFeed(candidate: SourceCandidate): boolean {
  return candidate.providerId.startsWith('api:');
}

/**
 * The candidates of the provider APIs, before they are measured.
 *
 * Every provider that knows the match is asked for its feeds. A feed is
 * either a playlist the app can fetch itself, or the provider's own player -
 * and both are offered: the first is hosted by the app, the second is the
 * provider's own page with the match inside it.
 */
async function providerCandidates(
  matches: readonly ProviderMatch[],
): Promise<SourceCandidate[]> {
  if (matches.length === 0) return [];
  const feeds = await providerFeedsFor(matches);
  const candidates: SourceCandidate[] = [];
  const seen = new Set<string>();

  for (const candidate of feeds) {
    const feed = candidate.feed;
    // A feed the app cannot host is not offered at all - not as the
    // provider's own player page. The page is somebody else's player: it
    // carries their ads and their bookkeeping, and the user asked for the
    // match, not for that. When the app cannot host the feed, the watch
    // page says the app is looking.
    if (!feed.manifestUrl) continue;
    const key = `${candidate.providerId}|${feed.manifestUrl ?? ''}|${feed.playerUrl ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      providerId: `api:${candidate.providerId}`,
      providerLabel: candidate.providerLabel,
      title: feed.title || candidate.event.title,
      manifestUrl: feed.manifestUrl ?? '',
      // A feed that came from a page is known by the page, not by the
      // address the page led to: that address carries a token, and the token
      // changes when the page is opened again.
      identity: feed.embedUrl,
      referers: feed.referers,
      quality: feed.quality,
      network: candidate.event.network,
      eventId: candidate.event.id,
    });
  }

  return candidates;
}

/** The candidates of every source, before they are measured. */
async function candidatesFor(
  game: EspnBoardGame | null,
  streamKey: string,
  providerName: string,
): Promise<SourceCandidate[]> {
  if (!game) return [];

  /*
   * The candidates here are the ones that are known to be the game itself:
   * the provider feeds above, matched by the names of the teams. The free
   * channel indexes were tried here once - the network's own channel and its
   * local stations - and they taught the app one thing: a station that
   * carries the network's name carries its news loop, not its game. A
   * national game matched to a local station is a wrong feed that plays, and
   * a wrong feed that plays is worse than no feed. The app no longer asks
   * them.
   */
  void streamKey;
  void providerName;
  return [];
}

/** What the resolver did, when the app is asked to say it out loud. */
function trace(message: string): void {
  if (process.env.ARENA_MEDIA_DEBUG === '1') console.log(`[sources] ${message}`);
}

/** The score of a measured feed: the sharper and the fresher, the better. */
function scoreOf(quality: string, edgeAgeSeconds: number, latencyMs: number): number {
  const qualityWeight = QUALITY_WEIGHT[quality] ?? 12;
  const lag = Number.isFinite(edgeAgeSeconds) ? Math.min(edgeAgeSeconds, 90) : 90;
  return qualityWeight - lag * 0.5 - Math.min(latencyMs, 5_000) / 1_000;
}

/** Measures a few candidates at a time. */
async function measure(
  candidates: readonly SourceCandidate[],
): Promise<ResolvedSource[]> {
  const results: ResolvedSource[] = [];
  let cursor = 0;

  const runners = Array.from(
    { length: Math.min(PROBE_CONCURRENCY, candidates.length) },
    async () => {
      for (;;) {
        const index = cursor++;
        if (index >= candidates.length) return;
        const candidate = candidates[index];
        if (!candidate) return;

        // The provider's own player: there is nothing to fetch and nothing to
        // measure - the feed is inside the provider's page. It is still
        // offered, because a match that plays is a match that plays.
        if (candidate.playerUrl) {
          const quality = candidate.quality || 'auto';
          results.push({
            id: sourceId(candidate),
            candidate,
            quality,
            latencyMs: 0,
            edgeAgeSeconds: 30,
            mediaSequence: 0,
            score:
              scoreOf(quality, 30, 0) +
              (isProviderFeed(candidate) ? PROVIDER_BONUS : 0) -
              PLAYER_PENALTY,
          });
          continue;
        }

        try {
          const probe = await probeCandidate(candidate.manifestUrl, candidate.referers);
          trace(
            `probe ${candidate.providerId} ${candidate.quality}: ok=${probe.ok} ${probe.reason} ${probe.variants
              .map((variant) => variant.quality)
              .join(',')} ${candidate.manifestUrl}`,
          );
          if (!probe.ok) continue;
          const best = probe.variants[0];
          const quality = best?.quality || candidate.quality || 'auto';
          results.push({
            id: sourceId(candidate),
            candidate,
            quality,
            latencyMs: probe.latencyMs,
            edgeAgeSeconds: Number.isFinite(probe.edgeAgeSeconds) ? probe.edgeAgeSeconds : 30,
            mediaSequence: probe.mediaSequence,
            score:
              scoreOf(quality, probe.edgeAgeSeconds, probe.latencyMs) +
              (isProviderFeed(candidate) ? PROVIDER_BONUS : 0),
          });
        } catch {
          // A candidate that throws is a candidate that does not play.
        }
      }
    },
  );

  await Promise.all(runners);
  results.sort((a, b) => b.score - a.score);
  return results;
}

/* ------------------------------------------------------------------ */
/* The answer                                                          */
/* ------------------------------------------------------------------ */

const CACHE_KEY = '__arena_match_sources__';

interface CacheEntry {
  readonly at: number;
  readonly resolution: SourceResolution;
}

function cache(): Map<string, CacheEntry> {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[CACHE_KEY];
  if (existing instanceof Map) return existing as Map<string, CacheEntry>;
  const created = new Map<string, CacheEntry>();
  store[CACHE_KEY] = created;
  return created;
}

/** Forgets what is known about a match. */
export function invalidateMatchSources(streamKey?: string): void {
  if (streamKey) cache().delete(streamKey);
  else cache().clear();
}

/**
 * The feeds of a match, from every source, ranked.
 *
 * The provider APIs come first: they are the services that publish the games
 * behind a subscription, and they are asked for every match the app knows.
 * The free channels follow - they are worth having when the network that
 * carries the game is free - and the broadcasters' own pages are only read
 * when the app is on its own.
 */
export async function resolveMatchSources(streamKey: string): Promise<SourceResolution> {
  const store = cache();
  const cached = store.get(streamKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.resolution;

  // The app on its own asks nobody but the broadcaster: not the provider, not
  // the free channel index, not Pluto. The switch is read first, because it
  // decides who may be contacted at all.
  const strict = await strictMode();

  const game = await gameFor(streamKey, !strict);
  const providerName = strict || !game ? '' : await providerNameFor(streamKey);

  const resolved: ResolvedSource[] = [];

  // The carrier's own feed of this game - only when the app is on its own.
  if (strict && game) {
    try {
      const direct = await resolveDirectSources(game.id);
      for (const source of direct.sources) {
        const candidate: SourceCandidate = {
          providerId: 'direct',
          providerLabel: source.carrierLabel,
          title: source.title || source.carrierLabel,
          manifestUrl: source.manifestUrl,
          referers: source.referers,
          quality: source.quality,
          network: source.carrierLabel,
        };
        resolved.push({
          id: sourceId(candidate),
          candidate,
          quality: source.quality,
          latencyMs: source.latencyMs,
          edgeAgeSeconds: source.edgeAgeSeconds,
          mediaSequence: source.mediaSequence,
          score: scoreOf(source.quality, source.edgeAgeSeconds, source.latencyMs),
        });
      }
    } catch {
      // The carrier could not be reached - there is nothing else to offer.
    }
  }

  if (!strict) {
    // The provider APIs: every provider that knows this match is asked for its
    // feeds, and the feeds are measured the same way as any other.
    const teams: [string, string] = game
      ? [game.home?.name ?? '', game.away?.name ?? '']
      : teamsOfTitle(providerName);
    const matches = await providerMatchesForMatch(streamKey, providerName, teams);
    const providerFeeds = await providerCandidates(matches);
    trace(
      `${streamKey}: strict=${strict} provider=${providerName || '(none)'} matches=${
        matches.length
      } [${matches.map((match) => match.api.id).join(',')}] candidates=${providerFeeds.length}`,
    );
    if (providerFeeds.length > 0) {
      resolved.push(...(await measure(providerFeeds.slice(0, MAX_PROBES))));
    }

    // The free channels of the network that carries it.
    const candidates = await candidatesFor(game, streamKey, providerName);
    if (candidates.length > 0) {
      const measured = await measure(candidates.slice(0, MAX_PROBES));
      resolved.push(...measured);
    }
  }

  // The best feed first. The id breaks the tie, so the order of two feeds
  // that measure the same does not wobble from one poll to the next.
  resolved.sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));

  const resolution: SourceResolution = { sources: resolved, game, providerName };
  store.set(streamKey, { at: Date.now(), resolution });
  if (store.size > 32) {
    const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key] of oldest.slice(0, store.size - 32)) store.delete(key);
  }
  return resolution;
}

/**
 * One feed of a match, by its own id.
 *
 * The app needs this when a channel is rebuilt - after a restart, or after
 * the app forgot it - and the channel knows the feed it was hosting by its
 * id alone.
 */
export async function sourceById(
  streamKey: string,
  id: string,
): Promise<ResolvedSource | null> {
  const resolution = await resolveMatchSources(streamKey);
  return resolution.sources.find((source) => source.id === id) ?? null;
}
