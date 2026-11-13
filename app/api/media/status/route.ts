// What the app's own server is doing.
//
// The personal server is a background job: it fetches the media ahead of the
// player and publishes it. This is the window into it - which feed it is
// hosting, how far behind the live edge it is, how much it has fetched and
// what went wrong.
//
// GET  /api/media/status[?channel=<channel_id>]
// POST /api/media/status?channel=<channel_id>&drop=current
//
// The POST is a diagnostic: it forgets the door the channel is reading, so
// the app moves on to the next one of the match by itself - the same move it
// makes when a feed dies in the middle of a game, only asked for by hand.

import { allChannels, getChannel } from '@/lib/server/media/channels';
import { isIngesting } from '@/lib/server/media/ingest';
import { rotateUpstream } from '@/lib/server/media/upstream';

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
    // The doors behind the channel, and the one being read right now. The
    // rest are the way out when the one being read stops answering - the
    // app moves to the next one by itself.
    reading: channel.upstreams[channel.upstreamIndex]?.serverId ?? null,
    doors: channel.upstreams.length,
    failovers: channel.failovers,
    generation: channel.generation,
    upstream: channel.upstreams.map((entry) => ({
      serverId: entry.serverId,
      host: safeHost(entry.manifestUrl),
      personal: entry.personal,
      label: entry.label ?? null,
      provider: entry.providerLabel ?? null,
      quality: entry.quality ?? null,
      dead: channel.rejected.has(entry.serverId),
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

/**
 * Forgets the door the channel is reading, so the app moves to the next one.
 *
 * This is what the app does by itself when a feed stops answering. It is
 * here so that the move can be asked for by hand as well - a feed that died
 * and a door that has to be left behind are the same thing to the server.
 */
export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channel') ?? '';
  const channel = getChannel(channelId);
  if (!channel) return Response.json({ error: 'unknown channel' }, { status: 404 });

  const moved = rotateUpstream(channel);
  return Response.json(
    { ...describe(channel), moved },
    { headers: { 'cache-control': 'no-store' } },
  );
}
