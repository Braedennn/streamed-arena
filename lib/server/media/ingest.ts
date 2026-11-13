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
import {
  bestVariant,
  parsePlaylist,
  parseVariants,
  withSegmentNames,
  withSequenceBase,
  type HeldSegment,
  type PlaylistSegment,
} from '@/lib/server/media/playlist';
import { pruneChannel, pruneOldRuns, purgeChannel, writeSegment } from '@/lib/server/media/cache';
import {
  allChannels,
  channelsForStream,
  currentUpstream,
  forgetChannel,
  forgetSegments,
  holdSegment,
  publishableWindow,
  type MediaChannel,
} from '@/lib/server/media/channels';
import { refreshUpstream, rescueMatch, rotateUpstream } from '@/lib/server/media/upstream';
import { looksLikeMedia, unwrapMedia } from '@/lib/server/media/format';
import { advertisementReason } from '@/lib/server/media/ad';

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
    // How many segments are fetched ahead of the player. The player sits
    // about ten segments behind the edge, so the server keeps a reserve in
    // front of it: a segment that is missing while the player wants it is a
    // stall.
    prefetchDepth: numberFromEnv('ARENA_INGEST_PREFETCH', 8),
    // More than the published window: the reserve keeps the buffer alive
    // while a single segment is missing.
    keepSegments: numberFromEnv('ARENA_INGEST_KEEP', 28),
    idleTtlMs: numberFromEnv('ARENA_INGEST_IDLE_TTL_MS', 3 * 60_000),
    concurrency: numberFromEnv('ARENA_INGEST_CONCURRENCY', 3),
  };
}

const MANIFEST_TIMEOUT_MS = 8_000;
const SEGMENT_TIMEOUT_MS = 20_000;
const ACCEPT = 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*';

/**
 * How long a feed may bring nothing new before the app gives up on it.
 *
 * A live feed publishes a segment every few seconds. A feed that answers
 * but brings nothing for half a minute is a feed that has stopped - the
 * door is serving a stream that is over, or one that is stuck. The app does
 * not wait for the player to notice: it moves to the next feed of the match
 * by itself.
 */
const STALL_MS = 30_000;

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

/**
 * How many times a door is asked before the cycle gives up on it.
 *
 * Some of the provider's doors answer 200, 403 and nothing at all from one
 * moment to the next, because the request lands on one of several edges and
 * only some of them know the address. Asking again is what turns a refused
 * feed into a playing one.
 */
const DOOR_ATTEMPTS = 3;
const DOOR_PAUSE_MS = 350;

