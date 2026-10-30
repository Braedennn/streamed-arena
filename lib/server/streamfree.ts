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
import { sourceUrls } from '@/lib/sources';
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

const PROBE_TIMEOUT_MS = 3_500;
const SEGMENT_TIMEOUT_MS = 2_500;
const EMBED_TIMEOUT_MS = 8_000;
const MAX_CONCURRENCY = 12;
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

export interface EmbedInfo {
  readonly quality: string;
  readonly suffix: string;
  /** The provider's own "is this feed switched on" flag. */
  readonly isLive: boolean;
  readonly tokens: Record<string, QualityToken>;
  /** The page this came from — used to match it against `live_sources`. */
  readonly url: string;
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
  return { quality, suffix, isLive, tokens, url: '' };
}

/** The feed slot a page belongs to. The provider suffixes slot 2 with "2". */
function slotOf(info: EmbedInfo): string {
  if (info.suffix === '' || info.suffix === '1') return '1';
  return info.suffix;
}

/**
 * One rendition of a slot: a quality and the token that unlocks it.
 *
 * The provider publishes one page per quality of a slot ("...1080p",
 * "...2160p") and lists the pages that are switched on. A rendition is
 * therefore one published page - its own quality, with that page's token for
 * it. Walking the token map instead would probe four qualities where only
 * the published ones exist, and would list the same mirror again for every
 * page that mentions it.
 */
export interface Rendition {
  readonly quality: string;
  readonly suffix: string;
  readonly token: QualityToken;
}

/** Canonical quality order — best first. */
const QUALITY_ORDER = ['2160p', '1080p', '720p', '540p'];

export function renditionsForSlot(pages: readonly EmbedInfo[]): Rendition[] {
  const ordered = [...pages].sort((a, b) => {
    const rankA = QUALITY_ORDER.indexOf(a.quality);
    const rankB = QUALITY_ORDER.indexOf(b.quality);
    const scoreA = rankA === -1 ? QUALITY_ORDER.length : rankA;
    const scoreB = rankB === -1 ? QUALITY_ORDER.length : rankB;
    return scoreA - scoreB;
  });

  const renditions: Rendition[] = [];
  const seen = new Set<string>();
  for (const page of ordered) {
    const quality = page.quality;
    if (!quality || seen.has(quality)) continue;
    // The token for this page's own quality; any token is a fallback for a
    // page whose map is shaped differently.
    const token = page.tokens[quality] ?? Object.values(page.tokens)[0];
    if (!token?._t) continue;
    seen.add(quality);
    renditions.push({ quality, suffix: page.suffix, token });
  }
  return renditions;
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
      if (info) info = { ...info, url: embedUrl };
    }
  } catch {
    info = null;
  }
  EMBED_CACHE.set(embedUrl, { at: Date.now(), info });
  return info;
}

/** Every embed page of a match that could be read, in the provider's order. */
async function embedPages(streamKey: string): Promise<EmbedInfo[]> {
  const urls = await sourceEmbedUrls(streamKey);
  const infos = await mapWithLimit(
    urls,
    4,
    (url) => embedInfo(url),
    Date.now() + EMBED_TIMEOUT_MS,
  );
  return infos.filter((info): info is EmbedInfo => Boolean(info));
}

