// The fetch loop of the personal server.
//
// This is what turns the app from a client of somebody else's servers into
// the server itself: the app fetches the media, keeps it, and publishes its
// own playlist. The player asks the app - never a third-party host - and the
// bytes it gets were fetched a moment ago instead of being fetched while it
// waits.
//
// Why fetch ahead at all?
//
// The provider publishes a segment every few seconds. A player that asks for
// a segment the moment it appears waits for the whole segment to travel from
// the provider's edge - one to three seconds, longer when the edge is cold.
// The picture freezes while that happens, again and again, all match.
//
// The server fetches the segments as they appear and keeps them on disk. The
// player's request is then answered from the disk, in milliseconds, and the
// provider's edge is never in the player's critical path.
//
// The floor the server cannot go below is the upstream's own delay: if the
// feed behind the provider is thirty seconds behind the stadium, every copy
// of it is thirty seconds behind too. What the server removes is the jitter
// and the stalling - the part that was ours to fix.

import { upstreamBuffer, upstreamText } from '@/lib/server/upstream';
import { parsePlaylist, type HeldSegment, type PlaylistSegment } from '@/lib/server/media/playlist';
import { pruneChannel, pruneOldRuns, purgeChannel, writeSegment } from '@/lib/server/media/cache';
import {
  channelsForStream,
  forgetChannel,
  forgetSegments,
  holdSegment,
  publishableWindow,
  type MediaChannel,
} from '@/lib/server/media/channels';
import { refreshUpstream, rotateUpstream } from '@/lib/server/media/upstream';
import { looksLikeMedia } from '@/lib/server/media/format';

export interface IngestSettings {
  /** How often the upstream playlist is read. */
  readonly pollMs: number;
  /** How many segments are fetched ahead of the player. */
  readonly prefetchDepth: number;
  /** How many segments are kept on disk. */
  readonly keepSegments: number;
  /** How long a channel keeps fetching after the last client left. */
  readonly idleTtlMs: number;
  /** How many segments are fetched at the same time. */
  readonly concurrency: number;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function ingestSettings(): IngestSettings {
  return {
    // How often the upstream playlist is read. The provider publishes a
    // segment every few seconds, and the server wants to know about it
    // before the player asks for it.
    pollMs: numberFromEnv('ARENA_INGEST_POLL_MS', 1_000),
    // How many segments are fetched ahead of the player. The player sits a
    // few segments behind the edge, so the server keeps a reserve in front of
    // it: a segment that is missing while the player wants it is a stall.
    prefetchDepth: numberFromEnv('ARENA_INGEST_PREFETCH', 6),
    // More than the published window: the reserve keeps the buffer alive
    // while a single segment is missing.
    keepSegments: numberFromEnv('ARENA_INGEST_KEEP', 16),
    idleTtlMs: numberFromEnv('ARENA_INGEST_IDLE_TTL_MS', 3 * 60_000),
    concurrency: numberFromEnv('ARENA_INGEST_CONCURRENCY', 3),
  };
}

const MANIFEST_TIMEOUT_MS = 8_000;
const SEGMENT_TIMEOUT_MS = 20_000;
const ACCEPT = 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseStamp(raw: string | string[] | undefined): number | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const stamp = Date.parse(value);
  return Number.isNaN(stamp) ? null : stamp;
}

