// The feed of a match, taken from the carrier itself.
//
// This is the app's own scraper. It knows a match by the id the app gave it,
// reads who carries the game, reads the carrier's own pages, and plays what
// it finds there. Nothing in the middle asks anybody for permission: the
// carrier's page is the source.
//
// What comes out is measured before it is offered. A feed that does not
// answer, or that answers with a picture, or that is a recording of a game
// that is over, is never offered.
//
// The result is cached for a short while: the board asks about the same match
// every few seconds, and the carrier's pages do not change that fast.

import { sameTeam } from '@/lib/espn';
import { espnGameById, parseEspnGameId, type EspnBoardGame } from '@/lib/server/board';
import { upstreamText } from '@/lib/server/upstream';
import {
  CARRIER_UA,
  carriersFor,
  manifestsIn,
  walledNetwork,
  type DirectCandidate,
} from '@/lib/server/direct/carriers';
import { probeCandidate } from '@/lib/server/direct/probe';

const PAGE_TIMEOUT_MS = 8_000;
const CACHE_TTL_MS = 20_000;
const PAGE_CACHE_TTL_MS = 60_000;
const MAX_PROBES = 4;

/** A feed the app can host, and what it measured. */
export interface DirectSource {
  readonly carrierId: string;
  readonly carrierLabel: string;
  readonly title: string;
  /** The manifest the app pulls. */
  readonly manifestUrl: string;
  readonly referers: readonly string[];
  readonly quality: string;
  readonly latencyMs: number;
  /** Seconds between the newest segment and now. */
  readonly edgeAgeSeconds: number;
  readonly mediaSequence: number;
  /** The ranking: the fresher and the faster, the better. */
  readonly score: number;
}

/**
 * Why the answer looks the way it does.
 *
 * `walled` is the honest one: the carrier puts the game behind a
 * subscription, and the app cannot play what it is not given.
 */
export type DirectState = 'ready' | 'waiting' | 'walled' | 'unknown';

export interface DirectResolution {
  readonly sources: readonly DirectSource[];
  readonly state: DirectState;
  /** A sentence for the page, in the app's own words. */
  readonly detail: string;
}

const CACHE_KEY = '__arena_direct_sources__';

/** What the resolver did, when the app is asked to say it out loud. */
function trace(message: string): void {
  if (process.env.ARENA_MEDIA_DEBUG === '1') console.log(`[direct] ${message}`);
}

interface CacheEntry {
  readonly at: number;
  readonly resolution: DirectResolution;
}

function cache(): Map<string, CacheEntry> {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[CACHE_KEY];
  if (existing instanceof Map) return existing as Map<string, CacheEntry>;
  const created = new Map<string, CacheEntry>();
  store[CACHE_KEY] = created;
  return created;
}

/** The pages the carriers' sites are read from, kept for a short while. */
const PAGE_CACHE_KEY = '__arena_carrier_pages__';

function pageCache(): Map<string, { at: number; body: string }> {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[PAGE_CACHE_KEY];
  if (existing instanceof Map) return existing as Map<string, { at: number; body: string }>;
  const created = new Map<string, { at: number; body: string }>();
  store[PAGE_CACHE_KEY] = created;
  return created;
}

/** Reads a page of a carrier's own site. */
async function readPage(url: string): Promise<string> {
  const cached = pageCache().get(url);
  if (cached && Date.now() - cached.at < PAGE_CACHE_TTL_MS) return cached.body;

  try {
    const response = await upstreamText(url, {
      headers: {
        accept: 'text/html,application/xhtml+xml,application/json,*/*',
        'user-agent': CARRIER_UA,
        'accept-language': 'en-US,en;q=0.9',
      },
      timeoutMs: PAGE_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) return '';
    pageCache().set(url, { at: Date.now(), body: response.body });
    return response.body;
  } catch {
    return '';
  }
}

/**
 * Is this the feed of our game?
 *
 * A carrier's page lists many feeds. One of them has to be *this* game: the
 * app matches the teams the carrier names against the teams the app knows.
 * A feed that names no game at all is taken only when the carrier's page was
 * the page of this game - which is the case for the carriers that build a
 * page per game.
 */
function belongsToGame(candidate: DirectCandidate, game: EspnBoardGame): boolean {
  const home = candidate.home ?? '';
  const away = candidate.away ?? '';
  if (home && away) {
    const straight = sameTeam(game.home?.name ?? '', home) && sameTeam(game.away?.name ?? '', away);
    const crossed = sameTeam(game.home?.name ?? '', away) && sameTeam(game.away?.name ?? '', home);
    if (straight || crossed) return true;
    // The carrier names the teams differently, but the kick-off is the same
    // game: the times must agree within an hour.
    if (candidate.startsAt && Math.abs(candidate.startsAt - game.date) < 3_600_000) {
      return straight || crossed;
    }
    return false;
  }

  // No teams: the title has to carry the matchup ("Nevada vs. New Mexico").
  const title = candidate.title.toLowerCase();
  const homeName = (game.home?.name ?? '').toLowerCase();
  const awayName = (game.away?.name ?? '').toLowerCase();
  if (!homeName || !awayName) return false;
  const words = (value: string) =>
    value
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && word !== 'the' && word !== 'vs');
  const titleWords = new Set(words(title));
  const homeWords = words(homeName);
  const awayWords = words(awayName);
  const homeHit = homeWords.some((word) => titleWords.has(word));
  const awayHit = awayWords.some((word) => titleWords.has(word));
  if (!homeHit || !awayHit) return false;
  if (candidate.startsAt && Math.abs(candidate.startsAt - game.date) < 3_600_000) return true;
  return title.includes('vs');
}

