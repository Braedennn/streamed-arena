// The provider's public API, read by the app's own server.
//
// The page used to call the provider's API itself: the fixture list, the
// categories, the per-match sources. The app is the provider now, and the
// page is part of the app — so the page asks this app, and this app asks the
// provider with its own connection pool, its own deadlines and its own cache.
//
// Nothing about the media changes here: the streams still come from the
// app's own server. This is the fixture list — the matches on the board.
//
// What crosses back is scrubbed: the provider's media doors (the embed
// pages) are rewritten to local placeholders before the answer is handed to
// the page. The page only ever counts feeds and reads their quality, so it
// has no use for the provider's addresses — and it should not have them.
//
// GET /api/provider/<path>

import { upstreamText } from '@/lib/server/upstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 10_000;
const PROVIDER_API = 'https://strmfree.st/api/v1';

/** The paths the app is allowed to ask for. */
const ALLOWED = /^(streams|categories|sources\/[a-zA-Z0-9._-]{1,120})$/;

/** How long an answer is reused. The board changes slowly; the client polls. */
const CACHE_TTL_MS = 4_000;
const CACHE = new Map<string, { at: number; body: string }>();

/** The provider's own hosts — nothing of theirs crosses back to the page. */
const PROVIDER_HOSTS = /^(?:[a-z0-9-]+\.)*(?:strmfree\.st|streamfree\.top)$/i;

/**
 * Rewrites the provider's media doors to local placeholders.
 *
 * The page reads the shape of a feed — how many there are, what quality,
 * whether one is on air — and never the address behind it. The address is
 * the app's business: it is where the app fetches the media from, and the app
 * hides it from the player.
 *
 * The provider's picture goes with it: the page does not show it, so it is
 * not sent. The team badges (ESPN's own images) are ordinary pictures and
 * stay where they are — they are not a server the player talks to.
 */
function scrub(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!/^https?:\/\//i.test(value)) return value;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return value;
    }
    if (!PROVIDER_HOSTS.test(url.hostname)) return value;
    if (!url.pathname.includes('/embed/')) return value;
    // The tail carries what the page actually reads: the quality and the
    // source number ("...1080p2"). The host is dropped.
    const tail = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    return `/provider-media/${tail}`;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // The provider's own picture is not shown by the app - it is not sent.
      if (key === 'thumbnail_url') {
        out[key] = null;
        continue;
      }
      out[key] = scrub(entry);
    }
    return out;
  }
  return value;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path: parts } = await context.params;
  const path = (parts ?? []).join('/');
  if (!ALLOWED.test(path)) {
    return Response.json({ error: 'unsupported provider path' }, { status: 400 });
  }
  // The query string is part of the question (the board is filtered by
  // category), so it travels on.
  const search = new URL(request.url).search;

  const cached = CACHE.get(path + search);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return json(cached.body);
  }

  try {
    const response = await upstreamText(`${PROVIDER_API}/${path}${search}`, {
      headers: { accept: 'application/json' },
      timeoutMs: TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) {
      return Response.json({ error: `the provider responded ${response.status}` }, { status: 502 });
    }
    const body = JSON.stringify(scrub(JSON.parse(response.body)));
    CACHE.set(path + search, { at: Date.now(), body });
    if (CACHE.size > 64) {
      const cutoff = Date.now() - CACHE_TTL_MS * 10;
      for (const [key, entry] of CACHE) {
        if (entry.at < cutoff) CACHE.delete(key);
      }
    }
    return json(body);
  } catch {
    return Response.json({ error: 'the provider could not be reached' }, { status: 504 });
  }
}

function json(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