/** Reads the upstream playlist, trying every referer the host expects. */
async function readManifest(
  manifestUrl: string,
  referers: readonly string[],
): Promise<{ body: string; url: string } | null> {
  for (const referer of referers) {
    const headers: Record<string, string> = { accept: ACCEPT };
    if (referer) headers.referer = referer;
    try {
      const response = await upstreamText(manifestUrl, { headers, timeoutMs: MANIFEST_TIMEOUT_MS });
      if (response.status >= 200 && response.status < 300) {
        return { body: response.body, url: manifestUrl };
      }
      if (response.status !== 403 && response.status !== 405) return null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Fetches one segment into the cache. */
async function fetchSegment(
  channel: MediaChannel,
  segment: PlaylistSegment,
  referer: string,
): Promise<HeldSegment | null> {
  const headers: Record<string, string> = {};
  if (referer) headers.referer = referer;
  try {
    const response = await upstreamBuffer(segment.uri, {
      headers,
      timeoutMs: SEGMENT_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) return null;
    if (response.body.length === 0) return null;
    // The provider answers a feed it has no video for with a placeholder
    // picture. Publishing that as a segment would put a still image where the
    // video should be, so it is dropped here - the feed simply has no media
    // yet, and the app keeps looking.
    if (!looksLikeMedia(response.body)) return null;
    await writeSegment(channel.id, segment.name, response.body);
    return {
      name: segment.name,
      sequence: segment.sequence,
      duration: segment.duration,
      uri: segment.uri,
      publishedAtMs: parseStamp(response.headers['last-modified']),
      programDateTime: segment.programDateTime,
      bytes: response.body.length,
    };
  } catch {
    return null;
  }
}

/** Fetches the initialisation segment of an fMP4 feed. */
async function fetchInit(
  channel: MediaChannel,
  uri: string,
  referer: string,
): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (referer) headers.referer = referer;
  try {
    const response = await upstreamBuffer(uri, { headers, timeoutMs: SEGMENT_TIMEOUT_MS });
    if (response.status < 200 || response.status >= 300) return null;
    const name = 'init';
    await writeSegment(channel.id, name, response.body);
    return name;
  } catch {
    return null;
  }
}

/** Fetches the encryption key of a protected feed. */
async function fetchKey(
  channel: MediaChannel,
  uri: string,
  referer: string,
): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (referer) headers.referer = referer;
  try {
    const response = await upstreamBuffer(uri, { headers, timeoutMs: SEGMENT_TIMEOUT_MS });
    if (response.status < 200 || response.status >= 300) return null;
    const name = 'key';
    await writeSegment(channel.id, name, response.body);
    return name;
  } catch {
    return null;
  }
}

/** Runs a few tasks at a time, in order. */
async function withLimit<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index] as T;
      try {
        await worker(item);
      } catch {
        // A failed fetch is not fatal - the next cycle tries again.
      }
    }
  });
  await Promise.all(runners);
}

/**
 * One cycle: read the upstream playlist, fetch what is new, publish what is
 * held.
 */
export async function ingestOnce(channel: MediaChannel): Promise<void> {
  const settings = ingestSettings();

  let upstream = channel.upstreams[channel.upstreamIndex];
  if (!upstream) {
    upstream = (await refreshUpstream(channel)) ?? undefined;
    if (!upstream) {
      channel.state = 'error';
      channel.lastError = 'no upstream to read';
      return;
    }
  }

  const started = Date.now();
  const manifest = await readManifest(upstream.manifestUrl, upstream.referers);
  if (!manifest) {
    channel.failures += 1;
    channel.lastError = 'the upstream did not answer';
    // A rotating token is the usual reason: ask for a fresh URL before
    // blaming the feed.
    if (channel.failures >= 3) {
      const refreshed = await refreshUpstream(channel);
      if (refreshed) {
        channel.failures = 0;
      } else if (!rotateUpstream(channel)) {
        channel.state = 'error';
      } else {
        channel.failures = 0;
      }
    }
    return;
  }

  channel.failures = 0;
  channel.lastError = null;
  channel.latencyMs = Date.now() - started;
  channel.lastManifestAt = Date.now();

  const parsed = parsePlaylist(manifest.body, manifest.url);
  channel.mediaSequence = parsed.mediaSequence;
  channel.targetDuration = parsed.targetDuration;
  channel.keyMethod = parsed.keyMethod;
  channel.keyIv = parsed.keyIv;

  // What the upstream has announced. The player may ask for a segment the
  // server has not fetched yet - it is announced a moment before its file is
  // really there - and the server fetches it on the spot rather than
  // answering with a hole.
  channel.announced.clear();
  for (const segment of parsed.segments) {
    channel.announced.set(segment.name, segment.uri);
  }

  const referer = upstream.referers[0] ?? '';

  // The initialisation segment and the key are fetched once and then kept.
  if (parsed.initUri && !channel.initName) {
    const name = await fetchInit(channel, parsed.initUri, referer);
    if (name) {
      channel.initName = name;
      channel.initUri = parsed.initUri;
    }
  }
  if (parsed.keyUri && !channel.keyName) {
    const name = await fetchKey(channel, parsed.keyUri, referer);
    if (name) {
      channel.keyName = name;
      channel.keyUri = parsed.keyUri;
    }
  }

  // What to fetch.
  //
  // The newest segments of the upstream playlist - the ones the player is
  // waiting for. The server keeps them on disk and publishes the newest run
  // it holds, so the published window follows the live edge.
  //
  // Only the newest few are fetched per cycle: the upstream lists a segment
  // before its file is really there, so the newest one often cannot be
  // downloaded yet. Chasing the whole upstream window every cycle would
  // spend the whole cycle on segments that are about to fall out of the
  // window anyway.
  const wanted = parsed.segments.slice(-settings.prefetchDepth).reverse();
  const missing = wanted.filter((segment) => !channel.segments.has(segment.name));

  if (missing.length > 0) {
    await withLimit(missing, settings.concurrency, async (segment) => {
      const held = await fetchSegment(channel, segment, referer);
      if (held) holdSegment(channel, held);
    });
  }

  if (process.env.ARENA_MEDIA_DEBUG === '1') {
    console.log(
      `[personal-server] ${channel.id}: floor ${channel.publishFloor} held ${[...channel.segments.values()]
        .map((segment) => segment.sequence)
        .sort((a, b) => a - b)
        .join(',')} missing ${missing.length}`,
    );
  }

  // The live edge of the feed, as the server sees it.
  const newest = channel.order
    .map((name) => channel.segments.get(name))
    .filter((segment): segment is HeldSegment => Boolean(segment))
    .sort((a, b) => a.sequence - b.sequence)
    .at(-1);
  if (newest?.publishedAtMs) {
    channel.edgeAgeSeconds = Math.max(0, (Date.now() - newest.publishedAtMs) / 1_000);
  } else if (Number.isFinite(channel.measuredAgeSeconds)) {
    channel.edgeAgeSeconds = channel.measuredAgeSeconds;
  }

  channel.state = channel.segments.size >= 2 ? 'ready' : 'warming';

  // Only the newest segments are kept on disk.
  const kept = channel.order
    .map((name) => channel.segments.get(name))
    .filter((segment): segment is HeldSegment => Boolean(segment))
    .sort((a, b) => b.sequence - a.sequence)
    .slice(0, settings.keepSegments);
  const keep = kept.map((segment) => segment.name);
  forgetSegments(channel, keep);
  await pruneChannel(channel.id, keep);

  // The floor follows the window the player is shown, so it is fresh even
  // when nobody is asking for a playlist at the moment.
  publishableWindow(channel);
}

