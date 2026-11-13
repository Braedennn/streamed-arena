import type { ApiMatch, Sport } from '@/lib/types';
import { sourceUrls } from '@/lib/sources';
import { isBlockedFeed } from '@/lib/broadcasters';
import { splitTitle } from '@/lib/utils';

// The provider's public API (https://strmfree.st/api) — no key, CORS open.
//
// The page does not call it directly any more: the app's own server reads it
// and hands it to the page (/api/provider/...), so the renderer only ever
// talks to this app — the same way the media works.
export const STREAMFREE_HOST = 'https://strmfree.st';
export const API_BASE = '/api/provider';

/**
 * Where the API is called from.
 *
 * In the browser that is this app: the page asks its own server, and the
 * server asks the provider. On the server (a route that needs the board
 * without going through the browser) the provider is called directly.
 */
function apiBase(): string {
  return typeof window === 'undefined' ? `${STREAMFREE_HOST}/api/v1` : API_BASE;
}

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

interface CacheEntry<T> {
  at: number;
  data: T;
}

const memoryCache = new Map<string, CacheEntry<unknown>>();

const MAX_CACHE_ENTRIES = 128;
const MAX_CACHE_AGE_MS = 1000 * 60 * 30;

function pruneCache() {
  const cutoff = Date.now() - MAX_CACHE_AGE_MS;
  for (const [key, entry] of memoryCache) {
    if (entry.at < cutoff) memoryCache.delete(key);
  }
  if (memoryCache.size <= MAX_CACHE_ENTRIES) return;
  for (const key of memoryCache.keys()) {
    if (memoryCache.size <= MAX_CACHE_ENTRIES) return;
    memoryCache.delete(key);
  }
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_STALE_MS = 1000 * 60 * 60 * 6;

interface RequestOptions {
  timeoutMs?: number;
  ttlMs?: number;
  staleMs?: number;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, ttlMs = 0, staleMs = DEFAULT_STALE_MS } = options;
  const url = path.startsWith('http') ? path : `${apiBase()}${path}`;
  const cached = memoryCache.get(url) as CacheEntry<T> | undefined;

  if (cached && Date.now() - cached.at < ttlMs) return cached.data;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      throw new ApiError(`The fixture feed responded ${response.status} for ${path}`, response.status);
    }

    const data = (await response.json()) as T;
    memoryCache.set(url, { at: Date.now(), data });
    pruneCache();
    return data;
  } catch (error) {
    if (cached && Date.now() - cached.at < staleMs) return cached.data;
    if (error instanceof ApiError) throw error;
    const message =
      error instanceof Error
        ? error.name === 'AbortError'
          ? 'The fixture feed request timed out'
          : error.message
        : 'Unable to reach the fixture feed';
    throw new ApiError(message);
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* StreamFree wire shapes                                              */
/* ------------------------------------------------------------------ */

interface StreamFreeTeam {
  readonly name?: string;
  readonly logo?: string | null;
}

interface StreamFreeStream {
  readonly name?: string;
  readonly category?: string;
  readonly league?: string;
  readonly stream_key?: string;
  /** Unix seconds. */
  readonly match_timestamp?: number;
  readonly viewers?: number;
  /** Plain URLs, or {quality, url} objects - see lib/sources.ts. */
  readonly sources?: unknown;
  readonly live_sources?: unknown;
  readonly thumbnail_url?: string | null;
  /** How many feeds the app found for this match. */
  readonly feed_count?: number;
  /** True when one of those feeds is 720p or better. */
  readonly feed_hd?: boolean;
  readonly team1?: StreamFreeTeam | null;
  readonly team2?: StreamFreeTeam | null;
}

interface StreamFreeStreamsResponse {
  readonly count?: number;
  readonly streams?: StreamFreeStream[];
}

/* ------------------------------------------------------------------ */
/* Categories                                                          */
/* ------------------------------------------------------------------ */

// StreamFree categories that need a friendlier label than plain title-casing.
const CATEGORY_LABELS: Record<string, string> = {
  football: 'American Football',
};

function titleCaseCategory(category: string): string {
  return category
    .split('-')
    .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ');
}

export const sportsApi = {
  async all(): Promise<Sport[]> {
    const data = await request<{ readonly categories?: string[] }>('/categories', {
      ttlMs: 1000 * 60 * 30,
    });
    const categories = Array.isArray(data.categories) ? data.categories : [];
    return categories
      .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
      .map((entry) => ({ id: entry, name: CATEGORY_LABELS[entry] ?? titleCaseCategory(entry) }));
  },
};

/* ------------------------------------------------------------------ */
/* Streams -> fixtures                                                 */
/* ------------------------------------------------------------------ */

const MS_PER_SECOND = 1000;

function mapStreamToMatch(stream: StreamFreeStream): ApiMatch | null {
  const key = stream.stream_key;
  if (!key) return null;
  // A feed the app refuses (see lib/broadcasters.ts) never reaches the list.
  if (
    isBlockedFeed({
      name: stream.name,
      category: stream.category,
      league: stream.league,
      streamKey: key,
    })
  ) {
    return null;
  }
  const title = stream.name ?? key;
  // match_timestamp is unix seconds; the app works in unix ms everywhere.
  const date = typeof stream.match_timestamp === 'number' ? stream.match_timestamp * MS_PER_SECOND : Date.now();
  return {
    id: key,
    title,
    category: stream.category ?? 'other',
    date,
    // The picture's address stays in the app's server: the page only needs to
    // know that there is one.
    hasPoster: Boolean(stream.thumbnail_url),
    popular: false,
    viewers: typeof stream.viewers === 'number' && stream.viewers > 0 ? stream.viewers : undefined,
    teams: teamsFromStream(stream),
    sources: [{ source: SOURCE_LABEL, id: key }],
    // How many feeds the app found for this match, and whether one of them
    // is sharp enough to call HD. The board knows - the app's own server
    // counted them.
    feedCount: typeof stream.feed_count === 'number' ? stream.feed_count : undefined,
    feedHd: typeof stream.feed_hd === 'boolean' ? stream.feed_hd : undefined,
  };
}

// The API ships structured teams (with ESPN-hosted logos) for most events;
// fall back to splitting "Home vs Away" out of the title otherwise.
function teamsFromStream(stream: StreamFreeStream): ApiMatch['teams'] {
  if (typeof stream.team1?.name === 'string' && typeof stream.team2?.name === 'string') {
    return {
      home: { name: stream.team1.name, badge: stream.team1.logo ?? '' },
      away: { name: stream.team2.name, badge: stream.team2.logo ?? '' },
    };
  }
  const { home, away } = splitTitle(stream.name ?? '');
  if (away === 'TBD') return null;
  return {
    home: { name: home, badge: '' },
    away: { name: away, badge: '' },
  };
}

export const SOURCE_LABEL = 'StreamFree';

export const matchesApi = {
  // /streams returns every event whose feed window is open: on-air matches
  // plus those about to start. Sports are filtered via ?category={sport}.
  all: () => requestStreams('/streams', { ttlMs: 8_000 }),
  live: () => requestStreams('/streams', { ttlMs: 4_000 }, true),
  today: () => requestStreams('/streams', { ttlMs: 30_000 }),
  popular: () => requestStreams('/streams', { ttlMs: 30_000 }),
  bySport: (sport: string) => requestStreams(`/streams?category=${encodeURIComponent(sport)}`, { ttlMs: 8_000 }),
};

async function requestStreams(
  path: string,
  options: RequestOptions = {},
  liveOnly = false,
): Promise<ApiMatch[]> {
  const response = await request<StreamFreeStreamsResponse>(path, options);
  const streams = Array.isArray(response.streams) ? response.streams : [];
  const matches: ApiMatch[] = [];
  for (const stream of streams) {
    const mapped = mapStreamToMatch(stream);
    if (!mapped) continue;
    if (liveOnly && sourceUrls(stream.live_sources).length === 0) continue;
    matches.push(mapped);
  }
  return matches;
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

export function badgeUrl(badge?: string | null): string | null {
  if (!badge) return null;
  // The badges come from ESPN's image host and are ordinary pictures. Next's
  // image optimizer fetches them in the app's server, so the page only ever
  // asks this app for them.
  if (/^https?:\/\//i.test(badge)) return badge;
  return null;
}
