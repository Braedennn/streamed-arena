// HLS manifest proxy.
//
// The app's server scrapes the provider: the board, the embed pages with
// their token maps and the playlist itself. What the renderer gets back is a
// playlist whose segments point straight at the provider - the main site and
// the mirror answer any Referer and reflect the browser's Origin header, and
// the CDN edge serves the very same files as the main site. The app's server
// therefore carries a couple of kilobytes of text and not a single byte of
// video.
//
// A third-party host that does not allow that keeps its old path: the
// segments travel through the app's server, which can set the Referer the
// host demands.
//
// The renderer addresses a mirror by its stable id (`?key=<match>&server=<id>`);
// the rotating access token is resolved here, per request. That keeps the
// player's URL constant, so a health check never restarts the stream.
//
// GET /api/hls/manifest?key=<stream_key>&server=<server_id>
// GET /api/hls/manifest?u=<absolute upstream manifest url>

import { resolveManifestUrl } from '@/lib/server/streamfree';
import { approveOrigin } from '@/lib/server/origins';
import { PROVIDER_HOSTS, directMediaUrl, providerReferers } from '@/lib/server/provider';
import { upstreamText } from '@/lib/server/upstream';

const TIMEOUT_MS = 10_000;
const KEY = /^[a-zA-Z0-9._%\-]{1,120}$/;
const SERVER = /^[a-zA-Z0-9._%\-]{1,40}$/;

function allowed(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!PROVIDER_HOSTS.test(url.hostname)) return null;
  return url;
}

function segmentProxyUrl(upstream: string): string {
  return `/api/hls/segment?u=${encodeURIComponent(upstream)}`;
}

/** The media sequence a playlist starts at - its position in the stream. */
function mediaSequence(body: string): number {
  return Number(body.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? -1);
}

/**
 * The newest playlist seen for a mirror.
 *
 * The provider's live edge wobbles backwards now and then, and a player that
 * is handed an older playlist seeks back with it. The newest playlist wins.
 */
const FRESHEST = new Map<string, { at: number; sequence: number; body: string }>();
/** How long a playlist stays "the newest one" before it is forgotten. */
const FRESHEST_TTL_MS = 30_000;

/**
 * Where the player should fetch a segment from.
 *
 * The provider's own doors hand the media to the browser itself: they answer
 * any Referer and reflect the browser's Origin header, so the player pulls
 * the segments straight from the provider and the app's server only ever
 * carries the playlist.
 *
 * Anything else - a third-party host - still travels through the app's
 * server, which can set the Referer that host demands.
 */
function segmentUrl(absolute: URL): string {
  return directMediaUrl(absolute) ?? segmentProxyUrl(absolute.toString());
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');
  const server = searchParams.get('server');

  let upstream: URL | null = null;
  // A URL the resolver produced is trusted (it comes from the provider's own
  // data, not from the caller); a caller-supplied `u` must be on the
  // provider's domains.
  let trusted = false;

  if (key && server) {
    if (!KEY.test(key) || !SERVER.test(server)) {
      return Response.json({ error: 'unsupported server reference' }, { status: 400 });
    }
    const manifestUrl = await resolveManifestUrl(key, server);
    if (!manifestUrl) {
      return Response.json({ error: 'server is no longer available' }, { status: 404 });
    }
    try {
      const resolved = new URL(manifestUrl);
      if (resolved.protocol === 'https:') {
        upstream = resolved;
        // The segment proxy needs to know this origin is legitimate too.
        approveOrigin(resolved.origin);
      }
    } catch {
      upstream = null;
    }
    trusted = upstream !== null;
  } else {
    upstream = allowed(searchParams.get('u') ?? '');
  }

  if (!upstream || upstream.protocol !== 'https:') {
    return Response.json({ error: 'unsupported manifest url' }, { status: 400 });
  }
  if (!trusted && !allowed(upstream.toString())) {
    return Response.json({ error: 'unsupported manifest url' }, { status: 400 });
  }

  let body = '';
  // Every provider door checks the referer and wants its own: the CDN and the
  // origin ask for strmfree.st, the mirror for streamfree.top. A third-party
  // host usually wants none at all — so the plain request is tried first there.
  const referers = providerReferers(upstream.hostname);

  for (const referer of referers) {
    const headers: Record<string, string> = {
      accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
    };
    if (referer) headers.referer = referer;
    try {
      const response = await upstreamText(upstream.toString(), {
        headers,
        timeoutMs: TIMEOUT_MS,
      });
      if (response.status >= 200 && response.status < 300) {
        body = response.body;
        break;
      }
      if (response.status !== 403 && response.status !== 405) {
        return Response.json({ error: `upstream responded ${response.status}` }, { status: 502 });
      }
    } catch {
      return Response.json({ error: 'upstream manifest unreachable' }, { status: 504 });
    }
  }

  if (!body) {
    return Response.json({ error: 'upstream responded 403' }, { status: 502 });
  }

  // The playlist is rewritten so the player can take the media itself.
  //
  // The provider cuts its segments from a running stream and stamps them with
  // their real timestamps, but the media inside is a little shorter than the
  // playlist claims - every boundary drops a frame. hls.js knows how to deal
  // with that: as long as the fragments are contiguous it closes the gap
  // itself and the buffered picture stays whole. Marking every segment as a
  // discontinuity would turn that off, and the picture would hitch at every
  // boundary instead - so the playlist is passed through as it is.
  const rewritten = body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Tag lines may carry a URI attribute (EXT-X-KEY / EXT-X-MAP / media).
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          try {
            return `URI="${segmentUrl(new URL(uri, upstream))}"`;
          } catch {
            return _match;
          }
        });
      }

      // Bare segment lines resolve against the upstream manifest.
      try {
        return segmentUrl(new URL(trimmed, upstream));
      } catch {
        return line;
      }
    })
    .join('\n');

  // The provider's live edge wobbles: between two refreshes the playlist
  // sometimes comes back older than the one before it - the edge jumps back
  // by a segment or two, and once it went back further than that. A player
  // that is handed an older playlist believes it and seeks back with it, which
  // is the picture jumping backwards. The newest playlist seen for a mirror
  // is therefore kept, and an older one is not handed out.
  const sequence = mediaSequence(body);
  const cacheKey = `${key ?? upstream.toString()}|${server ?? ''}`;
  const known = FRESHEST.get(cacheKey);
  let playlist = rewritten;
  if (
    known &&
    sequence >= 0 &&
    known.sequence >= 0 &&
    sequence < known.sequence &&
    Date.now() - known.at < FRESHEST_TTL_MS
  ) {
    playlist = known.body;
  } else {
    FRESHEST.set(cacheKey, { at: Date.now(), sequence, body: rewritten });
    // The map lives as long as the app; old mirrors are dropped so it cannot
    // grow without end.
    if (FRESHEST.size > 64) {
      const cutoff = Date.now() - FRESHEST_TTL_MS;
      for (const [entryKey, entry] of FRESHEST) {
        if (entry.at < cutoff) FRESHEST.delete(entryKey);
      }
    }
  }

  return new Response(playlist, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
    },
  });
}