const LOOPS_KEY = '__arena_personal_ingest_loops__';

interface Loop {
  stop: () => void;
}

function loops(): Map<string, Loop> {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[LOOPS_KEY];
  if (existing instanceof Map) return existing as Map<string, Loop>;
  const created = new Map<string, Loop>();
  store[LOOPS_KEY] = created;
  return created;
}

/** Starts fetching a channel, if it is not already fetching. */
export function ensureIngest(channel: MediaChannel): void {
  if (channel.ingesting) return;
  channel.ingesting = true;
  const running = loops();

  let stopped = false;
  const stop = () => {
    stopped = true;
    channel.ingesting = false;
  };
  running.set(channel.id, { stop });

  void (async () => {
    const settings = ingestSettings();

    // The cache of an earlier run of the app is not this run's cache: the
    // directories of runs that are long gone are removed, and the channel's
    // own directory is emptied before the first segment is written into it.
    void pruneOldRuns();
    if (!channel.purged) {
      try {
        await purgeChannel(channel.id);
      } catch {
        // The directory could not be emptied - the fetch continues anyway,
        // and every segment is written over what was there.
      }
      channel.purged = true;
    }

    while (!stopped) {
      // Nobody asked for this channel for a while: stop pulling a feed that
      // nobody is watching. The next request starts it again.
      if (Date.now() - channel.lastRequestAt > settings.idleTtlMs) {
        channel.state = channel.segments.size > 0 ? 'ready' : 'warming';
        break;
      }
      try {
        await ingestOnce(channel);
      } catch (error) {
        channel.lastError = errorMessage(error);
      }
      if (stopped) break;
      await sleep(settings.pollMs);
    }
    channel.ingesting = false;
    running.delete(channel.id);
  })();
}

/** Stops fetching a channel. */
export function stopIngest(channelId: string): void {
  const loop = loops().get(channelId);
  if (!loop) return;
  loop.stop();
  loops().delete(channelId);
}

/**
 * Throws away everything a match was hosting.
 *
 * The source of a match changed: the segments on the disk belong to the old
 * source and must never be served as if they belonged to the new one. The
 * channel is stopped, forgotten and emptied - the next request builds it
 * again, from the source that is in force now.
 */
export async function resetStream(streamKey: string): Promise<void> {
  for (const channel of channelsForStream(streamKey)) {
    stopIngest(channel.id);
    forgetChannel(channel.id);
    try {
      await purgeChannel(channel.id);
    } catch {
      // The directory could not be emptied - it is emptied again when the
      // channel is built anew.
    }
  }
}

/** True while the channel is being fetched. */
export function isIngesting(channelId: string): boolean {
  return loops().has(channelId);
}