/** The feed of a match, from the carrier that carries it. */
export async function resolveDirectSources(matchId: string): Promise<DirectResolution> {
  const cached = cache().get(matchId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.resolution;

  const resolution = await resolve(matchId);
  cache().set(matchId, { at: Date.now(), resolution });
  return resolution;
}

/** Forgets what is known - used when the user changes a setting. */
export function invalidateDirectSources(matchId?: string): void {
  if (matchId) cache().delete(matchId);
  else cache().clear();
}

async function resolve(matchId: string): Promise<DirectResolution> {
  const parsed = parseEspnGameId(matchId);
  if (!parsed) {
    trace(`${matchId}: not a match of the app's own board`);
    return { sources: [], state: 'unknown', detail: 'This match was not found on the app’s board.' };
  }

  const game = await espnGameById(parsed.sport, parsed.league, parsed.eventId);
  if (!game) {
    trace(`${matchId}: no such game in ${parsed.league}`);
    return { sources: [], state: 'unknown', detail: 'This match was not found on the app’s board.' };
  }

  trace(
    `${matchId}: ${game.title} on ${game.networks.join(', ') || 'no network'} (${game.state})`,
  );

  if (game.networks.length === 0) {
    return {
      sources: [],
      state: 'waiting',
      detail: 'No broadcaster has been named for this match yet.',
    };
  }

  const walled = game.networks.map((network) => walledNetwork(network)).find(Boolean);
  const carriers = carriersFor(game.networks);
  if (carriers.length === 0) {
    if (walled) {
      return {
        sources: [],
        state: 'walled',
        detail: `${walled} puts this match behind a subscription - the app can only play it from a source of your own.`,
      };
    }
    return {
      sources: [],
      state: 'unknown',
      detail: 'The app does not know how to reach this broadcast yet.',
    };
  }

  // Read every page of every carrier, at the same time.
  const pages = new Map<string, string>();
  await Promise.all(
    carriers.flatMap((carrier) =>
      carrier.pages(game).map(async (page) => {
        const body = await readPage(page);
        if (body) pages.set(page, body);
      }),
    ),
  );

  const candidates: DirectCandidate[] = [];
  for (const carrier of carriers) {
    for (const page of carrier.pages(game)) {
      const body = pages.get(page);
      if (!body) continue;
      for (const candidate of carrier.extract(body, page)) {
        if (belongsToGame(candidate, game)) candidates.push(candidate);
      }
    }
  }
  trace(`${matchId}: ${candidates.length} candidate(s) from ${carriers.map((c) => c.label).join(', ')}`);

  if (candidates.length === 0) {
    if (walled) {
      return {
        sources: [],
        state: 'walled',
        detail: `${walled} puts this match behind a subscription - the app can only play it from a source of your own.`,
      };
    }
    return {
      sources: [],
      state: 'waiting',
      detail: 'The broadcaster has not published this feed yet.',
    };
  }

  // A candidate that names a page is one more step away from the feed.
  const expanded: DirectCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.manifestUrl) {
      expanded.push(candidate);
      continue;
    }
    if (!candidate.pageUrl) continue;
    const body = await readPage(candidate.pageUrl);
    if (!body) continue;
    for (const manifestUrl of manifestsIn(body)) {
      expanded.push({ ...candidate, manifestUrl, pageUrl: undefined });
    }
  }

  const playable = expanded.slice(0, MAX_PROBES);
  const probes = await Promise.all(
    playable.map((candidate) =>
      probeCandidate(candidate.manifestUrl ?? '', candidate.referers).then((probe) => ({
        candidate,
        probe,
      })),
    ),
  );

  for (const { candidate, probe } of probes) {
    trace(
      `${candidate.carrierLabel}: ${candidate.manifestUrl?.slice(0, 90) ?? 'none'} - ${
        probe.ok ? `plays (${probe.variants.length} quality, ${Math.round(probe.edgeAgeSeconds)}s old)` : probe.reason
      }`,
    );
  }

  const sources: DirectSource[] = [];
  for (const { candidate, probe } of probes) {
    if (!probe.ok) continue;
    const age = Number.isFinite(probe.edgeAgeSeconds) ? probe.edgeAgeSeconds : 30;
    for (const variant of probe.variants) {
      sources.push({
        carrierId: candidate.carrierId,
        carrierLabel: candidate.carrierLabel,
        title: candidate.title,
        manifestUrl: variant.manifestUrl,
        referers: candidate.referers,
        quality: variant.quality,
        latencyMs: probe.latencyMs,
        edgeAgeSeconds: age,
        mediaSequence: probe.mediaSequence,
        score: 100 - Math.min(age, 90) * 0.5 - Math.min(probe.latencyMs, 5000) / 100,
      });
    }
  }

  if (sources.length === 0) {
    if (walled) {
      return {
        sources: [],
        state: 'walled',
        detail: `${walled} puts this match behind a subscription - the app can only play it from a source of your own.`,
      };
    }
    return {
      sources: [],
      state: 'waiting',
      detail: 'The broadcaster has published a feed that does not answer.',
    };
  }

  sources.sort((a, b) => b.score - a.score);
  return {
    sources,
    state: 'ready',
    detail: `Straight from ${sources[0]?.carrierLabel ?? 'the broadcaster'}.`,
  };
}
