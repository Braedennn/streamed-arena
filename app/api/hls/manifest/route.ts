// HLS manifest proxy.
//
// The CDN refuses cross-origin reads from the app (the renderer cannot set the
// Referer the CDN demands) and the segments live on another host again. The
// app's own server can do both, so the renderer plays a same-origin manifest
// and this route relays it — rewriting every segment URI to the segment
// proxy, which streams the bytes with the required Referer.
//
// GET /api/hls/manifest?u=<absolute upstream manifest url>

import { upstreamText } from '@/lib/server/upstream';

const ALLOWED_HOSTS = /^(?:[a-z0-9-]+\.)*(?:strmfree\.st|streamfree\.top)$/i;
const REFERER = 'https://strmfree.st/';
const TIMEOUT_MS = 10_000;

function allowed(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (!ALLOWED_HOSTS.test(url.hostname)) return null;
  return url;
}

function segmentProxyUrl(upstream: string): string {
  return `/api/hls/segment?u=${encodeURIComponent(upstream)}`;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const raw = searchParams.get('u') ?? '';
  const upstream = allowed(raw);
  if (!upstream) {
    return Response.json({ error: 'unsupported manifest url' }, { status: 400 });
  }

  let body: string;
  try {
    const response = await upstreamText(upstream.toString(), {
      headers: {
        accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
        referer: REFERER,
      },
      timeoutMs: TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) {
      return Response.json({ error: `upstream responded ${response.status}` }, { status: 502 });
    }
    body = response.body;
  } catch {
    return Response.json({ error: 'upstream manifest unreachable' }, { status: 504 });
  }

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
        return segmentProxyUrl(new URL(trimmed, upstream).toString());
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
