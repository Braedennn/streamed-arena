// The encryption key of a protected feed.
//
// The app serves the key itself, like everything else: the player is never
// pointed at a third-party host, not even for the key.
//
// GET /api/media/key?channel=<channel_id>&name=<key_name>

import { readSegment } from '@/lib/server/media/cache';
import { getChannel, touchChannel } from '@/lib/server/media/channels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHANNEL = /^[a-zA-Z0-9._-]{1,160}$/;
const NAME = /^[a-zA-Z0-9._-]{1,160}$/;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channel') ?? '';
  const name = searchParams.get('name') ?? '';

  if (!CHANNEL.test(channelId) || !NAME.test(name)) {
    return Response.json({ error: 'unsupported key' }, { status: 400 });
  }

  const channel = getChannel(channelId);
  if (!channel) {
    return Response.json({ error: 'unknown channel' }, { status: 404 });
  }
  touchChannel(channelId);

  // The key is served only when this channel is the one that fetched it: a
  // name the channel does not know is not answered from the disk.
  if (!channel.keyName || channel.keyName !== name) {
    return Response.json({ error: 'unknown key' }, { status: 404 });
  }

  const key = await readSegment(channelId, name);
  if (!key) {
    return Response.json({ error: 'the key is not cached' }, { status: 404 });
  }

  return new Response(new Uint8Array(key), {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    },
  });
}
