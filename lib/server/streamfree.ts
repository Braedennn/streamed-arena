// Server-side StreamFree resolver — the app's own "scraper".
//
// The public API only advertises two embed pages per match (both 1080p) and
// says nothing about quality, health or lag. The embed page itself, however,
// carries the real delivery matrix:
//   - a token map for up to four qualities (2160p/1080p/720p/540p)
//   - a source slot ("1" or "2") — often a completely independent upstream feed
//   - and three interchangeable media doors (/live/ on the main site, /live-cdn/
//     on the CDN, and /live/ on the provider's mirror host) that can each serve
//     the same variant
//
// Two more provider endpoints complete the picture:
//   - /api/v1/sources/:key also lists `live_sources`: the embed pages whose
//     feed is actually switched on. An empty list means the provider has not
//     switched the match on — but the flag is the provider's own bookkeeping,
//     and the media is the ground truth. A feed that is up while the flag is
//     still off is therefore probed and played all the same; the flag only
//     decides what the app *says* about a feed that has no media yet.
//   - /get-stream-key/:key (the same call the provider's own player makes)
//     reports when a match is hosted on a third-party site and where.
//
// The board endpoint is read as well: it is the only place the provider names
// the competition, and that name is what a refused feed is recognised by (see
// lib/broadcasters.ts).
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

import { isBlockedFeed } from '@/lib/broadcasters';
import type { BroadcastFacts } from '@/lib/broadcasters';
import { isCollegeFootball, isSkycastFeed, isSkycastMatchup, skycastGames } from '@/lib/server/espn-watch';
import { approveOrigin } from '@/lib/server/origins';
import {
  MIRROR_HOST,
  MIRROR_REFERER,
  STREAMFREE_HOST,
  STREAMFREE_REFERER,
} from '@/lib/server/provider';
import { upstreamPeek, upstreamText } from '@/lib/server/upstream';
import { sourceUrls } from '@/lib/sources';
import type { ServerCandidate } from '@/lib/types';

const SOURCES_API = `${STREAMFREE_HOST}/api/v1/sources`;
const BOARDS_API = `${STREAMFREE_HOST}/api/v1/streams`;
const STREAM_KEY_API = `${STREAMFREE_HOST}/get-stream-key`;
const EMBED_REFERER = STREAMFREE_REFERER;

/**
 * Media backends that can serve a variant.
 *
 * Three of them answer with the same video: the CDN edge, the origin and the
 * provider's second front door (the mirror). The provider also lists an
 * "external" door, but it answers with a placeholder picture instead of media
 * — a mirror nobody can watch, so it is not offered.
 */
