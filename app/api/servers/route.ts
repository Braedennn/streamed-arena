// Resolves every playable server for a match: qualities, source slots and
// media backends, each one health-checked and scored by live-edge lag.
//
// GET /api/servers?key=<stream_key>

import { resolveServers } from '@/lib/server/streamfree';

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
    const servers = await resolveServers(key);
    // Only the public shape leaves the server: the tokenised upstream manifest
    // stays here, the renderer plays the same-origin proxy URL.
    const payload = servers.map((server) => ({
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
    }));
    return Response.json(
      { key, servers: payload },
      { headers: { 'cache-control': 'no-store' } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Resolution failed';
    return Response.json({ error: message }, { status: 504 });
  }
}
