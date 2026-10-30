// Server-side StreamFree resolver — the app's own "scraper".
//
// The public API only advertises two embed pages per match (both 1080p) and
// says nothing about quality, health or lag. The embed page itself, however,
// carries the real delivery matrix:
//   - a token map for up to four qualities (2160p/1080p/720p/540p)
//   - a source slot ("1" or "2") — often a completely independent upstream feed
//   - and three interchangeable media backends (/live/, /live-cdn/,
//     /live-externalcdn/) that can each serve the same variant
//
// Two more provider endpoints complete the picture:
//   - /api/v1/sources/:key also lists `live_sources`: the embed pages whose
//     feed is actually switched on. An empty list means "the match has not
//     started yet" — not "the resolver is broken" — and the pool says so
//     instead of pretending the match has no servers.
//   - /get-stream-key/:key (the same call the provider's own player makes)
//     reports when a match is hosted on a third-party site and where.
//
// This module reads that matrix, probes every candidate and scores it by
// real-world health: HTTP latency, whether the newest segment is still
// downloadable, and how far behind the live edge that segment is (the CDN
// stamps segments with Last-Modified, so age == lag). Only the candidates
// that answer are returned, ranked best-first — the UI never offers a dead or
// lagging feed as a "server".
//
// Robustness rules for a server that runs for hours:
//   - every upstream call has a hard deadline and one retry (see upstream.ts)
//   - a resolve never spends more than RESOLVE_BUDGET_MS, so a hanging
//     upstream cannot stall the watch page
//   - the last good result is kept: if a later resolve comes back empty the
//     previous pool is served instead, flagged stale, rather than showing the
//     user an empty server list

import { approveOrigin } from '@/lib/server/origins';
import { upstreamHead, upstreamText } from '@/lib/server/upstream';
import type { ServerCandidate } from '@/lib/types';

const STREAMFREE_HOST = 'https://strmfree.st';
const SOURCES_API = `${STREAMFREE_HOST}/api/v1/sources`;
const STREAM_KEY_API = `${STREAMFREE_HOST}/get-stream-key`;
const EMBED_REFERER = `${STREAMFREE_HOST}/`;

/** Media backends that can serve a variant. */
const BACKENDS = [
  { id: 'cdn', label: 'CDN', path: 'live-cdn' },
  { id: 'external', label: 'External', path: 'live-externalcdn' },
  { id: 'origin', label: 'Origin', path: 'live' },
] as const;

/** A match hosted on a third-party site — one URL, no backend matrix. */
const EXTERNAL_BACKEND = { id: 'host', label: 'Direct' } as const;

const QUALITY_WEIGHT: Record<string, number> = {
  '2160p': 40,
  '1080p': 30,
  '720p': 20,
  '540p': 10,
};

const PROBE_TIMEOUT_MS = 5_000;
const EMBED_TIMEOUT_MS = 8_000;
const MAX_CONCURRENCY = 6;
/** Hard ceiling for one full resolve. */
const RESOLVE_BUDGET_MS = 20_000;
/** How long a previously working pool stays usable as a fallback. */
const LAST_GOOD_TTL_MS = 5 * 60_000;

export type ServerBackend = (typeof BACKENDS)[number]['id'] | (typeof EXTERNAL_BACKEND)['id'];

/**
 * Why a pool came back the way it did.
 *
 * `waiting` is the important one: the provider has not switched the match on
 * yet, so there is genuinely no media to play. Saying "no direct mirror
 * answered" there reads like a failure; saying "the feed has not started"
 * tells the truth, and the pool keeps checking so the feed appears by itself.
 */
export type PoolState =
  /** At least one mirror answered and is playable. */
  | 'ready'
  /** The provider says the match has not started — no media exists yet. */
  | 'waiting'
  /** The provider says it is live but nothing answered. */
  | 'unknown';

export interface ResolvedPool {
  readonly servers: readonly ResolvedServer[];
  readonly state: PoolState;
}

type ResolvedServer = ServerCandidate & {
  /** Upstream manifest (tokenised) — never handed to the renderer directly. */
  readonly manifestUrl: string;
  readonly alive: boolean;
};

/* ------------------------------------------------------------------ */
/* Token / embed parsing                                              */
/* ------------------------------------------------------------------ */

interface QualityToken {
  readonly _t: string;
  readonly _e: number;
  readonly _n: string;
}

interface EmbedInfo {
  readonly quality: string;
  readonly suffix: string;
  /** The provider's own "is this feed switched on" flag. */
  readonly isLive: boolean;
  readonly tokens: Record<string, QualityToken>;
}

