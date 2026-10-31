// HLS manifest proxy.
//
// The CDN refuses cross-origin reads from the app (the renderer cannot set the
// Referer the CDN demands) and the segments live on another host again. The
// app's own server can do both, so the renderer plays a same-origin manifest
// and this route relays it — rewriting every segment URI to the segment
// proxy, which streams the bytes with the required Referer.
//
// The renderer addresses a mirror by its stable id (`?key=<match>&server=<id>`);
// the rotating access token is resolved here, per request. That keeps the
// player's URL constant, so a health check never restarts the stream.
//
// GET /api/hls/manifest?key=<stream_key>&server=<server_id>
// GET /api/hls/manifest?u=<absolute upstream manifest url>

import { resolveManifestUrl } from '@/lib/server/streamfree';
import { approveOrigin } from '@/lib/server/origins';
import { PROVIDER_HOSTS, providerReferers } from '@/lib/server/provider';
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

  // Every segment is marked as a discontinuity.
  //
  // The provider cuts its segments from a running stream and stamps them with
  // their real timestamps, but the media inside is a little shorter than the
  // playlist claims: every boundary drops a frame or two. For a live stream
  // hls.js keeps those media timestamps, so the gaps land in the buffered
  // range as holes — and a hole makes hls.js nudge the playhead, which shows
  // up as a short stutter every few seconds.
  //
  // A discontinuity tells hls.js to place every segment on the playlist
  // timeline instead. That timeline is continuous by construction, so the
  // holes disappear and the picture stops stuttering.
  const rewritten = body
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Tag lines may carry a URI attribute (EXT-X-KEY / EXT-X-MAP / media).
      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri: string) => {
          try {
            return `URI="${segmentProxyUrl(new URL(uri, upstream).toString())}"`;
          } catch {
            return _match;
          }
        });
      }

      // Bare segment lines resolve against the upstream manifest.
      try {
        return `#EXT-X-DISCONTINUITY\n${segmentProxyUrl(new URL(trimmed, upstream).toString())}`;
      } catch {
        return line;
      }
    })
    .join('\n');

  return new Response(rewritten, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
    },
  });
}
