// Does this feed actually play?
//
// A carrier's page points at a feed; that is a promise, not a fact. The
// promise is checked here, before the app offers the feed to anybody:
// the playlist is fetched, the newest segment is fetched, and the bytes are
// checked to be video and not a picture.
//
// The same three questions the app asks of any feed are asked here:
//   - how long did it take to answer (latency)
//   - how old is the newest segment (the real lag)
//   - is there video in it at all
//
// A master playlist (a list of qualities) is opened and its best quality is
// measured; the app hosts the qualities separately, so all of them are kept.

import { upstreamPeek, upstreamText } from '@/lib/server/upstream';
import { looksLikeMedia } from '@/lib/server/media/format';

const MANIFEST_TIMEOUT_MS = 6_000;
const SEGMENT_TIMEOUT_MS = 4_000;

/**
 * How many times a door is asked before the feed is given up on.
 *
 * The doors of the providers that hand out their own player are not even:
 * the same address answers 200, 403 and nothing at all from one moment to
 * the next, because the request lands on one of several edges and only some
 * of them know the address. A feed is therefore asked a few times before it
 * is called dead - a door that answers on the second try is a door that
 * plays.
 */
const DOOR_ATTEMPTS = 3;
const DOOR_PAUSE_MS = 350;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface DirectVariant {
  /** The media playlist of this quality. */
  readonly manifestUrl: string;
  /** The quality as the app names it ("1080p", "720p", ...). */
  readonly quality: string;
  readonly bandwidth: number;
}

export interface DirectProbe {
  readonly ok: boolean;
  /** The qualities that answer. */
  readonly variants: readonly DirectVariant[];
  readonly latencyMs: number;
  /** Seconds between the newest segment and now. */
  readonly edgeAgeSeconds: number;
  readonly mediaSequence: number;
  /** Why the feed was refused - empty when it plays. */
  readonly reason: string;
}

interface Variant {
  readonly url: string;
  readonly bandwidth: number;
  readonly resolution: string;
}

/** The quality a resolution amounts to. */
function qualityOf(resolution: string, bandwidth: number): string {
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

/** Reads the variants out of a master playlist. */
function variantsOf(body: string, baseUrl: string): Variant[] {
  const variants: Variant[] = [];
  const lines = body.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
    const bandwidth = Number(line.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0);
    const resolution = line.match(/RESOLUTION=(\d+x\d+)/)?.[1] ?? '';
    const uri = lines[index + 1]?.trim() ?? '';
    if (!uri || uri.startsWith('#')) continue;
    let absolute: string;
    try {
      absolute = new URL(uri, baseUrl).toString();
    } catch {
      continue;
    }
    variants.push({ url: absolute, bandwidth, resolution });
  }
  return variants;
}

interface Segment {
  readonly uri: string;
  readonly programDateTime: number | null;
}

/** Reads the segments out of a media playlist. */
function segmentsOf(body: string, baseUrl: string): Segment[] {
  const segments: Segment[] = [];
  let programDateTime: number | null = null;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      const stamp = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
      programDateTime = Number.isNaN(stamp) ? null : stamp;
      continue;
    }
    if (line.startsWith('#')) continue;
    try {
      segments.push({ uri: new URL(line, baseUrl).toString(), programDateTime });
    } catch {
      // A line that is not a URI is not a segment.
    }
  }
  return segments;
}

async function fetchText(
  url: string,
  referers: readonly string[],
): Promise<{ status: number; body: string; url: string } | null> {
  for (const referer of referers) {
    const headers: Record<string, string> = {
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
    };
    if (referer) headers.referer = referer;
    for (let attempt = 1; attempt <= DOOR_ATTEMPTS; attempt += 1) {
      try {
        const response = await upstreamText(url, { headers, timeoutMs: MANIFEST_TIMEOUT_MS });
        if (response.status >= 200 && response.status < 300) {
          // The address the playlist was read from is not always the one
          // that was asked for: the browser reads it from the door's own book
          // of addresses. The addresses inside the playlist are relative to
          // that one, so it is the base they are read against.
          const source = response.headers['x-arena-source'];
          return {
            status: response.status,
            body: response.body,
            url: typeof source === 'string' && source ? source : url,
          };
        }
        // The door says no: there is no point in asking it again with the
        // same headers, but the next edge may say yes.
        if (response.status !== 403 && response.status !== 405) return null;
      } catch {
        // A door that did not answer at all is asked again.
      }
      if (attempt < DOOR_ATTEMPTS) await sleep(DOOR_PAUSE_MS * attempt);
    }
  }
  return null;
}

