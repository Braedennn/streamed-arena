import type { ApiMatch, MatchSource, Sport, StreamDto } from '@/lib/types';
import { sourceUrls } from '@/lib/sources';
import { splitTitle } from '@/lib/utils';

// StreamFree public API (https://strmfree.st/api) — no key, CORS open.
export const STREAMFREE_HOST = 'https://strmfree.st';
export const API_BASE = `${STREAMFREE_HOST}/api/v1`;

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
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
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
      throw new ApiError(`StreamFree API responded ${response.status} for ${path}`, response.status);
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
          ? 'StreamFree API request timed out'
          : error.message
        : 'Unable to reach StreamFree API';
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
  readonly team1?: StreamFreeTeam | null;
  readonly team2?: StreamFreeTeam | null;
}

interface StreamFreeStreamsResponse {
  readonly count?: number;
  readonly streams?: StreamFreeStream[];
}

interface StreamFreeSourcesResponse {
  readonly stream_key?: string;
  readonly sources?: unknown;
  readonly live_sources?: unknown;
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
  const title = stream.name ?? key;
  // match_timestamp is unix seconds; the app works in unix ms everywhere.
  const date = typeof stream.match_timestamp === 'number' ? stream.match_timestamp * MS_PER_SECOND : Date.now();
  return {
    id: key,
    title,
    category: stream.category ?? 'other',
    date,
    poster: stream.thumbnail_url ?? undefined,
    popular: false,
    viewers: typeof stream.viewers === 'number' && stream.viewers > 0 ? stream.viewers : undefined,
    teams: teamsFromStream(stream),
    sources: [{ source: SOURCE_LABEL, id: key }],
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
    // Remember the embed lists that came with the board so the per-match
    // resolve step can reuse them instead of re-fetching (server asks to
    // cache — see the /api page).
    const sources = sourceUrls(stream.sources);
    if (sources.length > 0) {
      stashSources(
        mapped.id,
        sources,
        sourceUrls(stream.live_sources),
        CACHE_TTL_MS,
        typeof stream.viewers === 'number' ? stream.viewers : undefined,
      );
    }
    matches.push(mapped);
  }
  return matches;
}

/* ------------------------------------------------------------------ */
/* Sources -> playable streams                                         */
/* ------------------------------------------------------------------ */

const CACHE_TTL_MS = 15_000;

interface KnownSources {
  at: number;
  sources: string[];
  liveSources: string[];
  /** Match-level viewer count; the /sources/:key endpoint doesn't include it. */
  viewers?: number;
}

// Populated by the board fetch; consumed (within TTL) by forSource so a page
// full of previews never hits /sources/{key} for streams it already has.
const knownSources = new Map<string, KnownSources>();

function stashSources(
  key: string,
  sources: string[],
  liveSources: string[],
  ttlMs: number,
  viewers?: number,
) {
  if (sources.length === 0) return;
  knownSources.set(key, { at: Date.now(), sources, liveSources, viewers });
  for (const [entry, known] of knownSources) {
    if (Date.now() - known.at > ttlMs * 2) knownSources.delete(entry);
  }
}

export const streamsApi = {
  // The old API needed one request per mirror; StreamFree returns all embed
  // variants for a match in one shot, keyed by the match's stream_key.
  async forSource(source: string, id: string): Promise<StreamDto[]> {
    const known = knownSources.get(id);
    if (known && Date.now() - known.at < CACHE_TTL_MS) {
      return buildStreams(id, known.sources, known.liveSources, known.viewers);
    }
    const data = await request<StreamFreeSourcesResponse>(`/sources/${encodeURIComponent(id)}`, {
      ttlMs: CACHE_TTL_MS,
      timeoutMs: 10_000,
    });
    const sources = sourceUrls(data.sources);
    const liveSources = sourceUrls(data.live_sources);
    stashSources(id, sources, liveSources, CACHE_TTL_MS);
    return buildStreams(id, sources, liveSources);
  },
};

