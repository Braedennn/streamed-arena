// The personal servers the app runs.
//
// A "channel" is one feed the app's own server is hosting: a source slot at
// a quality. The channel is the thing the player talks to - it is the app
// that serves the playlist and the media, and the upstream behind it is the
// app's business, not the player's.
//
// The registry lives on `globalThis` on purpose: Next.js bundles every route
// separately, and a module-level map would give each route its own copy of
// the registry - which would mean a channel that one route ingests is
// invisible to the route that serves it.

import type { HeldSegment } from '@/lib/server/media/playlist';

export type ChannelState = 'warming' | 'ready' | 'error';

/** One way of reaching the media behind a channel. */
export interface ChannelUpstream {
  /** The server the app resolved it: "<slot>-<quality>-<backend>". */
  readonly serverId: string;
  /** The upstream playlist, token included. */
  readonly manifestUrl: string;
  /** The referers to try, best first. */
  readonly referers: readonly string[];
  /** A user-configured source, when the app is not reading a third party. */
  readonly personal: boolean;
  /**
   * A feed the app took from the broadcaster's own pages.
   *
   * Such a feed is found again when it has to be: the broadcaster's address
   * changes, and the app reads the new one instead of giving up.
   */
  readonly direct?: boolean;
  /**
   * An address that does not change.
   *
   * The free channels are addressed by their own playlist, and that address
   * stays the same - so the app does not resolve it again, it just uses it.
   */
  readonly fixed?: boolean;
  /**
   * The provider API this feed came from.
   *
   * The address of a provider's feed carries a token, and the token expires.
   * The provider is asked for the match again when the feed stops answering,
   * and the new address is used from then on.
   */
  readonly provider?: {
    readonly providerId: string;
    readonly eventId: string;
    readonly quality: string;
    /**
     * The page the address came from, when it came from one.
     *
     * A provider that publishes only its own player gives the app a page
     * and nothing else. The page is opened to find the address, and the
     * address carries a token that expires - so when the feed stops
     * answering, the page is opened again. The page is named here so that
     * the server knows which one to open.
     */
    readonly embedUrl?: string;
  };
}

export interface MediaChannel {
  readonly id: string;
  readonly streamKey: string;
  readonly slot: string;
  /** The quality the feed was measured at; it changes when the feed does. */
  quality: string;
  /** The name of the service the feed came from, for the server list. */
  sourceLabel: string;
  /** The ways to reach the media, best first. */
  upstreams: ChannelUpstream[];
  /**
   * The media playlist actually being read.
   *
   * A broadcaster's address is often a list of qualities rather than a
   * stream. The app opens the quality it hosts and remembers it here, so the
   * list is read once and not on every cycle.
   */
  mediaUri: string | null;
  state: ChannelState;
  mediaSequence: number;
  targetDuration: number;
  /** The cached initialisation segment, when the feed uses one. */
  initName: string | null;
  initUri: string | null;
  /** The cached encryption key, when the feed uses one. */
  keyName: string | null;
  keyUri: string | null;
  keyMethod: string | null;
  keyIv: string | null;
  /** The segments the server holds, by name. */
  readonly segments: Map<string, HeldSegment>;
  /** The names of the held segments, oldest first. */
  order: string[];
  /** How far behind the live edge the newest held segment is. */
  edgeAgeSeconds: number;
  /** What the probe measured before the server started fetching. */
  measuredAgeSeconds: number;
  /** How long the upstream took to answer, in milliseconds. */
  latencyMs: number;
  lastError: string | null;
  lastManifestAt: number;
  /** How many times in a row the upstream did not answer. */
  failures: number;
  /**
   * The media sequence of the oldest segment the server has published.
   *
   * The window only ever moves forward: a live playlist that goes backwards
   * makes the player seek back with it, which is the picture jumping
   * backwards. Segments older than the floor are cached but never published.
   */
  publishFloor: number;
  /** When the floor was set - used to recover from a gap in the upstream. */
  floorSetAt: number;
  /**
   * The sequence numbers the app publishes under, by segment name.
   *
   * The player's continuity is the published MEDIA-SEQUENCE: if it jumps,
   * the player throws its buffer away and re-buffers from nothing. The
   * upstream's own sequence jumps whenever its token is refreshed - so the
   * app numbers the segments it publishes with a counter of its own, and an
   * upstream jump becomes a clean cut instead of a re-buffer.
   */
  readonly publishedAs: Map<string, number>;
  /** The next app-side sequence number to hand out. */
  nextPublishSequence: number;
  /** How many times a drifted feed has been re-resolved to the live edge. */
  driftRefreshes: number;
  /** When a client last asked this channel for something. */
  lastRequestAt: number;
  bytesServed: number;
  /**
   * The segments the upstream has announced, by name, with their upstream
   * URI.
   *
   * A segment is announced before its file is really there, and it can be
   * announced a moment before the server has fetched it. The player must
   * never be told about a segment the server cannot serve - but when the
   * player asks for one anyway, the server fetches it on the spot rather
   * than answering with a hole.
   */
  readonly announced: Map<string, string>;
  /** True while the fetch loop is running. */
  ingesting: boolean;
  /**
   * True once the channel's directory was emptied.
   *
   * A channel starts with an empty window, so the directory it writes into is
   * emptied first: what the server serves is always what it has just
   * fetched, never what a previous run of the app left behind.
   */
  purged: boolean;
  /** The upstream index currently in use. */
  upstreamIndex: number;
  /**
   * The upstreams that turned out to be something else.
   *
   * A door that answers with an advertisement, or with a recording of a game
   * that is over, is not a door that gets better by trying again: it is
   * remembered here so the server moves on to the next one instead of
   * serving the advert a second time.
   */
  readonly rejected: Set<string>;
}

