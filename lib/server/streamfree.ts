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

import { upstreamHead, upstreamText } from '@/lib/server/upstream';
import type { ServerCandidate } from '@/lib/types';

const STREAMFREE_HOST = 'https://strmfree.st';
const SOURCES_API = `${STREAMFREE_HOST}/api/v1/sources`;
const EMBED_REFERER = `${STREAMFREE_HOST}/`;

/** Media backends that can serve a variant. */
const BACKENDS = [
  { id: 'cdn', label: 'CDN', path: 'live-cdn' },
  { id: 'external', label: 'External', path: 'live-externalcdn' },
  { id: 'origin', label: 'Origin', path: 'live' },
] as const;

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

export type ServerBackend = (typeof BACKENDS)[number]['id'];

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
  readonly tokens: Record<string, QualityToken>;
}

const EMBED_CACHE = new Map<string, { at: number; info: EmbedInfo | null }>();
const EMBED_TTL_MS = 60_000;

/** Embed pages per match (the sources API result). */
const SOURCES_CACHE = new Map<string, { at: number; urls: string[] }>();
const SOURCES_TTL_MS = 60_000;

const RESOLVE_CACHE = new Map<string, { at: number; servers: ResolvedServer[] }>();
const RESOLVE_TTL_MS = 15_000;

const LAST_GOOD = new Map<string, { at: number; servers: ResolvedServer[] }>();

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
  if (!quality || Object.keys(tokens).length === 0) return null;
  return { quality, suffix, tokens };
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

/** The embed pages of a match (cached — the list is stable for minutes). */
async function sourceEmbedUrls(streamKey: string): Promise<string[]> {
  const cached = SOURCES_CACHE.get(streamKey);
  if (cached && Date.now() - cached.at < SOURCES_TTL_MS) return cached.urls;

  let urls: string[] = [];
  try {
    const response = await upstreamText(`${SOURCES_API}/${encodeURIComponent(streamKey)}`, {
      headers: { accept: 'application/json' },
      timeoutMs: EMBED_TIMEOUT_MS,
    });
    if (response.status >= 200 && response.status < 300) {
      const payload = JSON.parse(response.body) as { sources?: unknown };
      if (Array.isArray(payload.sources)) {
        urls = payload.sources.filter((entry): entry is string => typeof entry === 'string');
      }
    }
  } catch {
    urls = [];
  }

  SOURCES_CACHE.set(streamKey, { at: Date.now(), urls });
  return urls;
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

async function probeManifest(manifestUrl: string): Promise<ManifestProbe> {
  const started = Date.now();
  const failed: ManifestProbe = {
    ok: false,
    latencyMs: Date.now() - started,
    mediaSequence: 0,
    edgeAgeSeconds: Number.POSITIVE_INFINITY,
    alive: false,
  };

  let text: string;
  try {
    const response = await upstreamText(manifestUrl, {
      headers: {
        accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
        referer: EMBED_REFERER,
      },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) return failed;
    text = response.body;
  } catch {
    return failed;
  }

  const latencyMs = Date.now() - started;
  const { mediaSequence, segments } = parseManifest(text);
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
  try {
    const response = await upstreamHead(segmentUrl, {
      headers: { referer: EMBED_REFERER },
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (response.status >= 200 && response.status < 300) {
      alive = true;
      const lastModified = response.headers['last-modified'];
      const raw = Array.isArray(lastModified) ? lastModified[0] : lastModified;
      if (raw) {
        const stamp = Date.parse(raw);
        if (!Number.isNaN(stamp)) edgeAgeSeconds = Math.max(0, (Date.now() - stamp) / 1000);
      }
    }
  } catch {
    alive = false;
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

export async function resolveServers(streamKey: string): Promise<ResolvedServer[]> {
  const cached = RESOLVE_CACHE.get(streamKey);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) return cached.servers;

  const deadline = Date.now() + RESOLVE_BUDGET_MS;

  const embedUrls = await sourceEmbedUrls(streamKey);
  const infos = await mapWithLimit(embedUrls, 4, (url) => embedInfo(url), deadline);

  interface Candidate {
    readonly info: EmbedInfo;
    readonly backend: (typeof BACKENDS)[number];
    readonly quality: string;
  }

  const candidates: Candidate[] = [];

  infos.forEach((info) => {
    if (!info) return;
    for (const backend of BACKENDS) {
      for (const quality of Object.keys(info.tokens)) {
        const token = info.tokens[quality];
        if (!token?._t) continue;
        candidates.push({ info, backend, quality });
      }
    }
  });

  const probes = await mapWithLimit(
    candidates,
    MAX_CONCURRENCY,
    async (candidate) => {
      const token = candidate.info.tokens[candidate.quality];
      if (!token?._t) return null;
      const variant = `${streamKey}${candidate.quality}${candidate.info.suffix}`;
      const manifestUrl = `${STREAMFREE_HOST}/${candidate.backend.path}/${variant}/index.m3u8${tokenQuery(token)}`;
      const probe = await probeManifest(manifestUrl);
      return { candidate, manifestUrl, probe };
    },
    deadline,
  );

  const servers: ResolvedServer[] = [];
  for (const entry of probes) {
    if (!entry) continue;
    const { candidate, manifestUrl, probe } = entry;
    if (!probe.ok || !probe.alive) continue;
    const slot = candidate.info.suffix === '' ? '1' : candidate.info.suffix;
    const id = `${slot}-${candidate.quality}-${candidate.backend.id}`;
    servers.push({
      id,
      slot,
      slotLabel: `S${slot}`,
      quality: candidate.quality,
      backend: candidate.backend.id,
      backendLabel: candidate.backend.label,
      manifestUrl,
      // Stable by design: the server id addresses the mirror, the token is
      // resolved server-side on every request. A URL that changed on every
      // health check would restart the player mid-match.
      proxyUrl: `/api/hls/manifest?key=${encodeURIComponent(streamKey)}&server=${encodeURIComponent(id)}`,
      latencyMs: probe.latencyMs,
      edgeAgeSeconds: Number.isFinite(probe.edgeAgeSeconds) ? probe.edgeAgeSeconds : 90,
      mediaSequence: probe.mediaSequence,
      alive: true,
      score: scoreServer(candidate.quality, probe.edgeAgeSeconds, probe.latencyMs),
      label: `${candidate.backend.label} · ${candidate.quality}`,
    });
  }

  servers.sort((a, b) => b.score - a.score);

  if (servers.length > 0) {
    RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers });
    LAST_GOOD.set(streamKey, { at: Date.now(), servers });
    return servers;
  }

  // Nothing answered this time. If the pool worked moments ago, keep showing
  // it (flagged stale) instead of pretending the match has no servers.
  const previous = LAST_GOOD.get(streamKey);
  if (previous && Date.now() - previous.at < LAST_GOOD_TTL_MS) {
    RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers: previous.servers });
    return previous.servers.map((server) => ({ ...server, stale: true }));
  }

  RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers: [] });
  return [];
}