export async function streamsForSources(
  sources: readonly MatchSource[],
): Promise<StreamDto[]> {
  // Multiple entries may map to the same stream_key once deduplicated.
  const unique: MatchSource[] = [];
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) continue;
    seen.add(source.id);
    unique.push(source);
  }

  const results = await Promise.allSettled(unique.map((entry) => streamsApi.forSource(entry.source, entry.id)));

  const streams: StreamDto[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled' && Array.isArray(result.value)) {
      streams.push(...result.value);
    }
  }

  if (streams.length === 0 && results.every((result) => result.status === 'rejected')) {
    throw new ApiError('No stream sources responded');
  }

  return streams;
}

interface ParsedEmbed {
  readonly url: string;
  /** Quality suffix, e.g. "1080p" — empty when the URL is the plain embed. */
  readonly quality: string;
  /** Source number from the suffix ("1080p2" -> 2), 1 for unsuffixed. */
  readonly sourceNo: number;
  readonly hd: boolean;
}

function parseEmbed(url: string): ParsedEmbed {
  const match = url.match(/(\d+p)(\d*)$/);
  if (match) {
    const quality = match[1] ?? '';
    const sourceNo = match[2] ? parseInt(match[2], 10) : 1;
    return {
      url,
      quality,
      sourceNo: Number.isFinite(sourceNo) && sourceNo > 0 ? sourceNo : 1,
      hd: parseInt(quality, 10) >= 720,
    };
  }
  // Un-suffixed embed (the plain "/embed/{category}/{key}" URL).
  return { url, quality: '', sourceNo: 1, hd: false };
}

function qualityRank(quality: string): number {
  if (!quality) return 0;
  const value = parseInt(quality, 10);
  return Number.isFinite(value) ? value : 0;
}

function buildStreams(
  streamKey: string,
  sources: string[],
  liveSources: string[],
  viewers?: number,
): StreamDto[] {
  const live = new Set(liveSources);
  const parsed = sources
    .filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    .map(parseEmbed);

  // Live feeds first, then Source 1/2, then higher quality within a source.
  const sorted = [...parsed].sort((a, b) => {
    const liveA = live.has(a.url) ? 0 : 1;
    const liveB = live.has(b.url) ? 0 : 1;
    if (liveA !== liveB) return liveA - liveB;
    if (a.sourceNo !== b.sourceNo) return a.sourceNo - b.sourceNo;
    const rankA = qualityRank(a.quality);
    const rankB = qualityRank(b.quality);
    if (rankA !== rankB) return rankB - rankA;
    return sources.indexOf(a.url) - sources.indexOf(b.url);
  });

  // Number channels per "server" group, matching the server/channel switcher.
  const counter = new Map<number, number>();
  const streams: StreamDto[] = [];
  for (const entry of sorted) {
    const nextNo = (counter.get(entry.sourceNo) ?? 0) + 1;
    counter.set(entry.sourceNo, nextNo);
    streams.push({
      id: variantId(entry, streamKey),
      streamNo: nextNo,
      language: 'English',
      hd: entry.hd,
      embedUrl: entry.url,
      source: `S${entry.sourceNo}`,
      // One count per match, shared by every variant — aggregators take max.
      viewers: viewers != null && viewers > 0 ? viewers : undefined,
    });
  }
  return streams;
}

// Stable, unique id per variant: prefer the readable suffix ("1080p2");
// fall back to the URL when it carries no distinguishing suffix.
function variantId(entry: ParsedEmbed, streamKey: string): string {
  const tail = parseVariantTail(entry.url, streamKey);
  return tail || entry.url;
}

function parseVariantTail(url: string, streamKey: string): string {
  const segment = url.split('/').pop() ?? '';
  if (!streamKey || !segment.startsWith(streamKey)) return '';
  return segment.slice(streamKey.length) || 'main';
}

function absolute(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${STREAMFREE_HOST}${path.startsWith('/') ? path : `/${path}`}`;
}

export function badgeUrl(badge?: string | null): string | null {
  if (!badge) return null;
  if (/^https?:\/\//i.test(badge)) return absolute(badge);
  // StreamFree exposes no team badges; only absolute URLs render.
  return null;
}

export function posterUrl(poster?: string | null): string | null {
  if (!poster) return null;
  return absolute(poster);
}

export function isHlsUrl(url: string): boolean {
  const clean = url.split('?')[0]?.toLowerCase() ?? '';
  return clean.endsWith('.m3u8') || clean.includes('.m3u8');
}
