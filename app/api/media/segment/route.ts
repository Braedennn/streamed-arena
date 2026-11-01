// One media segment, served by the app.
//
// The bytes were fetched by the app's own server a moment ago and are read
// from its disk - so the player never waits for a third-party host, and no
// third-party host is ever named to it.
//
// A segment the server does not hold (the player asked for one that fell out
// of the window, or one that is still on its way) is fetched once and served
// straight away, so the player is never left with a hole.
//
// GET /api/media/segment?channel=<channel_id>&name=<segment_name>

import { readSegment } from '@/lib/server/media/cache';
import { getChannel, touchChannel } from '@/lib/server/media/channels';
import { upstreamBuffer } from '@/lib/server/upstream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CHANNEL = /^[a-zA-Z0-9._-]{1,160}$/;
const NAME = /^[a-zA-Z0-9._-]{1,160}$/;
const FETCH_TIMEOUT_MS = 20_000;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const channelId = searchParams.get('channel') ?? '';
  const name = searchParams.get('name') ?? '';

  if (!CHANNEL.test(channelId) || !NAME.test(name)) {
    return Response.json({ error: 'unsupported segment' }, { status: 400 });
  }

  const channel = getChannel(channelId);
  if (!channel) {
    return Response.json({ error: 'unknown channel' }, { status: 404 });
  }
  touchChannel(channelId);

  let payload = await readSegment(channelId, name);

  if (!payload) {
    // Not cached: fetch it once, so the player gets its segment instead of
    // a hole. The upstream announces a segment a moment before its file is
    // really there, so this is the normal way the newest segment is served
    // when the player outruns the prefetch.
    const held = channel.segments.get(name);
    const uri = held?.uri ?? channel.announced.get(name);
    if (!uri) {
      return Response.json({ error: 'unknown segment' }, { status: 404 });
    }
    const upstream = channel.upstreams[channel.upstreamIndex];
    const referer = upstream?.referers[0] ?? '';
    try {
      const headers: Record<string, string> = {};
      if (referer) headers.referer = referer;
      const response = await upstreamBuffer(uri, {
        headers,
        timeoutMs: FETCH_TIMEOUT_MS,
        signal: request.signal,
      });
      if (response.status < 200 || response.status >= 300) {
        return Response.json({ error: `upstream responded ${response.status}` }, { status: 502 });
      }
      payload = response.body;
    } catch {
      return Response.json({ error: 'the segment could not be fetched' }, { status: 504 });
    }
  }

  const headers = new Headers();
  headers.set('content-type', 'video/mp2t');
  headers.set('cache-control', 'no-store');
  headers.set('access-control-allow-origin', '*');
  headers.set('accept-ranges', 'bytes');
  headers.set('content-length', String(payload.length));

  // A player that asks for part of a segment gets exactly that part.
  const range = request.headers.get('range');
  const match = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (match) {
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Number(match[2]) : payload.length - 1;
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < payload.length) {
      const slice = new Uint8Array(payload.subarray(start, Math.min(end + 1, payload.length)));
      headers.set('content-length', String(slice.byteLength));
      headers.set('content-range', `bytes ${start}-${start + slice.byteLength - 1}/${payload.length}`);
      return new Response(slice, { status: 206, headers });
    }
  }

  channel.bytesServed += payload.length;
  return new Response(new Uint8Array(payload), { status: 200, headers });
}