const EMBED_CACHE = new Map<string, { at: number; info: EmbedInfo | null }>();
/**
 * Short enough that a feed which just went live is picked up quickly: the
 * embed page carries the provider's own "is live" flag, and the sources API
 * carries the live list. A minute-long cache would leave the watch page
 * claiming the match has not started long after it did.
 */
const EMBED_TTL_MS = 20_000;

/** Embed pages per match (the sources API result). */
const SOURCES_CACHE = new Map<string, { at: number; urls: string[]; liveUrls: string[]; ok: boolean }>();
const SOURCES_TTL_MS = 20_000;

const RESOLVE_CACHE = new Map<string, { at: number; servers: ResolvedServer[]; state: PoolState }>();
const RESOLVE_TTL_MS = 15_000;

const LAST_GOOD = new Map<string, { at: number; servers: ResolvedServer[] }>();

/** The provider's own lookup — where the match actually lives. */
const STREAM_KEY_CACHE = new Map<string, { at: number; info: StreamKeyInfo }>();
const STREAM_KEY_TTL_MS = 60_000;

function tokenQuery(token: QualityToken): string {
  return `?_t=${encodeURIComponent(token._t)}&_e=${encodeURIComponent(String(token._e))}&_n=${encodeURIComponent(token._n)}`;
}

export function parseEmbedInfo(html: string): EmbedInfo | null {
  const mapMatch = html.match(/const\s+_0x\s*=\s*(\{.*?\});/);
  const rawMap = mapMatch?.[1];
  if (!rawMap) return null;
  let tokens: Record<string, QualityToken>;
  try {
    tokens = JSON.parse(rawMap) as Record<string, QualityToken>;
  } catch {
    return null;
  }
  const quality = html.match(/const\s+QUALITY\s*=\s*'([^']*)'/)?.[1] ?? '';
  const suffix = html.match(/const\s+SOURCE_SUFFIX\s*=\s*'([^']*)'/)?.[1] ?? '';
  const isLive = html.match(/const\s+IS_LIVE\s*=\s*(true|false)/)?.[1] === 'true';
  if (!quality || Object.keys(tokens).length === 0) return null;
  return { quality, suffix, isLive, tokens };
}

async function embedInfo(embedUrl: string): Promise<EmbedInfo | null> {
  const cached = EMBED_CACHE.get(embedUrl);
  if (cached && Date.now() - cached.at < EMBED_TTL_MS) return cached.info;
  let info: EmbedInfo | null = null;
  try {
    // No Referer here on purpose: StreamFree's edge answers 403 when a request
    // claims to come from strmfree.st itself, while the media paths below
    // require exactly that referer.
    const response = await upstreamText(embedUrl, {
      headers: { accept: 'text/html,application/json' },
      timeoutMs: EMBED_TIMEOUT_MS,
    });
    if (response.status >= 200 && response.status < 300) {
      info = parseEmbedInfo(response.body);
    }
  } catch {
    info = null;
  }
  EMBED_CACHE.set(embedUrl, { at: Date.now(), info });
  return info;
}

/** The embed pages of a match, and the subset that is switched on. */
async function sourceEmbeds(
  streamKey: string,
): Promise<{ urls: string[]; liveUrls: string[]; ok: boolean }> {
  const cached = SOURCES_CACHE.get(streamKey);
  if (cached && Date.now() - cached.at < SOURCES_TTL_MS) return cached;

  let urls: string[] = [];
  let liveUrls: string[] = [];
  let ok = false;
  try {
    const response = await upstreamText(`${SOURCES_API}/${encodeURIComponent(streamKey)}`, {
      headers: { accept: 'application/json' },
      timeoutMs: EMBED_TIMEOUT_MS,
    });
    if (response.status >= 200 && response.status < 300) {
      const payload = JSON.parse(response.body) as { sources?: unknown; live_sources?: unknown };
      if (Array.isArray(payload.sources)) {
        urls = payload.sources.filter((entry): entry is string => typeof entry === 'string');
      }
      if (Array.isArray(payload.live_sources)) {
        liveUrls = payload.live_sources.filter((entry): entry is string => typeof entry === 'string');
      }
      ok = true;
    }
  } catch {
    urls = [];
    liveUrls = [];
  }

  const entry = { at: Date.now(), urls, liveUrls, ok };
  SOURCES_CACHE.set(streamKey, entry);
  return entry;
}

async function sourceEmbedUrls(streamKey: string): Promise<string[]> {
  return (await sourceEmbeds(streamKey)).urls;
}

