// The servers of a match - the ones the app runs itself.
//
// The list used to be the provider's own doors (the CDN, the origin and the
// mirror). Those are the same files on the same machines, so the list looked
// like a choice between servers and was really a list of one server with three
// names.
//
// What the app shows now is what it hosts: a personal server per feed. The
// app resolves what is out there, measures it, and then serves the feed from
// its own server - the player is only ever pointed at this app.
//
// The match can be served by more than one service, and the app reads the
// best door of any of them by itself. The user can say "that service
// instead": the app then reads that service's door of the match first and
// keeps the others behind it.
//
// GET  /api/servers?key=<stream_key>
// POST /api/servers  { key, service }

import { applyChoice, resolvePersonalPool } from '@/lib/server/media/pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY = /^[a-zA-Z0-9._%\-/]{1,160}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key') ?? '';

  if (!KEY.test(key)) {
    return Response.json({ error: 'key is required' }, { status: 400 });
  }

  try {
    // Where this app is running: the personal servers are hosted right here,
    // on this machine, on this port.
    const localHost = request.headers.get('host') ?? '';
    const pool = await resolvePersonalPool(key, localHost);
    // Only the public shape leaves the server: the tokenised upstream stays
    // here, the renderer plays the app's own server.
    const payload = pool.rows.map((server) => ({
      id: server.id,
      slot: server.slot,
      slotLabel: server.slotLabel,
      quality: server.quality,
      backend: server.backend,
      backendLabel: server.backendLabel,
      source: server.source ?? null,
      proxyUrl: server.proxyUrl,
      playerUrl: server.playerUrl ?? null,
      latencyMs: server.latencyMs,
      edgeAgeSeconds: server.edgeAgeSeconds,
      mediaSequence: server.mediaSequence,
      score: server.score,
      label: server.label,
      localHost: server.localHost ?? localHost,
      stale: server.stale ?? false,
      state: server.state ?? 'warming',
      // The channel the app's own server runs this feed in. The name is what
      // the app uses to find the server again - it is what tells it which
      // server to start fetching before the player asks for the first
      // playlist.
      channelId: server.channelId ?? null,
    }));
    return Response.json(
      {
        key,
        servers: payload,
        state: pool.state,
        // The services this match can be served from, and the one the user
        // picked ("auto" when the app decides by itself).
        services: pool.services,
        choice: pool.choice,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Resolution failed';
    return Response.json({ error: message }, { status: 504 });
  }
}

/**
 * Picks the service a match is served from.
 *
 * The choice is for this match only: the next match the app resolves is
 * resolved by the app again. "auto" gives the match back to the app, which
 * reads the best door of any service.
 */
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'The body is not JSON.' }, { status: 400 });
  }
  if (!body || typeof body !== 'object') {
    return Response.json({ error: 'The body is not an object.' }, { status: 400 });
  }

  const input = body as { key?: unknown; service?: unknown };
  const key = typeof input.key === 'string' ? input.key.trim() : '';
  const service = typeof input.service === 'string' ? input.service.trim() : 'auto';
  if (!KEY.test(key)) {
    return Response.json({ error: 'key is required' }, { status: 400 });
  }
  if (service.length > 40) {
    return Response.json({ error: 'That is not a service.' }, { status: 400 });
  }

  try {
    // The choice is applied first: the channel that is already running this
    // match moves to the door that was asked for, and the choice is
    // remembered so the pool that is built right after it reads the same
    // door.
    applyChoice(key, service);
    const pool = await resolvePersonalPool(key);
    return Response.json(
      {
        key,
        servers: pool.rows.map((server) => ({
          id: server.id,
          slot: server.slot,
          slotLabel: server.slotLabel,
          quality: server.quality,
          backend: server.backend,
          backendLabel: server.backendLabel,
          source: server.source ?? null,
          proxyUrl: server.proxyUrl,
          playerUrl: server.playerUrl ?? null,
          latencyMs: server.latencyMs,
          edgeAgeSeconds: server.edgeAgeSeconds,
          mediaSequence: server.mediaSequence,
          score: server.score,
          label: server.label,
          localHost: server.localHost ?? '',
          stale: server.stale ?? false,
          state: server.state ?? 'warming',
          channelId: server.channelId ?? null,
        })),
        state: pool.state,
        services: pool.services,
        choice: pool.choice,
      },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The choice failed';
    return Response.json({ error: message }, { status: 500 });
  }
}