/** The pages of a match, grouped by the feed slot they belong to. */
function groupBySlot(pages: readonly EmbedInfo[]): Map<string, EmbedInfo[]> {
  const groups = new Map<string, EmbedInfo[]>();
  for (const page of pages) {
    const slot = slotOf(page);
    const list = groups.get(slot);
    if (list) list.push(page);
    else groups.set(slot, [page]);
  }
  return groups;
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
      // The provider sends either plain URLs or {quality, url} objects - both
      // are read the same way (see lib/sources.ts).
      urls = sourceUrls(payload.sources);
      liveUrls = sourceUrls(payload.live_sources);
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
/* The board's own view of the match                                   */
/* ------------------------------------------------------------------ */

/**
 * The live pages of a match according to the board endpoint.
 *
 * The per-match endpoint and the board endpoint are two views of the same
 * provider, and they do not always agree: the board can list a match as live
 * while the per-match endpoint still says it has not started. Believing the
 * per-match endpoint alone made the app tell the user that a running game
 * "has not started yet" - with no servers and no video. The board's view is
 * used as the second opinion, and the match is only called "not started" when
 * both agree.
 */
const BOARD_CACHE = new Map<string, { at: number; liveUrls: string[]; ok: boolean }>();
const BOARD_TTL_MS = 15_000;

async function boardLiveUrls(streamKey: string): Promise<{ liveUrls: string[]; ok: boolean }> {
  const cached = BOARD_CACHE.get(streamKey);
  if (cached && Date.now() - cached.at < BOARD_TTL_MS) return cached;

  let liveUrls: string[] = [];
  let ok = false;
  try {
    const response = await upstreamText(`${SOURCES_API.replace('/sources', '/streams')}`, {
      headers: { accept: 'application/json' },
      timeoutMs: EMBED_TIMEOUT_MS,
    });
    if (response.status >= 200 && response.status < 300) {
      const payload = JSON.parse(response.body) as { streams?: unknown };
      const streams = Array.isArray(payload.streams) ? payload.streams : [];
      for (const entry of streams) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as { stream_key?: unknown; live_sources?: unknown };
        if (record.stream_key !== streamKey) continue;
        liveUrls = sourceUrls(record.live_sources);
        ok = true;
        break;
      }
    }
  } catch {
    liveUrls = [];
  }

  const entry = { at: Date.now(), liveUrls, ok };
  BOARD_CACHE.set(streamKey, entry);
  return entry;
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

  // The same rendition the pool probed: one token per (slot, quality), taken
  // from the page that is itself that quality when the provider published one.
  const pages = groupBySlot(await embedPages(streamKey)).get(slot);
  if (!pages || pages.length === 0) return null;
  const rendition = renditionsForSlot(pages).find((entry) => entry.quality === quality);
  if (!rendition) return null;

  const variant = `${streamKey}${quality}${rendition.suffix}`;
  return `${STREAMFREE_HOST}/${backend.path}/${variant}/index.m3u8${tokenQuery(rendition.token)}`;
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
      const response = await upstreamHead(segmentUrl, { headers, timeoutMs: SEGMENT_TIMEOUT_MS });
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

export interface Candidate {
  readonly backend: ServerBackend;
  readonly backendLabel: string;
  readonly quality: string;
  readonly slot: string;
  readonly manifestUrl: string;
  readonly referers: readonly string[];
}

/**
 * The mirrors worth probing.
 *
 * One candidate per (slot, quality, backend) — never more. The provider
 * publishes a page per quality for the same slot ("...1080p", "...2160p") and
 * every one of those pages carries a token map for *all* qualities, so walking
 * the pages one by one probed the very same mirror over and over and listed
 * it again and again. The token comes from the page that is itself that
 * quality, which is the one the provider handed it out for.
 *
 * A slot that is not switched on is left alone: there is no media there, so
 * probing it would only burn time.
 */
export function buildCandidates(
  streamKey: string,
  pages: readonly EmbedInfo[],
  liveUrls: readonly string[],
  sourcesOk: boolean,
): Candidate[] {
  const liveUrlSet = new Set(liveUrls);
  const liveSlots = new Set<string>();
  for (const page of pages) {
    if (liveUrlSet.has(page.url)) liveSlots.add(slotOf(page));
  }
  if (!sourcesOk) {
    for (const page of pages) {
      if (page.isLive) liveSlots.add(slotOf(page));
    }
  }
  if (liveSlots.size === 0 && liveUrls.length > 0) {
    // The provider named live pages we could not read — do not give up on the
    // feed just because the embed fetch failed.
    for (const page of pages) liveSlots.add(slotOf(page));
  }

  const candidates: Candidate[] = [];
  for (const [slot, slotPages] of groupBySlot(pages)) {
    if (!liveSlots.has(slot)) continue;
    // The provider says which pages are switched on. Those are the renditions
    // worth probing - a published page that is not live has no media behind
    // it. When it does not say, the published pages of the slot are used.
    const livePages = slotPages.filter((page) => liveUrlSet.has(page.url));
    const usePages = livePages.length > 0 ? livePages : slotPages;
    for (const rendition of renditionsForSlot(usePages)) {
      const variant = `${streamKey}${rendition.quality}${rendition.suffix}`;
      for (const backend of BACKENDS) {
        candidates.push({
          backend: backend.id,
          backendLabel: backend.label,
          quality: rendition.quality,
          slot,
          manifestUrl: `${STREAMFREE_HOST}/${backend.path}/${variant}/index.m3u8${tokenQuery(rendition.token)}`,
          referers: [EMBED_REFERER],
        });
      }
    }
  }
  return candidates;
}

export async function resolveServers(streamKey: string): Promise<ResolvedPool> {
  const cached = RESOLVE_CACHE.get(streamKey);
  if (cached && Date.now() - cached.at < RESOLVE_TTL_MS) {
    return { servers: cached.servers, state: cached.state };
  }

  const deadline = Date.now() + RESOLVE_BUDGET_MS;

  const { urls: embedUrls, liveUrls, ok: sourcesOk } = await sourceEmbeds(streamKey);
  const infos = await mapWithLimit(embedUrls, 4, (url) => embedInfo(url), deadline);
  const pages = infos.filter((info): info is EmbedInfo => Boolean(info));

  // The provider tells us, in two independent ways, whether the match is
  // actually on air: `live_sources` in the API and IS_LIVE on the embed page.
  // The API is the authority — it is what the provider's own player polls —
  // so the embed flag is only a fallback for when the API could not be read.
  const perMatchSaysLive = sourcesOk
    ? liveUrls.length > 0
    : pages.some((info) => info.isLive === true);
  const embedsReadable = pages.length > 0;

  // Second opinion: the board endpoint's own list of the match. The two
  // endpoints do not always agree, and believing the wrong one told the user
  // that a running game "has not started yet". The match is only called not
  // started when both say so.
  let boardSaysLive = false;
  let boardLivePages: string[] = [];
  if (!perMatchSaysLive) {
    const board = await boardLiveUrls(streamKey);
    boardSaysLive = board.ok && board.liveUrls.length > 0;
    boardLivePages = board.liveUrls;
  }

  const providerSaysLive = perMatchSaysLive || boardSaysLive;
  // Pages that are switched on: the per-match list, or the board's list when
  // only the board knows.
  const livePages = new Set<string>([...liveUrls, ...boardLivePages]);

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

  // Which feed slots are actually on air, and which mirror of each quality is
  // worth probing. The provider publishes a page per quality for the same
  // slot, so the live list is folded down to slots first.
  const candidates = buildCandidates(streamKey, pages, [...livePages], sourcesOk);

  // Some matches are hosted on a third-party site. The provider points at it
  // with one URL — there is no backend matrix to walk, so it is probed as it
  // stands.
  const keyInfo = await streamKeyInfo(streamKey);
  if (keyInfo.isExternal && keyInfo.externalUrl) {
    approveOrigin(keyInfo.externalUrl);
    candidates.push({
      backend: EXTERNAL_BACKEND.id,
      backendLabel: EXTERNAL_BACKEND.label,
      quality: pages[0]?.quality ?? '1080p',
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

  // One row per mirror. The same mirror can be reached through more than one
  // candidate (the provider publishes a page per quality for the same slot),
  // so the id is the identity: keep the best measurement, drop the rest.
  const byId = new Map<string, ResolvedServer>();
  for (const entry of probes) {
    if (!entry) continue;
    const { candidate, probe } = entry;
    if (!probe.ok || !probe.alive) continue;
    const id = `${candidate.slot}-${candidate.quality}-${candidate.backend}`;
    const server: ResolvedServer = {
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
    };
    const known = byId.get(id);
    if (!known || server.score > known.score) byId.set(id, server);
  }

  const servers = [...byId.values()];
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