/* ------------------------------------------------------------------ */
/* Where the match actually lives                                      */
/* ------------------------------------------------------------------ */

interface StreamKeyInfo {
  /** The match is hosted on a third-party site, not on the provider. */
  readonly isExternal: boolean;
  /** The external HLS manifest, when there is one. */
  readonly externalUrl: string;
  /** Which backend the provider is currently serving it from. */
  readonly serverName: string;
}

const EMPTY_STREAM_KEY: StreamKeyInfo = { isExternal: false, externalUrl: '', serverName: '' };

/**
 * Rejects URLs that point back into the machine or a private network — the
 * external URL is provider-supplied data, and it must not be able to make the
 * app server fetch an internal address.
 */
function isSafeExternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  if (host.startsWith('[') || host.includes(':')) return false; // IPv6 literal
  if (/^(10\.|127\.|0\.|169\.254\.|192\.168\.)/.test(host)) return false;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
  return true;
}

async function streamKeyInfo(streamKey: string): Promise<StreamKeyInfo> {
  const cached = STREAM_KEY_CACHE.get(streamKey);
  if (cached && Date.now() - cached.at < STREAM_KEY_TTL_MS) return cached.info;

  let info: StreamKeyInfo = EMPTY_STREAM_KEY;
  try {
    const response = await upstreamText(`${STREAM_KEY_API}/${encodeURIComponent(streamKey)}`, {
      headers: { accept: 'application/json', referer: EMBED_REFERER },
      timeoutMs: EMBED_TIMEOUT_MS,
    });
    if (response.status >= 200 && response.status < 300) {
      const payload = JSON.parse(response.body) as {
        is_external?: unknown;
        external_url?: unknown;
        server_name?: unknown;
      };
      const externalUrl = typeof payload.external_url === 'string' ? payload.external_url : '';
      info = {
        isExternal: payload.is_external === true,
        externalUrl: isSafeExternalUrl(externalUrl) ? externalUrl : '',
        serverName: typeof payload.server_name === 'string' ? payload.server_name : '',
      };
    }
  } catch {
    info = EMPTY_STREAM_KEY;
  }

  STREAM_KEY_CACHE.set(streamKey, { at: Date.now(), info });
  return info;
}

/**
 * The upstream manifest of one server, with a fresh token.
 *
 * The renderer never sees this URL: it addresses servers by a stable id
 * (`<slot>-<quality>-<backend>`) and the token is resolved here, per request.
 * That keeps the player's source URL constant — a rotating token would change
 * the URL on every health check and restart the player mid-match.
 */
export async function resolveManifestUrl(streamKey: string, serverId: string): Promise<string | null> {
  const parts = serverId.split('-');
  if (parts.length !== 3) return null;
  const [slot, quality, backendId] = parts as [string, string, string];

  if (backendId === EXTERNAL_BACKEND.id) {
    const info = await streamKeyInfo(streamKey);
    if (!info.isExternal || !info.externalUrl) return null;
    approveOrigin(info.externalUrl);
    return info.externalUrl;
  }

  const backend = BACKENDS.find((entry) => entry.id === backendId);
  if (!backend || !quality) return null;

  const embedUrls = await sourceEmbedUrls(streamKey);
  for (const embedUrl of embedUrls) {
    const info = await embedInfo(embedUrl);
    if (!info) continue;
    const infoSlot = info.suffix === '' ? '1' : info.suffix;
    if (infoSlot !== slot) continue;
    const token = info.tokens[quality];
    if (!token?._t) continue;
    const variant = `${streamKey}${quality}${info.suffix}`;
    return `${STREAMFREE_HOST}/${backend.path}/${variant}/index.m3u8${tokenQuery(token)}`;
  }

  return null;
}

/* ------------------------------------------------------------------ */
/* Manifest probing                                                    */
/* ------------------------------------------------------------------ */

interface ManifestProbe {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly mediaSequence: number;
  readonly edgeAgeSeconds: number;
  readonly alive: boolean;
}

function parseManifest(text: string): { mediaSequence: number; segments: string[] } {
  const mediaSequence = Number(text.match(/EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? 0);
  const segments: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    segments.push(line);
  }
  return { mediaSequence, segments };
}

/**
 * Fetches a manifest, trying each referer in turn. The provider's CDN demands
 * a strmfree referer; a third-party host usually wants none at all, so the
 * empty string (no header) is tried first there.
 */
