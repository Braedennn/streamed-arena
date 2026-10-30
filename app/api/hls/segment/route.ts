// HLS segment proxy — relays one media segment from the CDN to the renderer
// with the Referer the CDN requires, streaming the bytes through instead of
// buffering a 5 MB segment in memory.
//
// GET /api/hls/segment?u=<absolute upstream segment url>

import { Readable } from 'node:stream';
import { upstreamStream } from '@/lib/server/upstream';
import { isApprovedOrigin } from '@/lib/server/origins';

const ALLOWED_HOSTS = /^(?:[a-z0-9-]+\.)*(?:strmfree\.st|streamfree\.top)$/i;
const REFERER = 'https://strmfree.st/';
const TIMEOUT_MS = 20_000;

function allowed(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  // The provider's own domains, plus the one external origin the resolver
  // approved for this match — nothing else can be relayed.
  if (!ALLOWED_HOSTS.test(url.hostname) && !isApprovedOrigin(raw)) return null;
  return url;
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const upstream = allowed(searchParams.get('u') ?? '');
  if (!upstream) {
    return Response.json({ error: 'unsupported segment url' }, { status: 400 });
  }

  // The provider's CDN demands its referer; a third-party host usually wants
  // none. Try the plain request first there and fall back if it is refused.
  const providerHost = ALLOWED_HOSTS.test(upstream.hostname);
  const referers = providerHost ? [REFERER] : ['', REFERER];
  const range = request.headers.get('range');

  let accepted: Awaited<ReturnType<typeof upstreamStream>> | null = null;
  let lastStatus = 0;

  for (const referer of referers) {
    const headers: Record<string, string> = {};
    if (referer) headers.referer = referer;
    if (range) headers.range = range;

    try {
      const attempt = await upstreamStream(upstream.toString(), {
        headers,
        timeoutMs: TIMEOUT_MS,
        // If the renderer closes the tab mid-download, drop the upstream request
        // too — an abandoned stream would otherwise hold a socket forever.
        signal: request.signal,
      });
      if (attempt.status >= 200 && attempt.status < 300) {
        accepted = attempt;
        break;
      }
      attempt.stream.destroy();
      lastStatus = attempt.status;
      // Only a referer rejection is worth another try.
      if (attempt.status !== 403 && attempt.status !== 405) break;
    } catch {
      return Response.json({ error: 'upstream segment unreachable' }, { status: 504 });
    }
  }

  if (!accepted) {
    return Response.json({ error: `upstream responded ${lastStatus}` }, { status: 502 });
  }

  const response = accepted;
  const upstreamType = response.headers['content-type'];
  const contentType = typeof upstreamType === 'string' ? upstreamType : '';
  const outHeaders = new Headers();
  // The origin path serves segments as "application/javascript" (the .js
  // extension); the CDN serves "video/mp2t". The payload is MPEG-TS either
  // way, so normalise to the media type hls.js expects.
  outHeaders.set('content-type', contentType.startsWith('video/') ? contentType : 'video/mp2t');

  const length = response.headers['content-length'];
  if (typeof length === 'string') outHeaders.set('content-length', length);
  const rangeHeader = response.headers['content-range'];
  if (typeof rangeHeader === 'string') outHeaders.set('content-range', rangeHeader);
  outHeaders.set('accept-ranges', 'bytes');
  outHeaders.set('cache-control', 'no-store');

  const body = Readable.toWeb(response.stream) as ReadableStream<Uint8Array>;

  // 206 needs its own status code, otherwise the client sees a full body.
  return new Response(body, {
    status: response.status === 206 ? 206 : 200,
    headers: outHeaders,
  });
}
