// Playlist handling for the personal server.
//
// The app is the provider: it takes the upstream playlist apart, keeps the
// segments it has already fetched and publishes a playlist of its own. The
// player only ever sees this app's own URLs - a third-party host is never
// named to it, and the media bytes always travel through the app's server.
//
// Two things are deliberately *not* done here:
//
//   - the segments are not marked as discontinuities. The upstream cuts them
//     from a running stream and stamps them with their real timestamps, and
//     hls.js closes the small gaps between them by itself. Marking them as
//     discontinuities turns that off and the picture hitches at every
//     boundary.
//   - the playlist is never allowed to go backwards. The upstream's live edge
//     wobbles now and then, and a player that is handed an older playlist
//     seeks back with it - which is the picture jumping backwards. The
//     personal server publishes what it has, in order, and nothing older.

export interface PlaylistSegment {
  /** Absolute upstream URI of the segment. */
  readonly uri: string;
  /** The name the segment is cached under. */
  readonly name: string;
  /** Segment duration in seconds, as the upstream states it. */
  readonly duration: number;
  /** Position of the segment in the stream. */
  readonly sequence: number;
  /** Wall-clock stamp, when the upstream publishes one. */
  readonly programDateTime: string | null;
}

export interface ParsedPlaylist {
  readonly mediaSequence: number;
  readonly targetDuration: number;
  readonly segments: readonly PlaylistSegment[];
  /** The initialisation segment (fMP4), when the upstream uses one. */
  readonly initUri: string | null;
  /** The encryption key, when the upstream uses one. */
  readonly keyUri: string | null;
  readonly keyMethod: string | null;
  readonly keyIv: string | null;
  /** True when the playlist is a list of qualities rather than a stream. */
  readonly isMaster: boolean;
}

/** A segment the personal server holds. */
export interface HeldSegment {
  readonly name: string;
  /**
   * The app's own number for the segment.
   *
   * The upstream numbers its segments in its own space, and two feeds of one
   * match do not share that space. The app moves every feed it reads into
   * one line of its own, so the segments of the feed before and the feed
   * after a switch sit next to each other - and the player sees a cut
   * instead of a jump.
   */
  readonly sequence: number;
  readonly duration: number;
  /** The upstream URI the segment came from. */
  readonly uri: string;
  /** When the upstream says the segment was produced (Last-Modified). */
  readonly publishedAtMs: number | null;
  readonly programDateTime: string | null;
  readonly bytes: number;
}

/**
 * Moves a playlist into the app's own numbering.
 *
 * The offset is what makes the switch between two feeds of one match a cut
 * and not a jump: the new feed's segments continue after the last segment
 * the app held of the old one.
 */
export function withSequenceBase(parsed: ParsedPlaylist, base: number): ParsedPlaylist {
  if (base === 0) return parsed;
  return {
    ...parsed,
    mediaSequence: parsed.mediaSequence + base,
    segments: parsed.segments.map((segment) => ({
      ...segment,
      sequence: segment.sequence + base,
    })),
  };
}

/**
 * Names the segments with the app's own numbering.
 *
 * The name is what the segment is known by on the disk and in the URL, so it
 * has to carry the number the app published it under - and the generation it
 * came from, so the segments of two feeds of one match are never mistaken
 * for one another.
 */
export function withSegmentNames(parsed: ParsedPlaylist, generation: number): ParsedPlaylist {
  return {
    ...parsed,
    segments: parsed.segments.map((segment) => ({
      ...segment,
      name: segmentName(segment.uri, segment.sequence, generation),
    })),
  };
}

/** Reads one attribute out of a tag: `URI="..."`. */
function attribute(tag: string, name: string): string | null {
  const quoted = new RegExp(`${name}="([^"]*)"`, 'i').exec(tag);
  if (quoted?.[1]) return quoted[1];
  const bare = new RegExp(`(?:^|,)${name}=([^,\\s]+)`, 'i').exec(tag);
  return bare?.[1] ?? null;
}