async function fetchManifest(
  manifestUrl: string,
  referers: readonly string[],
): Promise<{ status: number; body: string } | null> {
  for (const referer of referers) {
    const headers: Record<string, string> = {
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
    };
    if (referer) headers.referer = referer;
    try {
      const response = await upstreamText(manifestUrl, { headers, timeoutMs: PROBE_TIMEOUT_MS });
      if (response.status >= 200 && response.status < 300) {
        return { status: response.status, body: response.body };
      }
      // Only a referer rejection is worth a second try.
      if (response.status !== 403 && response.status !== 405) return null;
    } catch {
      // Network failure: the next referer would fail the same way.
      return null;
    }
  }
  return null;
}

async function probeManifest(
  manifestUrl: string,
  referers: readonly string[] = [EMBED_REFERER],
): Promise<ManifestProbe> {
  const started = Date.now();
  const failed: ManifestProbe = {
    ok: false,
    latencyMs: Date.now() - started,
    mediaSequence: 0,
    edgeAgeSeconds: Number.POSITIVE_INFINITY,
    alive: false,
  };

  const manifest = await fetchManifest(manifestUrl, referers);
  if (!manifest) return failed;

  const latencyMs = Date.now() - started;
  const { mediaSequence, segments } = parseManifest(manifest.body);
  if (segments.length === 0) {
    return { ok: true, latencyMs, mediaSequence, edgeAgeSeconds: Number.POSITIVE_INFINITY, alive: false };
  }

  // Newest segment: does it still download, and how old is it? The CDN stamps
  // segments with Last-Modified, which is the segment's own production time —
  // so its age is the feed's lag behind the live edge.
  const last = segments[segments.length - 1] ?? '';
  let segmentUrl = last;
  try {
    segmentUrl = new URL(last, manifestUrl).toString();
  } catch {
    // keep raw
  }

  let edgeAgeSeconds = Number.POSITIVE_INFINITY;
  let alive = false;
  for (const referer of referers) {
    const headers: Record<string, string> = {};
    if (referer) headers.referer = referer;
    try {
      const response = await upstreamHead(segmentUrl, { headers, timeoutMs: PROBE_TIMEOUT_MS });
      if (response.status >= 200 && response.status < 300) {
        alive = true;
        const lastModified = response.headers['last-modified'];
        const raw = Array.isArray(lastModified) ? lastModified[0] : lastModified;
        if (raw) {
          const stamp = Date.parse(raw);
          if (!Number.isNaN(stamp)) edgeAgeSeconds = Math.max(0, (Date.now() - stamp) / 1000);
        }
        break;
      }
      if (response.status !== 403 && response.status !== 405) break;
    } catch {
      break;
    }
  }

  return { ok: true, latencyMs, mediaSequence, edgeAgeSeconds, alive };
}