const BACKENDS = [
  { id: 'cdn', label: 'CDN', host: STREAMFREE_HOST, path: 'live-cdn', referers: [EMBED_REFERER] },
  { id: 'origin', label: 'Origin', host: STREAMFREE_HOST, path: 'live', referers: [EMBED_REFERER] },
  {
    id: 'mirror',
    label: 'Mirror',
    host: MIRROR_HOST,
    path: 'live',
    referers: [MIRROR_REFERER, EMBED_REFERER],
  },
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
 *
 * The state is decided by the media, not by the provider's flag: a feed that
 * answers is `ready` even when the provider still calls it "not started".
 */
export type PoolState =
  /** At least one mirror answered and is playable. */
  | 'ready'
  /** The provider says the match has not started — no media exists yet. */
  | 'waiting'
  /** The provider says it is live but nothing answered. */
  | 'unknown'
  /** The app refuses this feed — see lib/broadcasters.ts. */
  | 'refused';

export interface ResolvedPool {
  readonly servers: readonly ResolvedServer[];
  readonly state: PoolState;
}

export type ResolvedServer = ServerCandidate & {
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
  /** The title the provider gives the feed on its own page. */
  readonly streamName: string;
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
/**
 * How long a pool with no media yet is remembered.
 *
 * Short on purpose: the provider switches a feed on without warning, and the
 * server rows should appear the moment it does rather than a minute later.
 */
const RESOLVE_WAIT_TTL_MS = 5_000;
/**
 * How long a refusal is remembered.
 *
 * A refused feed does not change while the match is on, and the list it comes
 * from is read every ten minutes - so the refusal is remembered for as long.
 */
const RESOLVE_REFUSED_TTL_MS = 5 * 60_000;

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
  const streamName = html.match(/const\s+STREAM_NAME\s*=\s*'([^']*)'/)?.[1] ?? '';
  if (!quality || Object.keys(tokens).length === 0) return null;
  return { quality, suffix, isLive, tokens, url: '', streamName };
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
 * The board's own view of a match.
 *
 * The per-match endpoint and the board endpoint are two views of the same
 * provider, and they do not always agree: the board can list a match as live
 * while the per-match endpoint still says it has not started. Believing the
 * per-match endpoint alone made the app tell the user that a running game
 * "has not started yet" - with no servers and no video. The board's view is
 * used as the second opinion, and the match is only called "not started" when
 * both agree.
 *
 * The board is also the only place the provider names the competition, so it
 * is where a refused feed is recognised (see lib/broadcasters.ts).
 */
interface BoardView {
  readonly liveUrls: string[];
  readonly name: string;
  readonly category: string;
  readonly league: string;
}

const EMPTY_BOARD_VIEW: BoardView = { liveUrls: [], name: '', category: '', league: '' };

/**
 * One board read serves every match.
 *
 * The board lists all matches at once, so reading it per match fetched the
 * same list over and over. One snapshot is kept and every match reads its own
 * line out of it.
 */
let boardSnapshot: { at: number; ok: boolean; entries: Map<string, BoardView> } | null = null;
const BOARD_TTL_MS = 10_000;

async function boardSnapshotView(): Promise<{ entries: Map<string, BoardView>; ok: boolean }> {
  const cached = boardSnapshot;
  if (cached && Date.now() - cached.at < BOARD_TTL_MS) {
    return { entries: cached.entries, ok: cached.ok };
  }

  const entries = new Map<string, BoardView>();
  let ok = false;
  try {
    const response = await upstreamText(BOARDS_API, {
      headers: { accept: 'application/json' },
      timeoutMs: EMBED_TIMEOUT_MS,
    });
    if (response.status >= 200 && response.status < 300) {
      const payload = JSON.parse(response.body) as { streams?: unknown } | unknown[];
      // The board answers with either {streams: [...]} or a bare list.
      const streams = Array.isArray(payload) ? payload : payload.streams;
      for (const entry of Array.isArray(streams) ? streams : []) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as {
          stream_key?: unknown;
          live_sources?: unknown;
          name?: unknown;
          category?: unknown;
          league?: unknown;
        };
        if (typeof record.stream_key !== 'string') continue;
        entries.set(record.stream_key, {
          liveUrls: sourceUrls(record.live_sources),
          name: typeof record.name === 'string' ? record.name : '',
          category: typeof record.category === 'string' ? record.category : '',
          league: typeof record.league === 'string' ? record.league : '',
        });
      }
      ok = true;
    }
  } catch {
    ok = false;
  }

  boardSnapshot = { at: Date.now(), ok, entries };
  return { entries, ok };
}

async function boardView(streamKey: string): Promise<{ view: BoardView; ok: boolean }> {
  const snapshot = await boardSnapshotView();
  return { view: snapshot.entries.get(streamKey) ?? EMPTY_BOARD_VIEW, ok: snapshot.ok };
}

/**
 * The feeds the arena refuses, by stream key.
 *
 * The list is what the app hides from the board: a feed the provider labels
 * with a blocked broadcaster, and a feed for a game ESPN offers as SkyCast.
 */
