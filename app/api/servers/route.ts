// The servers of a match - the ones the app runs itself.
//
// The list used to be the provider's own doors (the CDN, the origin and the
// mirror). Those are the same files on the same machines, so the list looked
// like a choice between servers and was really one server with three names.
//
// What the app shows now is what it hosts: a personal server per feed. The
// app resolves what is out there, measures it, and then serves the feed from
// its own server - the player is only ever pointed at this app.
//
// GET /api/servers?key=<stream_key>

import { resolvePersonalPool } from '@/lib/server/media/pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY = /^[a-zA-Z0-9._%\-]{1,120}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key') ?? '';

  if (!KEY.test(key)) {
    return Response.json({ error: 'key is required' }, { status: 400 });
  }

  try {
    const pool = await resolvePersonalPool(key);
    // Only the public shape leaves the server: the tokenised upstream stays
    // here, the renderer plays the app's own server.
    const payload = pool.rows.map((server) => ({
      id: server.id,
      slot: server.slot,
      slotLabel: server.slotLabel,
      quality: server.quality,
      backend: server.backend,
      backendLabel: server.backendLabel,
      proxyUrl: server.proxyUrl,
      latencyMs: server.latencyMs,
      edgeAgeSeconds: server.edgeAgeSeconds,
      mediaSequence: server.mediaSequence,
      score: server.score,
      label: server.label,
      stale: server.stale ?? false,
      state: server.state ?? 'warming',
    }));
    return Response.json(
      { key, servers: payload, state: pool.state },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Resolution failed';
    return Response.json({ error: message }, { status: 504 });
  }
}