const REGISTRY_KEY = '__arena_personal_servers__';

type Registry = Map<string, MediaChannel>;

function registry(): Registry {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[REGISTRY_KEY];
  if (existing instanceof Map) return existing as Registry;
  const created: Registry = new Map();
  store[REGISTRY_KEY] = created;
  return created;
}

/**
 * A match's key, in a form a channel name can hold.
 *
 * Most keys are plain. A provider that publishes its matches under names like
 * "cfb/2026-11-07/byu-utah" has a key a channel name cannot hold - so that
 * key is written in hexadecimal behind a marker, and read back when the
 * channel is rebuilt after a restart.
 */
function encodeStreamKey(streamKey: string): string {
  if (/^[a-zA-Z0-9._-]+$/.test(streamKey)) return streamKey;
  return `x${Buffer.from(streamKey, 'utf8').toString('hex')}`;
}

/** The match's key, read back out of a channel name. */
function decodeStreamKey(text: string): string {
  if (!text.startsWith('x')) return text;
  const hex = text.slice(1);
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2 !== 0) return text;
  try {
    const decoded = Buffer.from(hex, 'hex').toString('utf8');
    // Only a key that really carried a character a name cannot hold is read
    // back - a plain key that happens to look like hexadecimal is left alone.
    return decoded.includes('/') ? decoded : text;
  } catch {
    return text;
  }
}

/** The name a channel is known by. */
export function channelIdFor(streamKey: string, slot: string, quality: string): string {
  return `${encodeStreamKey(streamKey)}__${slot}__${quality}`;
}

/**
 * The name a free channel is known by.
 *
 * The identity of a free channel is the channel itself, not its place in a
 * list: the list moves when the measurements move, and a channel that changes
 * its name every time the ranking moves would make the player start over. So
 * the name carries the channel's own id, and the quality is kept beside it
 * rather than in it.
 */
export function sourceChannelId(streamKey: string, sourceId: string): string {
  return `${encodeStreamKey(streamKey)}__${sourceId}__src`;
}

/** True when a channel name belongs to a free channel. */
export function isSourceChannel(id: string): boolean {
  return id.endsWith('__src');
}

/** Reads a channel name back into the match it belongs to. */
export function parseChannelId(
  id: string,
): { streamKey: string; slot: string; quality: string } | null {
  const parts = id.split('__');
  if (parts.length < 3) return null;
  const quality = parts.pop() ?? '';
  const slot = parts.pop();
  const streamKey = decodeStreamKey(parts.join('__'));
  if (!streamKey || !slot) return null;
  return { streamKey, slot, quality };
}

export function getChannel(id: string): MediaChannel | undefined {
  return registry().get(id);
}