export async function refusedStreamKeys(): Promise<string[]> {
  const [{ entries }, skycast] = await Promise.all([boardSnapshotView(), skycastGames()]);
  const refused: string[] = [];
  for (const [key, view] of entries) {
    if (
      isBlockedFeed({
        name: view.name,
        category: view.category,
        league: view.league,
        streamKey: key,
      })
    ) {
      refused.push(key);
      continue;
    }
    // SkyCast is a college football product, so only those games are checked
    // against ESPN's list.
    if (
      skycast.length > 0 &&
      isCollegeFootball(view.category, view.league) &&
      isSkycastMatchup(view.name, skycast)
    ) {
      refused.push(key);
    }
  }
  return refused;
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
  /** The host the provider says the media is pulled from. */
  readonly serverDomain: string;
}

const EMPTY_STREAM_KEY: StreamKeyInfo = {
  isExternal: false,
  externalUrl: '',
  serverName: '',
  serverDomain: '',
};

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
        server_domain?: unknown;
      };
      const externalUrl = typeof payload.external_url === 'string' ? payload.external_url : '';
      info = {
        isExternal: payload.is_external === true,
        externalUrl: isSafeExternalUrl(externalUrl) ? externalUrl : '',
        serverName: typeof payload.server_name === 'string' ? payload.server_name : '',
        serverDomain: typeof payload.server_domain === 'string' ? payload.server_domain : '',
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
  return `${backend.host}/${backend.path}/${variant}/index.m3u8${tokenQuery(rendition.token)}`;
}

/* ------------------------------------------------------------------ */
/* Manifest probing                                                    */
/* ------------------------------------------------------------------ */

interface ManifestProbe {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly mediaSequence: number;
  /**
   * When the newest segment was produced, in the door's own words.
   *
   * Every door stamps the same file with the same time, so the stamps can be
   * compared directly. An age measured against each door's own clock would
   * not be: the download of a four-megabyte segment takes longer than that
   * segment is old, so whichever door was probed last looked like the laggiest
   * one.
   */
  readonly edgeStampMs: number;
  /** When this probe finished - the instant its stamp was read at. */
  readonly probedAtMs: number;
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

/** How many bytes of a segment are enough to recognise the media format. */
const SNIFF_BYTES = 376;

/**
 * Do these bytes look like something a player can play?
 *
 * The provider's "external" mirror answers with a placeholder image: the
 * playlist is fine, the segment URL answers 200, the content type even says
 * "image/png" — and the payload is a picture, not video. Such a mirror cannot
 * be played, so it must not end up in the pool as the best server.
 *
 * MPEG-TS starts with a sync byte every 188 bytes; an ISO base media file
 * (fMP4) starts with an "ftyp" box.
 */
export function looksLikeMedia(head: Buffer): boolean {
  if (head.length < 4) return false;
  if (head[0] === 0x47 && (head.length < 188 || head[188] === 0x47)) return true;
  if (head.length >= 8 && head.subarray(4, 8).toString('latin1') === 'ftyp') return true;
  return false;
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
    edgeStampMs: Number.NaN,
    probedAtMs: Date.now(),
    alive: false,
  };

  const manifest = await fetchManifest(manifestUrl, referers);
  if (!manifest) return failed;