/**
 * How old the newest segment is.
 *
 * The carrier stamps its segments; the stamp is what the age is measured
 * against. When a playlist publishes its own wall-clock time, that is used
 * instead - it is the same moment, said by the feed itself.
 */
async function measureAge(
  segmentUri: string,
  programDateTime: number | null,
  referers: readonly string[],
): Promise<number> {
  if (programDateTime !== null) {
    return Math.max(0, (Date.now() - programDateTime) / 1000);
  }
  try {
    const peek = await upstreamPeek(segmentUri, 376, {
      headers: { accept: '*/*', ...(referers[0] ? { referer: referers[0] } : {}) },
      timeoutMs: SEGMENT_TIMEOUT_MS,
    });
    const stamp = peek.headers['last-modified'];
    if (typeof stamp === 'string') {
      const parsed = Date.parse(stamp);
      if (!Number.isNaN(parsed)) return Math.max(0, (Date.now() - parsed) / 1000);
    }
  } catch {
    // No stamp: the age stays unknown.
  }
  return Number.NaN;
}

/**
 * Plays a candidate and says what it found.
 *
 * The feed is measured, not trusted: the playlist has to answer, it has to
 * hold segments, the newest segment has to be video, and a recording (a
 * playlist that says it has ended) is refused - a game that is over is not a
 * live feed.
 */
export async function probeCandidate(
  manifestUrl: string,
  referers: readonly string[],
): Promise<DirectProbe> {
  const started = Date.now();
  const failed = (reason: string): DirectProbe => ({
    ok: false,
    variants: [],
    latencyMs: Date.now() - started,
    edgeAgeSeconds: Number.NaN,
    mediaSequence: 0,
    reason,
  });

  const manifest = await fetchText(manifestUrl, referers);
  if (!manifest) return failed('the feed did not answer');

  // A master playlist: open the best quality and measure that.
  let mediaUrl = manifest.url;
  let mediaBody = manifest.body;
  const variants = variantsOf(manifest.body, manifest.url);
  if (variants.length > 0) {
    const ordered = [...variants].sort((a, b) => b.bandwidth - a.bandwidth);
    const best = ordered[0];
    if (!best) return failed('the feed has no quality');
    const opened = await fetchText(best.url, referers);
    if (!opened) return failed('the feed did not open');
    mediaUrl = opened.url;
    mediaBody = opened.body;
  }

  if (mediaBody.includes('#EXT-X-ENDLIST')) {
    return failed('the feed is a recording, not a live feed');
  }

  const segments = segmentsOf(mediaBody, mediaUrl);
  if (segments.length === 0) return failed('the feed has no segments');

  /*
   * The newest segment is probed first, and the one before it is the
   * fallback: an edge often lists a segment a moment before it serves it,
   * and a feed would be refused for that alone. The previous segment is a
   * complete picture of the same feed - if it plays, the feed plays.
   */
  let newest = segments[segments.length - 1];
  const previous = segments[segments.length - 2];
  if (!newest) return failed('the feed has no segments');

  // The bytes have to be video: a carrier that answers with a picture is not
  // a feed.
  const segmentPlays = async (segment: Segment): Promise<boolean> => {
    for (let attempt = 1; attempt <= DOOR_ATTEMPTS; attempt += 1) {
      try {
        const peek = await upstreamPeek(segment.uri, 376, {
          headers: { accept: '*/*', ...(referers[0] ? { referer: referers[0] } : {}) },
          timeoutMs: SEGMENT_TIMEOUT_MS,
        });
        if (peek.status >= 200 && peek.status < 300) return looksLikeMedia(peek.head);
      } catch {
        // A door that did not answer at all is asked again.
      }
      if (attempt < DOOR_ATTEMPTS) await sleep(DOOR_PAUSE_MS * attempt);
    }
    return false;
  };

  if (!(await segmentPlays(newest))) {
    if (!previous || !(await segmentPlays(previous))) {
      return failed('the newest segment did not answer');
    }
    newest = previous;
  }

  const edgeAgeSeconds = await measureAge(newest.uri, newest.programDateTime, referers);
  const mediaSequence = Number(mediaBody.match(/EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? 0);

  const playable: DirectVariant[] = variants.length
    ? variants
        .sort((a, b) => b.bandwidth - a.bandwidth)
        .slice(0, 3)
        .map((variant) => ({
          manifestUrl: variant.url,
          quality: qualityOf(variant.resolution, variant.bandwidth),
          bandwidth: variant.bandwidth,
        }))
    : [{ manifestUrl: mediaUrl, quality: 'auto', bandwidth: 0 }];

  return {
    ok: true,
    variants: playable,
    latencyMs: Date.now() - started,
    edgeAgeSeconds,
    mediaSequence,
    reason: '',
  };
}