/** A file name that is safe to use on disk and in a URL. */
function safeName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

/**
 * The name a segment is cached under.
 *
 * The app's own number leads, so the names sort in stream order and two
 * segments can never share a name. The generation follows it: the segments of
 * two feeds of one match must never be mistaken for one another, and the same
 * feed with a fresh token is a new address as well.
 */
export function segmentName(uri: string, sequence: number, generation = 0): string {
  let base = '';
  try {
    const url = new URL(uri);
    base = url.pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    base = uri.split('/').filter(Boolean).pop() ?? '';
  }
  const clean = safeName(base) || 'segment';
  return `${sequence}-${generation}-${clean}`;
}

function resolveUri(raw: string, baseUrl: string): string | null {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Reads an upstream playlist. */
export function parsePlaylist(body: string, baseUrl: string): ParsedPlaylist {
  let mediaSequence = 0;
  let targetDuration = 0;
  let duration = 0;
  let programDateTime: string | null = null;
  let initUri: string | null = null;
  let keyUri: string | null = null;
  let keyMethod: string | null = null;
  let keyIv: string | null = null;
  let isMaster = false;
  let afterVariant = false;
  const segments: PlaylistSegment[] = [];

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        // The address below this tag is a quality, not a segment.
        isMaster = true;
        afterVariant = true;
      } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = Number(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length)) || 0;
      } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
        targetDuration = Number(line.slice('#EXT-X-TARGETDURATION:'.length)) || 0;
      } else if (line.startsWith('#EXTINF:')) {
        duration = Number(line.slice('#EXTINF:'.length).split(',')[0]) || 0;
      } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
        programDateTime = line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length).trim() || null;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        initUri = attribute(line, 'URI');
      } else if (line.startsWith('#EXT-X-KEY:')) {
        keyUri = attribute(line, 'URI');
        keyMethod = attribute(line, 'METHOD');
        keyIv = attribute(line, 'IV');
      }
      continue;
    }

    // The address of a quality is not a segment of the stream.
    if (afterVariant) {
      afterVariant = false;
      continue;
    }

    const uri = resolveUri(line, baseUrl);
    if (!uri) continue;
    const sequence = mediaSequence + segments.length;
    segments.push({
      uri,
      name: segmentName(uri, sequence),
      duration,
      sequence,
      programDateTime,
    });
  }

  return {
    mediaSequence,
    targetDuration,
    segments,
    initUri,
    keyUri,
    keyMethod,
    keyIv,
    isMaster,
  };
}

/* ------------------------------------------------------------------ */
/* The list of qualities                                               */
/* ------------------------------------------------------------------ */

/** One quality of a master playlist. */
export interface PlaylistVariant {
  /** The media playlist of this quality. */
  readonly uri: string;
  readonly bandwidth: number;
  readonly resolution: string;
}

/**
 * Reads the qualities out of a master playlist.
 *
 * A master playlist is a list of qualities, not a stream: it holds no
 * segments of its own. The app has to open one of the qualities before it
 * can fetch anything - and the best one it can, because that is the one a
 * viewer would pick.
 */
export function parseVariants(body: string, baseUrl: string): PlaylistVariant[] {
  const variants: PlaylistVariant[] = [];
  const lines = body.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);
    const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1] ?? '';

    // The URI is on the next line that is not a tag.
    let uri = '';
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]?.trim() ?? '';
      if (!candidate) continue;
      if (candidate.startsWith('#')) continue;
      uri = candidate;
      break;
    }
    if (!uri) continue;

    try {
      variants.push({
        uri: new URL(uri, baseUrl).toString(),
        bandwidth,
        resolution,
      });
    } catch {
      // A line that is not an address is not a quality.
    }
  }

  return variants;
}

