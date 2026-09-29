import type { ApiMatch, Sport, StreamDto } from '@/lib/types';

export const STREAMED_HOST = 'https://streamed.pk';
export const API_BASE = `${STREAMED_HOST}/api`;

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
      throw new ApiError(`Streamed API responded ${response.status} for ${path}`, response.status);
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
          ? 'Streamed API request timed out'
          : error.message
        : 'Unable to reach Streamed API';
    throw new ApiError(message);
  } finally {
    clearTimeout(timer);
  }
}

export const sportsApi = {
  all: () => request<Sport[]>('/sports', { ttlMs: 1000 * 60 * 30 }),
};

export const matchesApi = {
  live: () => request<ApiMatch[]>('/matches/live', { ttlMs: 4_000 }),
  all: () => request<ApiMatch[]>('/matches/all', { ttlMs: 8_000 }),
  today: () => request<ApiMatch[]>('/matches/all-today', { ttlMs: 30_000 }),
  popular: () => request<ApiMatch[]>('/matches/all/popular', { ttlMs: 30_000 }),
  bySport: (sport: string) => request<ApiMatch[]>(`/matches/${sport}`, { ttlMs: 8_000 }),
};

export const streamsApi = {
  forSource: (source: string, id: string) =>
    request<StreamDto[]>(`/stream/${source}/${id}`, { ttlMs: 15_000, timeoutMs: 10_000 }),
};

export async function streamsForSources(
  sources: readonly { source: string; id: string }[],
): Promise<StreamDto[]> {
  const results = await Promise.allSettled(
    sources.map((entry) => streamsApi.forSource(entry.source, entry.id)),
  );

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

function absolute(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  if (path.startsWith('/')) return `${STREAMED_HOST}${path}`;
  return `${API_BASE}/${path}`;
}

export function badgeUrl(badge?: string | null): string | null {
  if (!badge) return null;
  if (badge.includes('/api/images/') || /^https?:\/\//i.test(badge)) return absolute(badge);
  return `${API_BASE}/images/badge/${badge}.webp`;
}

export function posterUrl(poster?: string | null): string | null {
  if (!poster) return null;
  return absolute(poster);
}

export function teamVersusPoster(homeBadge?: string | null, awayBadge?: string | null): string | null {
  if (!homeBadge || !awayBadge) return null;
  return `${API_BASE}/images/poster/${homeBadge}/${awayBadge}.webp`;
}

export function isHlsUrl(url: string): boolean {
  const clean = url.split('?')[0]?.toLowerCase() ?? '';
  return clean.endsWith('.m3u8') || clean.includes('.m3u8');
}