  const latencyMs = Date.now() - started;
  const { mediaSequence, segments } = parseManifest(manifest.body);
  if (segments.length === 0) {
    return {
      ok: true,
      latencyMs,
      mediaSequence,
      edgeStampMs: Number.NaN,
      probedAtMs: Date.now(),
      alive: false,
    };
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

  let edgeStampMs = Number.NaN;
  let alive = false;
  for (const referer of referers) {
    const headers: Record<string, string> = {};
    if (referer) headers.referer = referer;
    try {
      // The first bytes decide whether this mirror can be played at all.
      const response = await upstreamPeek(segmentUrl, SNIFF_BYTES, {
        headers,
        timeoutMs: SEGMENT_TIMEOUT_MS,
      });
      if (response.status >= 200 && response.status < 300) {
        if (!looksLikeMedia(response.head)) break;
        alive = true;
        const lastModified = response.headers['last-modified'];
        const raw = Array.isArray(lastModified) ? lastModified[0] : lastModified;
        if (raw) {
          const stamp = Date.parse(raw);
          if (!Number.isNaN(stamp)) edgeStampMs = stamp;
        }
        break;
      }
      if (response.status !== 403 && response.status !== 405) break;
    } catch {
      break;
    }
  }

  return { ok: true, latencyMs, mediaSequence, edgeStampMs, probedAtMs: Date.now(), alive };
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

/**
 * How far behind the live edge each door is.
 *
 * Every door stamps the same segment with the same time, so the stamps can be
 * compared directly - and they have to be: the probe of a door downloads a
 * four-megabyte segment, and that download takes longer than the segment is
 * old. Measuring each door against its own clock therefore punished
 * whichever door was probed last, which is how the fastest door ended up
 * ranked as the laggiest one.
 *
 * The freshest door sets the reference. Every other door is measured against
 * it, so the ranking says how far behind each door really is.
 */
function edgeAges(
  probes: readonly { probe: ManifestProbe }[],
): (probe: ManifestProbe) => number {
  let freshestStamp = Number.NaN;
  let freshestAt = Date.now();
  for (const entry of probes) {
    const stamp = entry.probe.edgeStampMs;
    if (!Number.isFinite(stamp)) continue;
    if (!Number.isFinite(freshestStamp) || stamp > freshestStamp) {
      freshestStamp = stamp;
      freshestAt = entry.probe.probedAtMs;
    }
  }

  // How far the feed itself is behind the live edge, as the freshest door saw
  // it. Every door carries this much; what differs is the distance between
  // the doors.
  const feedLag = Number.isFinite(freshestStamp)
    ? Math.max(0, (freshestAt - freshestStamp) / 1_000)
    : 90;

  return (probe: ManifestProbe): number => {
    if (!Number.isFinite(probe.edgeStampMs) || !Number.isFinite(freshestStamp)) return 90;
    const behind = Math.max(0, (freshestStamp - probe.edgeStampMs) / 1_000);
    return Math.min(90, feedLag + behind);
  };
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
 *
 * `includePublished` is the exception, and it matters. The provider's own
 * "this feed is live" flag and the media do not always agree - the flag
 * lags, and it has been known to stay off while the media was already up.
 * The media is the ground truth, so a match the flag calls "not started" is
 * probed anyway, on the slot the provider publishes its media on. That is
 * what puts the server rows on the screen in the minutes before the feed is
 * switched on, instead of a good while after it.
 */
export function buildCandidates(
  streamKey: string,
  pages: readonly EmbedInfo[],
  liveUrls: readonly string[],
  sourcesOk: boolean,
  includePublished = false,
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

  // The slots to probe: the ones the provider says are on, or - when it says
  // none - the slot it publishes its media on.
  const wanted = new Set(liveSlots);
  if (wanted.size === 0 && includePublished) {
    for (const page of pages) {
      const slot = slotOf(page);
      if (slot === '1' || page.isLive) wanted.add(slot);
    }
  }

  const candidates: Candidate[] = [];
  for (const [slot, slotPages] of groupBySlot(pages)) {
    if (!wanted.has(slot)) continue;
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
          manifestUrl: `${backend.host}/${backend.path}/${variant}/index.m3u8${tokenQuery(rendition.token)}`,
          referers: backend.referers,
        });
      }
    }
  }
  return candidates;
}

