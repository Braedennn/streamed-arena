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
}

/** A segment the personal server holds. */
export interface HeldSegment {
  readonly name: string;
  readonly sequence: number;
  readonly duration: number;
  /** The upstream URI the segment came from. */
  readonly uri: string;
  /** When the upstream says the segment was produced (Last-Modified). */
  readonly publishedAtMs: number | null;
  readonly programDateTime: string | null;
  readonly bytes: number;
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
 * The sequence number leads, so the names sort in stream order and two
 * segments can never share a name.
 */
export function segmentName(uri: string, sequence: number): string {
  let base = '';
  try {
    const url = new URL(uri);
    base = url.pathname.split('/').filter(Boolean).pop() ?? '';
  } catch {
    base = uri.split('/').filter(Boolean).pop() ?? '';
  }
  const clean = safeName(base) || 'segment';
  return `${sequence}-${clean}`;
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
  const segments: PlaylistSegment[] = [];

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#')) {
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
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

  return { mediaSequence, targetDuration, segments, initUri, keyUri, keyMethod, keyIv };
}

export interface LocalPlaylistOptions {
  readonly channelId: string;
  readonly mediaSequence: number;
  readonly targetDuration: number;
  readonly segments: readonly HeldSegment[];
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

  const first = options.segments[0];
  lines.push(`#EXT-X-MEDIA-SEQUENCE:${first ? first.sequence : options.mediaSequence}`);

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