/** The channel of a match at a quality, created when it is not there yet. */
export function ensureChannel(options: {
  streamKey: string;
  slot: string;
  quality: string;
  upstreams?: readonly ChannelUpstream[];
  /** The name of the service the feed came from, for the server list. */
  sourceLabel?: string;
  /** An explicit name - the identity of a free channel is the channel. */
  id?: string;
}): MediaChannel {
  const id = options.id ?? channelIdFor(options.streamKey, options.slot, options.quality);
  const existing = registry().get(id);
  if (existing) {
    if (options.upstreams && options.upstreams.length > 0) {
      existing.upstreams.splice(0, existing.upstreams.length, ...options.upstreams);
      existing.upstreamIndex = 0;
      // The ways to the media have just been resolved again: what was known
      // about the old ones does not apply to the new ones.
      existing.rejected.clear();
    }
    if (options.quality) existing.quality = options.quality;
    if (options.sourceLabel) existing.sourceLabel = options.sourceLabel;
    return existing;
  }

  const channel: MediaChannel = {
    id,
    streamKey: options.streamKey,
    slot: options.slot,
    quality: options.quality,
    sourceLabel: options.sourceLabel ?? '',
    upstreams: options.upstreams ? [...options.upstreams] : [],
    mediaUri: null,
    state: 'warming',
    mediaSequence: 0,
    targetDuration: 0,
    initName: null,
    initUri: null,
    keyName: null,
    keyUri: null,
    keyMethod: null,
    keyIv: null,
    segments: new Map(),
    order: [],
    edgeAgeSeconds: Number.NaN,
    measuredAgeSeconds: Number.NaN,
    latencyMs: 0,
    lastError: null,
    lastManifestAt: 0,
    failures: 0,
    publishFloor: -1,
    floorSetAt: 0,
    publishedAs: new Map(),
    nextPublishSequence: 0,
    driftRefreshes: 0,
    lastRequestAt: Date.now(),
    bytesServed: 0,
    announced: new Map(),
    ingesting: false,
    purged: false,
    upstreamIndex: 0,
    rejected: new Set<string>(),
  };
  registry().set(id, channel);
  return channel;
}

/** Every channel the app is hosting for a match. */
export function channelsForStream(streamKey: string): MediaChannel[] {
  return [...registry().values()].filter((channel) => channel.streamKey === streamKey);
}

/** Every channel the app is hosting. */
export function allChannels(): MediaChannel[] {
  return [...registry().values()];
}

/** Records that a client asked for something - the channel stays alive. */
export function touchChannel(id: string): void {
  const channel = registry().get(id);
  if (channel) channel.lastRequestAt = Date.now();
}

/** Forgets a channel and everything it cached. */
export function forgetChannel(id: string): void {
  registry().delete(id);
}

/**
 * The segments the server holds, oldest first.
 *
 * Only the segments that are really cached are listed: the player must never
 * be told about a segment the server has not fetched yet.
 */
export function heldSegments(channel: MediaChannel): HeldSegment[] {
  const held: HeldSegment[] = [];
  for (const name of channel.order) {
    const segment = channel.segments.get(name);
    if (segment) held.push(segment);
  }
  return held;
}

/** Adds a segment to the channel and keeps the order right. */
export function holdSegment(channel: MediaChannel, segment: HeldSegment): void {
  if (!channel.segments.has(segment.name)) {
    channel.order.push(segment.name);
    channel.order.sort((a, b) => {
      const left = channel.segments.get(a)?.sequence ?? 0;
      const right = channel.segments.get(b)?.sequence ?? 0;
      return left - right;
    });
  }
  channel.segments.set(segment.name, segment);
}

/** Forgets the segments that fell out of the window. */
export function forgetSegments(channel: MediaChannel, keep: readonly string[]): void {
  const wanted = new Set(keep);
  for (const name of [...channel.order]) {
    if (wanted.has(name)) continue;
    channel.order = channel.order.filter((entry) => entry !== name);
    channel.segments.delete(name);
  }
}

/** How many segments the server publishes at most.
 *
 * The published window is the player's entire world: a player that wants a
 * deep buffer can only ever buffer what this window lists. Eight segments
 * left the player about two segments of cushion, and every hiccup upstream
 * drained them into a stall. Twenty segments (about two minutes) is the
 * reserve the player lives on: it starts a minute behind the edge, fills
 * its buffer from the window, and rides out whatever the upstream does.
 */
export const MAX_PUBLISHED_SEGMENTS = 20;

/**
 * How many segments the server wants before it answers a playlist.
 *
 * One segment is not enough to play: the player would ask for the next one
 * before the server had it, and the picture would stutter on every boundary.
 */
export const MIN_PUBLISHED_SEGMENTS = 3;

/** How long a gap in the upstream is tolerated before the window restarts. */
const GAP_RESET_MS = 12_000;

/** The longest run of segments that sits next to itself in the stream. */
function longestRun(held: readonly HeldSegment[]): HeldSegment[] {
  let best: HeldSegment[] = [];
  let current: HeldSegment[] = [];
  for (let index = 0; index < held.length; index++) {
    const segment = held[index];
    const previous = held[index - 1];
    if (!segment) continue;
    if (previous && segment.sequence !== previous.sequence + 1) current = [];
    current.push(segment);
    if (current.length > best.length) best = [...current];
  }
  return best;
}