/** Reads the upstream playlist, trying every referer the host expects. */
async function readManifest(
  manifestUrl: string,
  referers: readonly string[],
): Promise<{ body: string; url: string } | null> {
  for (const referer of referers) {
    const headers: Record<string, string> = { accept: ACCEPT };
    if (referer) headers.referer = referer;
    for (let attempt = 1; attempt <= DOOR_ATTEMPTS; attempt += 1) {
      try {
        const response = await upstreamText(manifestUrl, { headers, timeoutMs: MANIFEST_TIMEOUT_MS });
        if (response.status >= 200 && response.status < 300) {
          // The address a playlist is read from is not always the address
          // that was asked for: the browser reads it from the door's own
          // book of addresses, and the answer says which one answered. The
          // addresses inside the playlist are relative to that one, so it is
          // the base they are read against.
          const source = response.headers['x-arena-source'];
          return {
            body: response.body,
            url: typeof source === 'string' && source ? source : manifestUrl,
          };
        }
        // The door says no: the next edge may say yes.
        if (response.status !== 403 && response.status !== 405) return null;
      } catch {
        // A door that did not answer at all is asked again.
      }
      if (attempt < DOOR_ATTEMPTS) await sleep(DOOR_PAUSE_MS * attempt);
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
    if (response.status < 200 || response.status >= 300) {
      debugSegment(channel, segment, `the segment answered ${response.status}`);
      return null;
    }
    if (response.body.length === 0) {
      debugSegment(channel, segment, 'the segment was empty');
      return null;
    }
    // The video may be packed into something else: a provider that hands out
    // only its own player serves the match as a picture with the transport
    // stream hidden inside it. The container is opened here, so what is kept
    // and what is published is the video itself.
    const media = unwrapMedia(response.body);
    // The provider answers a feed it has no video for with a placeholder
    // picture. Publishing that as a segment would put a still image where the
    // video should be, so it is dropped here - the feed simply has no media
    // yet, and the app keeps looking.
    if (!looksLikeMedia(media)) {
      debugSegment(
        channel,
        segment,
        `the segment is not video (${media.subarray(0, 8).toString('hex')})`,
      );
      return null;
    }
    await writeSegment(channel.id, segment.name, media);
    return {
      name: segment.name,
      sequence: segment.sequence,
      duration: segment.duration,
      uri: segment.uri,
      publishedAtMs: parseStamp(response.headers['last-modified']),
      programDateTime: segment.programDateTime,
      bytes: media.length,
    };
  } catch (error) {
    debugSegment(channel, segment, `the segment could not be fetched: ${errorMessage(error)}`);
    return null;
  }
}

/** Says what went wrong with a segment, when the app is asked to be loud. */
function debugSegment(channel: MediaChannel, segment: PlaylistSegment, message: string): void {
  if (process.env.ARENA_MEDIA_DEBUG !== '1') return;
  console.log(`[personal-server] ${channel.id}: ${message} - ${segment.uri.slice(0, 120)}`);
}

/** Says what the upstream turned out to be, when the app is asked to be loud. */
function debugManifest(channel: MediaChannel, message: string): void {
  if (process.env.ARENA_MEDIA_DEBUG !== '1') return;
  console.log(`[personal-server] ${channel.id}: ${message}`);
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

  // The door the channel is reading. The doors that are known to be dead are
  // skipped: the app remembers them, so it does not spend the time of asking
  // a door that stopped answering while another one is still there.
  let upstream = currentUpstream(channel);
  if (!upstream) {
    // Every door the app knew is dead. The match is looked up again - the
    // providers are asked for their feeds, the pages are opened again - and
    // the addresses that are fresh now are given to the channel.
    upstream = await rescueMatch(channel);
    if (!upstream) {
      channel.state = 'error';
      channel.lastError = 'no feed to read';
      return;
    }
  }

  const started = Date.now();
  // The channel follows the feed it is reading: the name and the quality in
  // the server list move with it when the app moves to another door.
  if (upstream.quality) channel.quality = upstream.quality;
  if (upstream.providerLabel) channel.sourceLabel = upstream.providerLabel;
  if (upstream.label) channel.feedLabel = upstream.label;

  // The quality that was opened last time is read directly: the list of
  // qualities does not change from one cycle to the next.
  let manifest = channel.mediaUri
    ? await readManifest(channel.mediaUri, upstream.referers)
    : null;
  if (!manifest) {
    channel.mediaUri = null;
    manifest = await readManifest(upstream.manifestUrl, upstream.referers);
  }
  if (!manifest) {
    channel.failures += 1;
    channel.lastError = 'the upstream did not answer';
    // A rotating token is the usual reason: ask for a fresh URL before
    // blaming the feed.
    if (channel.failures >= 3) {
      const refreshed = await refreshUpstream(channel, upstream);
      if (refreshed) {
        channel.failures = 0;
      } else if (!rotateUpstream(channel)) {
        // Nothing left to try: the match is looked up again on the next
        // cycle, and the doors that are fresh then are the ones it finds.
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
  if (!channel.readingSince) channel.readingSince = Date.now();

  let parsed = parsePlaylist(manifest.body, manifest.url);

  // A master playlist is a list of qualities, not a stream. The app opens
  // the best one and hosts that - and remembers it, so the list is read once
  // and not on every cycle.
  if (parsed.isMaster) {
    const variant = bestVariant(parseVariants(manifest.body, manifest.url));
    if (variant) {
      const opened = await readManifest(variant.uri, upstream.referers);
      if (!opened) {
        channel.state = 'error';
        channel.lastError = 'the quality did not answer';
        return;
      }
      channel.mediaUri = variant.uri;
      manifest = opened;
      parsed = parsePlaylist(manifest.body, manifest.url);
    }
  }

  /*
   * The app's own numbering.
   *
   * The upstream numbers its segments in its own space, and two feeds of one
   * match do not share that space. The app moves every feed it reads into
   * one line of its own: the first segment of a new feed continues after
   * the last segment the app held of the old one. The player then sees a cut
   * when the app moves to another feed - not a jump, and not a re-buffer.
   */
  const isNewAddress = channel.baseGeneration !== channel.generation;
  if (isNewAddress) {
    channel.sequenceBase = channel.lastAppSequence + 1 - parsed.mediaSequence;
    channel.baseGeneration = channel.generation;
  }
  parsed = withSequenceBase(parsed, channel.sequenceBase);
  // The names carry the app's own number and the generation the segments
  // came from: two feeds of one match must never be mistaken for one
  // another, and the same feed with a fresh token is a new address as well.
  parsed = withSegmentNames(parsed, channel.generation);

  /*
   * The header of the feed.
   *
   * The initialisation segment and the key belong to the address they came
   * from, so they are fetched again. When the new feed is packed the same
   * way, the segments of the old feed still play with them. When it is not -
   * one is a plain transport stream and the other is a fragmented one, or
   * one is encrypted and the other is not - the old segments are dropped:
   * they would be decoded with the wrong header, and a wrong picture is
   * worse than a cut.
   */
  if (isNewAddress) {
    const sameShape =
      Boolean(parsed.initUri) === Boolean(channel.initUri) &&
      (parsed.keyMethod ?? '') === (channel.keyMethod ?? '');
    channel.initName = null;
    channel.keyName = null;
    if (!sameShape) {
      channel.segments.clear();
      channel.order.length = 0;
      channel.announced.clear();
      channel.initUri = null;
      channel.keyUri = null;
      channel.keyMethod = null;
      channel.keyIv = null;
      channel.publishFloor = -1;
      channel.floorSetAt = 0;
    }
  }

  channel.mediaSequence = parsed.mediaSequence;
  channel.targetDuration = parsed.targetDuration;
  channel.keyMethod = parsed.keyMethod;
  channel.keyIv = parsed.keyIv;

  /*
   * A feed that has quietly fallen minutes behind the live edge.
   *
   * Some doors bind a stream to the session that opened it: the playlist
   * keeps advancing, but its content is a replay from the moment the session
   * began - the picture plays smoothly and drifts further and further behind
   * the game. The stamps tell it apart: a live feed's newest segment is
   * seconds old, and a drifted one's is minutes old. When the drift passes a
   * few minutes, the page is opened again - once, twice at most - and the
   * feed jumps back to the edge. With the app's own numbering, that jump
   * costs the player nothing.
   */
  const newestStamp = parsed.segments.reduce<string | null>((latest, segment) => {
    if (!segment.programDateTime) return latest;
    if (!latest || segment.programDateTime > latest) return segment.programDateTime;
    return latest;
  }, null);
  if (newestStamp) {
    const stamp = Date.parse(newestStamp);
    if (!Number.isNaN(stamp)) {
      const driftMs = Date.now() - stamp - (parsed.targetDuration || 6) * 1000;
      if (driftMs > 5 * 60_000 && channel.driftRefreshes < 2) {
        channel.driftRefreshes += 1;
        channel.mediaUri = null;
        channel.failures = 3; // the refresh path asks for a fresh address
        await refreshUpstream(channel, upstream);
        channel.failures = 0;
        return;
      }
    }
  }

  // What the upstream actually is.
  //
  // A provider that asks for something answers with an advertisement, and the
  // advertisement is a real video: the playlist is fine, the segments
  // download, the bytes are a valid MPEG-TS stream - it just is not the
  // match. A recording of a game that is over looks the same way.
  //
  // Neither is published. The door is remembered as something else, and the
  // server moves on to the next one it knows - the free channels of the
  // network that carries the game, most of the time, and the user keeps
  // watching the match instead of an advert for an API.
  const advert = advertisementReason(manifest.body, manifest.url);
  if (advert) {
    debugManifest(channel, advert);
    channel.rejected.add(upstream.serverId);
    channel.lastError = advert;
    channel.failures += 1;
    channel.mediaUri = null;
    if (rotateUpstream(channel)) {
      channel.failures = 0;
    } else {
      channel.state = 'error';
    }
    return;
  }

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
  // Only the newest few are fetched per cycle, oldest first: the oldest
  // missing segment is the one the player will need next, and the newest one
  // is often not downloadable yet - chasing it first would spend the fetch
  // slots on segments the player is not asking for.
  const wanted = parsed.segments.slice(-settings.prefetchDepth);
  const missing = wanted.filter((segment) => !channel.segments.has(segment.name));

  if (missing.length > 0) {
    await withLimit(missing, settings.concurrency, async (segment) => {
      const held = await fetchSegment(channel, segment, referer);
      if (held) holdSegment(channel, held);
    });
  }

  /*
   * A feed that answers but brings nothing new.
   *
   * The playlist keeps coming and the segments keep failing: the door is
   * serving a stream that has stopped, and the player would sit on a frozen
   * picture until it gave up. The app does not wait for that - it moves to
   * the next feed of the match by itself, and the player keeps its address:
   * the feed changes behind the playlist, not in it.
   */
  const since = channel.lastSegmentAt || channel.readingSince;
  if (since > 0 && Date.now() - since > STALL_MS) {
    debugManifest(channel, 'the feed brought nothing new - moving to the next one');
    channel.lastError = 'the feed stopped';
    if (rotateUpstream(channel)) {
      channel.failures = 0;
    } else {
      // Nothing left to try: the match is looked up again on the next cycle.
      channel.state = 'error';
    }
    return;
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

/**
 * Throws away everything the app was hosting.
 *
 * The way the app reaches the media changed - the app is on its own now, or
 * it is not. The segments on the disk belong to the old way and must never
 * be served as if they belonged to the new one, so every channel is stopped,
 * forgotten and emptied. The next request builds them again, from the source
 * that is in force now.
 */
export async function resetAllStreams(): Promise<void> {
  for (const channel of allChannels()) {
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
