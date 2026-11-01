// What the app's own server is doing.
//
// The personal server is a background job: it fetches the media ahead of the
// player and publishes it. This is the window into it - which feed it is
// hosting, how far behind the live edge it is, how much it has fetched and
// what went wrong.
//
// GET /api/media/status[?channel=<channel_id>]

import { allChannels, getChannel } from '@/lib/server/media/channels';
import { isIngesting } from '@/lib/server/media/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function describe(channel: ReturnType<typeof getChannel>) {
  if (!channel) return null;
  const sequences = [...channel.segments.values()].map((segment) => segment.sequence);
  return {
    id: channel.id,
    streamKey: channel.streamKey,
    slot: channel.slot,
    quality: channel.quality,
    state: channel.state,
    ingesting: isIngesting(channel.id),
    segments: channel.segments.size,
    firstSequence: sequences.length ? Math.min(...sequences) : null,
    lastSequence: sequences.length ? Math.max(...sequences) : null,
    publishFloor: channel.publishFloor,
    edgeAgeSeconds: channel.edgeAgeSeconds,
    measuredAgeSeconds: channel.measuredAgeSeconds,
    latencyMs: channel.latencyMs,
    bytesServed: channel.bytesServed,
    lastError: channel.lastError,
    lastManifestAt: channel.lastManifestAt,
    upstream: channel.upstreams.map((entry) => ({
      serverId: entry.serverId,
      host: safeHost(entry.manifestUrl),
      personal: entry.personal,
    })),
  };
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).host;
  } catch {
    return '';
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const channel = searchParams.get('channel');

  if (channel) {
    const described = describe(getChannel(channel));
    if (!described) return Response.json({ error: 'unknown channel' }, { status: 404 });
    return Response.json(described, { headers: { 'cache-control': 'no-store' } });
  }

  const channels = allChannels().map((entry) => describe(entry));
  return Response.json({ channels }, { headers: { 'cache-control': 'no-store' } });
}