/* ------------------------------------------------------------------ */
/* Resolver                                                            */
/* ------------------------------------------------------------------ */

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
  deadline: number,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      if (Date.now() >= deadline) return;
      const index = cursor++;
      const item = items[index] as T;
      try {
        results[index] = await worker(item);
      } catch {
        results[index] = undefined as R;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

function scoreServer(quality: string, edgeAgeSeconds: number, latencyMs: number): number {
  const qualityWeight = QUALITY_WEIGHT[quality] ?? 12;
  const lag = Number.isFinite(edgeAgeSeconds) ? Math.min(edgeAgeSeconds, 90) : 90;
  // Quality first, but a feed that is a minute behind loses to a sharper one.
  return qualityWeight - lag * 0.5 - Math.min(latencyMs, 2_000) / 1_000;
}

export async function resolveServers(streamKey: string): Promise<ResolvedPool> {
  const cached = RESOLVE_CACHE.get(streamKey);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) {
    return { servers: cached.servers, state: cached.state };
  }

  const deadline = Date.now() + RESOLVE_BUDGET_MS;

  const { urls: embedUrls, liveUrls, ok: sourcesOk } = await sourceEmbeds(streamKey);
  const infos = await mapWithLimit(embedUrls, 4, (url) => embedInfo(url), deadline);

  // The provider tells us, in two independent ways, whether the match is
  // actually on air: `live_sources` in the API and IS_LIVE on the embed page.
  // The API is the authority — it is what the provider's own player polls —
  // so the embed flag is only a fallback for when the API could not be read.
  const providerSaysLive = sourcesOk
    ? liveUrls.length > 0
    : infos.some((info) => info?.isLive === true);
  const embedsReadable = infos.some((info) => info !== null && info !== undefined);

  // Nothing to play yet: the match has not started, so there is no media to
  // probe. Say so instead of reporting an empty, failed-looking pool — unless
  // the pool worked moments ago, in which case the provider has simply stopped
  // listing the match as live and the last known good mirrors still stand.
  if (!providerSaysLive && embedsReadable) {
    const previous = LAST_GOOD.get(streamKey);
    if (previous && Date.now() - previous.at < LAST_GOOD_TTL_MS) {
      RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers: previous.servers, state: 'ready' });
      return { servers: previous.servers.map((server) => ({ ...server, stale: true })), state: 'ready' };
    }
    RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers: [], state: 'waiting' });
    return { servers: [], state: 'waiting' };
  }

  interface Candidate {
    readonly backend: ServerBackend;
    readonly backendLabel: string;
    readonly quality: string;
    readonly slot: string;
    readonly manifestUrl: string;
    readonly referers: readonly string[];
  }

  const candidates: Candidate[] = [];

  infos.forEach((info) => {
    if (!info) return;
    const slot = info.suffix === '' ? '1' : info.suffix;
    for (const backend of BACKENDS) {
      for (const quality of Object.keys(info.tokens)) {
        const token = info.tokens[quality];
        if (!token?._t) continue;
        const variant = `${streamKey}${quality}${info.suffix}`;
        candidates.push({
          backend: backend.id,
          backendLabel: backend.label,
          quality,
          slot,
          manifestUrl: `${STREAMFREE_HOST}/${backend.path}/${variant}/index.m3u8${tokenQuery(token)}`,
          referers: [EMBED_REFERER],
        });
      }
    }
  });

  // Some matches are hosted on a third-party site. The provider points at it
  // with one URL — there is no backend matrix to walk, so it is probed as it
  // stands.
  const keyInfo = await streamKeyInfo(streamKey);
  if (keyInfo.isExternal && keyInfo.externalUrl) {
    approveOrigin(keyInfo.externalUrl);
    candidates.push({
      backend: EXTERNAL_BACKEND.id,
      backendLabel: EXTERNAL_BACKEND.label,
      quality: infos.find((info) => info?.quality)?.quality ?? '1080p',
      slot: '1',
      manifestUrl: keyInfo.externalUrl,
      referers: ['', EMBED_REFERER],
    });
  }

  const probes = await mapWithLimit(
    candidates,
    MAX_CONCURRENCY,
    async (candidate) => {
      const probe = await probeManifest(candidate.manifestUrl, candidate.referers);
      return { candidate, probe };
    },
    deadline,
  );

  const servers: ResolvedServer[] = [];
  for (const entry of probes) {
    if (!entry) continue;
    const { candidate, probe } = entry;
    if (!probe.ok || !probe.alive) continue;
    const id = `${candidate.slot}-${candidate.quality}-${candidate.backend}`;
    servers.push({
      id,
      slot: candidate.slot,
      slotLabel: `S${candidate.slot}`,
      quality: candidate.quality,
      backend: candidate.backend,
      backendLabel: candidate.backendLabel,
      manifestUrl: candidate.manifestUrl,
      // Stable by design: the server id addresses the mirror, the token is
      // resolved server-side on every request. A URL that changed on every
      // health check would restart the player mid-match.
      proxyUrl: `/api/hls/manifest?key=${encodeURIComponent(streamKey)}&server=${encodeURIComponent(id)}`,
      latencyMs: probe.latencyMs,
      edgeAgeSeconds: Number.isFinite(probe.edgeAgeSeconds) ? probe.edgeAgeSeconds : 90,
      mediaSequence: probe.mediaSequence,
      alive: true,
      score: scoreServer(candidate.quality, probe.edgeAgeSeconds, probe.latencyMs),
      label: `${candidate.backendLabel} · ${candidate.quality}`,
    });
  }

  servers.sort((a, b) => b.score - a.score);

  if (servers.length > 0) {
    RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers, state: 'ready' });
    LAST_GOOD.set(streamKey, { at: Date.now(), servers });
    return { servers, state: 'ready' };
  }

  // Nothing answered this time. If the pool worked moments ago, keep showing
  // it (flagged stale) instead of pretending the match has no servers.
  const previous = LAST_GOOD.get(streamKey);
  if (previous && Date.now() - previous.at < LAST_GOOD_TTL_MS) {
    RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers: previous.servers, state: 'ready' });
    return { servers: previous.servers.map((server) => ({ ...server, stale: true })), state: 'ready' };
  }

  // No media: either the provider says it is live but nothing answered (a real
  // failure), or the provider could not be reached at all.
  const state: PoolState = providerSaysLive || !sourcesOk ? 'unknown' : 'waiting';
  RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers: [], state });
  return { servers: [], state };
}