/**
 * The window the server publishes.
 *
 * The window is the newest run of segments the server holds, without a hole
 * in it. A player that is told about a segment that does not exist waits for
 * it - and waiting is exactly what this server exists to prevent - so a hole
 * is never published: the window starts after it.
 *
 * The window ends at the newest segment the server has. That is the live edge
 * the server can serve, and the window follows it.
 *
 * The window only moves forward. A live playlist that goes backwards makes
 * the player seek back with it - that is the picture jumping backwards.
 *
 * Each segment comes back with the app's own sequence number for it: the
 * number the player tracks the window by, continuous even when the upstream
 * behind it jumps.
 */
export interface PublishedSegment {
  readonly segment: HeldSegment;
  readonly appSequence: number;
}

export function publishableWindow(channel: MediaChannel): PublishedSegment[] {
  const held = [...channel.segments.values()].sort((a, b) => a.sequence - b.sequence);
  if (held.length === 0) {
    // Nothing at all came in - the floor is released so the server can start
    // the window again from whatever arrives next.
    if (channel.publishFloor >= 0 && Date.now() - channel.floorSetAt > GAP_RESET_MS) {
      channel.publishFloor = -1;
      channel.floorSetAt = 0;
    }
    return [];
  }

  const newest = held[held.length - 1];
  if (!newest) return [];

  // The run of segments that ends at the newest one: the live edge, with no
  // hole in it. A segment that is missing in the middle ends the run.
  let runStart = newest.sequence;
  for (let index = held.length - 2; index >= 0; index--) {
    const segment = held[index];
    const next = held[index + 1];
    if (!segment || !next) continue;
    if (segment.sequence !== next.sequence - 1) break;
    runStart = segment.sequence;
  }

  const bySequence = new Map(held.map((segment) => [segment.sequence, segment]));

  // The window starts at the floor - or at the run, when the floor points at a
  // segment the server has already thrown away. Never before the floor: the
  // window only moves forward.
  let start = Math.max(channel.publishFloor, runStart);
  if (!bySequence.has(start) || start > newest.sequence) start = runStart;

  const window: HeldSegment[] = [];
  for (let sequence = start; bySequence.has(sequence); sequence++) {
    const segment = bySequence.get(sequence);
    if (!segment) break;
    window.push(segment);
  }

  // The segments do not arrive in the order they are played: the newest one
  // is the one the upstream announces first, and it is often not downloadable
  // yet. A window of one segment cannot be played, so the longest run the
  // server holds is used instead - the window catches up with the live edge
  // as soon as the missing segment is there.
  if (window.length < MIN_PUBLISHED_SEGMENTS) {
    const longest = longestRun(held);
    if (longest.length > window.length) {
      const longestStart = longest[0]?.sequence ?? start;
      if (longestStart >= channel.publishFloor) {
        window.length = 0;
        window.push(...longest);
        start = longestStart;
      }
    }
  }

  // The newest segments of the run: the player is closest to the action, and
  // the window slides with them.
  while (window.length > MAX_PUBLISHED_SEGMENTS) {
    const dropped = window.shift();
    if (!dropped) break;
    start = dropped.sequence + 1;
  }

  if (window.length === 0) return [];

  // The app's own sequence numbers, handed out in publish order.
  //
  // A segment keeps its number for as long as the app knows it, so a
  // playlist never renumbers what it has already shown; a segment the app
  // has never published gets the next number in line. When the upstream
  // jumps - a refreshed token, a re-opened page - the new segments simply
  // continue the count, and the player sees a cut where it would have seen
  // a re-buffer.
  const published: PublishedSegment[] = [];
  for (const segment of window) {
    let appSequence = channel.publishedAs.get(segment.name);
    if (appSequence === undefined) {
      appSequence = channel.nextPublishSequence;
      channel.nextPublishSequence += 1;
      channel.publishedAs.set(segment.name, appSequence);
    }
    published.push({ segment, appSequence });
  }
  // The numbers of segments the server no longer holds are forgotten with
  // them, so the map stays as small as the cache is.
  if (channel.publishedAs.size > channel.segments.size + 64) {
    for (const name of [...channel.publishedAs.keys()]) {
      if (!channel.segments.has(name)) channel.publishedAs.delete(name);
    }
  }

  // The floor follows the window: it is the first segment the player sees.
  if (start > channel.publishFloor) {
    channel.publishFloor = start;
    channel.floorSetAt = Date.now();
  }

  return published;
}

/**
 * The app's own sequence number of a held segment, when it has been published.
 */
export function publishedSequenceOf(channel: MediaChannel, name: string): number | undefined {
  return channel.publishedAs.get(name);
}