/** The quality a resolution amounts to. */
export function qualityOf(resolution: string, bandwidth: number): string {
  const height = Number(resolution.split('x')[1] ?? 0);
  if (height >= 2000) return '2160p';
  if (height >= 1000) return '1080p';
  if (height >= 700) return '720p';
  if (height >= 500) return '540p';
  if (bandwidth >= 4_000_000) return '1080p';
  if (bandwidth >= 1_500_000) return '720p';
  if (bandwidth >= 700_000) return '540p';
  return 'auto';
}

/**
 * Picks the quality the app hosts.
 *
 * The highest one is picked: the app fetches the media ahead of the player,
 * so the bandwidth of the feed costs the user nothing but their own line -
 * and the player can still ask for a lower one from the same server.
 */
export function bestVariant(
  variants: readonly PlaylistVariant[],
): PlaylistVariant | undefined {
  return [...variants].sort((a, b) => b.bandwidth - a.bandwidth)[0];
}

export interface LocalPlaylistOptions {
  readonly channelId: string;
  readonly mediaSequence: number;
  readonly targetDuration: number;
  readonly segments: readonly HeldSegment[];
  /**
   * The app's own sequence number for each segment, in the same order.
   *
   * The published MEDIA-SEQUENCE is the player's continuity: it must never
   * jump, whatever the upstream behind it does. When it is not given, the
   * upstream's own numbers are used.
   */
  readonly appSequences?: readonly number[];
  /** The cached name of the initialisation segment, when there is one. */
  readonly initName?: string | null;
  /** The cached name of the encryption key, when there is one. */
  readonly keyName?: string | null;
  readonly keyMethod?: string | null;
  readonly keyIv?: string | null;
}

/** Where the player fetches a segment from - this app, never a third party. */
export function segmentUrl(channelId: string, name: string): string {
  return `/api/media/segment?channel=${encodeURIComponent(channelId)}&name=${encodeURIComponent(name)}`;
}

/** Where the player fetches an encryption key from. */
export function keyUrl(channelId: string, name: string): string {
  return `/api/media/key?channel=${encodeURIComponent(channelId)}&name=${encodeURIComponent(name)}`;
}

/**
 * The playlist the personal server publishes.
 *
 * Only the segments the server actually holds are listed: a segment that is
 * announced but not fetched yet would make the player wait for it - which is
 * exactly the stall this server exists to remove.
 */
export function buildLocalPlaylist(options: LocalPlaylistOptions): string {
  const lines: string[] = ['#EXTM3U', '#EXT-X-VERSION:3'];

  const longest = options.segments.reduce((max, segment) => Math.max(max, segment.duration), 0);
  const target = Math.max(1, Math.ceil(options.targetDuration || longest || 1));
  lines.push(`#EXT-X-TARGETDURATION:${target}`);

  // The sequence the player tracks the window by. The app's own numbers are
  // used when they are given: they are continuous even when the upstream's
  // own numbering jumps, and a jump is what makes a player throw its buffer
  // away and re-buffer from nothing.
  const first = options.segments[0];
  const firstApp = options.appSequences?.[0];
  const mediaSequence = typeof firstApp === 'number' ? firstApp : first ? first.sequence : options.mediaSequence;
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`);

  if (options.initName) {
    lines.push(`#EXT-X-MAP:URI="${segmentUrl(options.channelId, options.initName)}"`);
  }
  if (options.keyName && options.keyMethod) {
    const iv = options.keyIv ? `,IV=${options.keyIv}` : '';
    lines.push(
      `#EXT-X-KEY:METHOD=${options.keyMethod},URI="${keyUrl(options.channelId, options.keyName)}"${iv}`,
    );
  }

  for (const segment of options.segments) {
    if (segment.programDateTime) {
      lines.push(`#EXT-X-PROGRAM-DATE-TIME:${segment.programDateTime}`);
    }
    lines.push(`#EXTINF:${segment.duration.toFixed(3)},`);
    lines.push(segmentUrl(options.channelId, segment.name));
  }

  return `${lines.join('\n')}\n`;
}
