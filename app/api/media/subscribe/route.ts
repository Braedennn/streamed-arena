// Warming a personal server up.
//
// The player asks for a playlist and the server has to have media before it
// can answer. This call is the app saying "this match is about to be
// watched": the server starts fetching the best feed right away, so the
// first playlist is there when the player asks for it.
//
// It is also how a personal server is stopped again - a server that nobody
// watches should not keep pulling the feed.
//
// POST   /api/media/subscribe?key=<stream_key>[&warm=2]
// DELETE /api/media/subscribe?key=<stream_key>

import { channelIdFor, channelsForStream, getChannel } from '@/lib/server/media/channels';
import { ensureIngest, stopIngest } from '@/lib/server/media/ingest';
import { resolvePersonalPool } from '@/lib/server/media/pool';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY = /^[a-zA-Z0-9._%\-]{1,120}$/;
/** A channel that was asked for this recently is left alone. */
const IDLE_GRACE_MS = 20_000;

export async function POST(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key') ?? '';
  const warm = Number(searchParams.get('warm') ?? '1');

  if (!KEY.test(key)) {
    return Response.json({ error: 'key is required' }, { status: 400 });
  }

  let pool;
  try {
    pool = await resolvePersonalPool(key);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'resolution failed';
    return Response.json({ error: message }, { status: 504 });
  }

  // The best feeds start fetching now; the rest wait until somebody picks
  // them, so the app is not pulling a stream nobody is watching.
  const count = Number.isFinite(warm) ? Math.max(0, Math.min(3, Math.floor(warm))) : 1;
  for (const row of pool.rows.slice(0, count)) {
    const channel = getChannel(channelIdFor(key, row.slot, row.quality));
    if (channel) ensureIngest(channel);
  }

  return Response.json(
    { key, servers: pool.rows, state: pool.state },
    { headers: { 'cache-control': 'no-store' } },
  );
}

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key') ?? '';

  if (!KEY.test(key)) {
    return Response.json({ error: 'key is required' }, { status: 400 });
  }

  // Only channels nobody is asking for any more are stopped. A page that
  // closes while the player is still running must not take the server away
  // from it - the next playlist request starts the server again anyway.
  const now = Date.now();
  const channels = channelsForStream(key);
  let stopped = 0;
  for (const channel of channels) {
    if (now - channel.lastRequestAt < IDLE_GRACE_MS) continue;
    stopIngest(channel.id);
    stopped += 1;
  }

  return Response.json({ key, stopped });
}