export async function resolveServers(streamKey: string): Promise<ResolvedPool> {
  const cached = RESOLVE_CACHE.get(streamKey);
  if (cached) {
    // A feed that is not up yet is checked again quickly: the provider
    // switches it on without warning, and the server rows should appear the
    // moment it does - not a minute later.
    //
    // A refused feed is the opposite: it does not change while the match is
    // on, so it is remembered for as long as the list it comes from.
    const ttl =
      cached.state === 'ready'
        ? RESOLVE_TTL_MS
        : cached.state === 'refused'
          ? RESOLVE_REFUSED_TTL_MS
          : RESOLVE_WAIT_TTL_MS;
    if (Date.now() - cached.at < ttl) {
      return { servers: cached.servers, state: cached.state };
    }
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
  const board = await boardView(streamKey);
  const boardSaysLive = board.ok && board.view.liveUrls.length > 0;

  const providerSaysLive = perMatchSaysLive || boardSaysLive;
  // Pages that are switched on: the per-match list, or the board's list when
  // only the board knows.
  const livePages = new Set<string>([...liveUrls, ...board.view.liveUrls]);

  // Some matches are hosted on a third-party site. The provider points at it
  // with one URL — there is no backend matrix to walk, so it is probed as it
  // stands.
  const keyInfo = await streamKeyInfo(streamKey);

  // Refused feeds never reach the player. The provider names no broadcaster,
  // so the feed is recognised by the names it does print — the match, its
  // competition, the title on its own embed page and the server the media is
  // pulled from (see lib/broadcasters.ts).
  const facts: BroadcastFacts = {
    name: board.view.name,
    category: board.view.category,
    league: board.view.league,
    streamKey,
    embedName: pages.map((page) => page.streamName).find((name) => Boolean(name)) ?? '',
    serverName: keyInfo.serverName,
    serverDomain: keyInfo.serverDomain,
  };
  if (isBlockedFeed(facts)) {
    RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers: [], state: 'refused' });
    return { servers: [], state: 'refused' };
  }

  // SkyCast is the other way round: ESPN names it and the provider does not.
  // ESPN's watch schedule lists the games it offers as SkyCast — the college
  // football alternate with the picture and the crowd but no announcers.
  //
  // The provider takes the primary feed of such a game, though: for the two
  // games ESPN offered as SkyCast while this was written, the provider's
  // picture carried the network's own bug ("ESPN on abc", "ESPN") and the
  // audio had the commentators. So only a game ESPN lists as SkyCast *and*
  // under no other name is refused — see lib/server/espn-watch.ts.
  //
  // Only college football is checked: SkyCast is a college football product,
  // and a name that matches a listing in another sport is a coincidence.
  if (
    isCollegeFootball(board.view.category, board.view.league) &&
    (await isSkycastFeed(board.view.name))
  ) {
    RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers: [], state: 'refused' });
    return { servers: [], state: 'refused' };
  }

  // Which feed slots are actually on air, and which mirror of each quality is
  // worth probing. The provider publishes a page per quality for the same
  // slot, so the live list is folded down to slots first.
  //
  // When the provider says the feed is not on, the published slot is probed
  // anyway: the flag is the provider's bookkeeping, the playlist is the
  // truth. A feed that is up while the flag is still off is then played right
  // away - which is what puts the rows on the screen before the kick-off, and
  // what keeps them there when the flag lags behind the media.
  const candidates = buildCandidates(
    streamKey,
    pages,
    [...livePages],
    sourcesOk,
    !providerSaysLive,
  );

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

  // How far behind the live edge each door really is, measured against the
  // freshest door instead of against each door's own clock.
  const edgeAgeFor = edgeAges(
    probes.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
  );

  // One row per mirror. The same mirror can be reached through more than one
  // candidate (the provider publishes a page per quality for the same slot),
  // so the id is the identity: keep the best measurement, drop the rest.
  const byId = new Map<string, ResolvedServer>();
  for (const entry of probes) {
    if (!entry) continue;
    const { candidate, probe } = entry;
    if (!probe.ok || !probe.alive) continue;
    const edgeAgeSeconds = edgeAgeFor(probe);
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
      edgeAgeSeconds,
      mediaSequence: probe.mediaSequence,
      alive: true,
      score: scoreServer(candidate.quality, edgeAgeSeconds, probe.latencyMs),
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

  // No media. The provider has not switched the feed on yet — the app says
  // so instead of reporting an empty, failed-looking pool. If the provider
  // says it *is* live but nothing answered, that is a real failure; and if the
  // provider could not be read at all, the app cannot tell either.
  const state: PoolState = providerSaysLive || !sourcesOk || !embedsReadable ? 'unknown' : 'waiting';
  RESOLVE_CACHE.set(streamKey, { at: Date.now(), servers: [], state });
  return { servers: [], state };
}
