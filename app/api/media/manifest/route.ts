// The playlist of a personal server.
//
// This is the app's own server, not a proxy for somebody else's: it publishes
// the segments it has fetched, in stream order, and never a segment it does
// not hold. The player asks this app and gets an answer in milliseconds -
// the media was fetched a moment ago instead of being fetched while the
// player waits for it.
//
// GET /api/media/manifest?channel=<channel_id>

import {
  ensureChannel,
  getChannel,
  MIN_PUBLISHED_SEGMENTS,
  parseChannelId,
  publishableWindow,
  touchChannel,
} from '@/lib/server/media/channels';
import { ensureIngest } from '@/lib/server/media/ingest';
import { buildLocalPlaylist } from '@/lib/server/media/playlist';
import { resolveUpstreams } from '@/lib/server/media/upstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHANNEL = /^[a-zA-Z0-9._-]{1,160}$/;
/**
 * How long a first request waits for the server to fetch something.
 *
 * Under the ten seconds hls.js gives a manifest request: a player that is
 * told "too late" retries, and the retry costs more than the wait.
 */
const WARMUP_WAIT_MS = 8_000;
const POLL_MS = 150;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channel') ?? '';

  if (!CHANNEL.test(channelId)) {
    return Response.json({ error: 'unsupported channel' }, { status: 400 });
  }

  let channel = getChannel(channelId);
  if (!channel) {
    // The app was restarted, or the channel was forgotten: the name says
    // which match it belongs to, so it can be rebuilt.
    const parsed = parseChannelId(channelId);
    if (!parsed) {
      return Response.json({ error: 'unknown channel' }, { status: 404 });
    }
    channel = ensureChannel(parsed);
  }

  touchChannel(channelId);

  // A channel that was forgotten has no way to the media yet.
  if (channel.upstreams.length === 0) {
    channel.upstreams = await resolveUpstreams({
      streamKey: channel.streamKey,
      slot: channel.slot,
      quality: channel.quality,
    });
  }

  ensureIngest(channel);

  // The first request waits for the server to fetch the first segments. That
  // is the price of the server being the provider: the media has to be on
  // the disk before it can be served.
  const deadline = Date.now() + WARMUP_WAIT_MS;
  let window = publishableWindow(channel);
  while (window.length < MIN_PUBLISHED_SEGMENTS && Date.now() < deadline) {
    await sleep(POLL_MS);
    window = publishableWindow(channel);
  }

  if (window.length === 0) {
    return Response.json(
      {
        error: 'the personal server is still warming up',
        state: channel.state,
        detail: channel.lastError,
      },
      { status: 503 },
    );
  }

  // The app's own numbering: continuous even when the upstream's jumps.
  const playlist = buildLocalPlaylist({
    channelId: channel.id,
    mediaSequence: channel.mediaSequence,
    targetDuration: channel.targetDuration,
    segments: window.map((entry) => entry.segment),
    appSequences: window.map((entry) => entry.appSequence),
    initName: channel.initName,
    keyName: channel.keyName,
    keyMethod: channel.keyMethod,
    keyIv: channel.keyIv,
  });

  return new Response(playlist, {
    status: 200,
    headers: {
      'content-type': 'application/vnd.apple.mpegurl',
      'cache-control': 'no-store',
      // The server is the provider now: the player may read it from anywhere.
      'access-control-allow-origin': '*',
    },
  });
}
