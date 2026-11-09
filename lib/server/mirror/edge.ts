// The edge of the mirror: the door that serves the video.
//
// A mirror channel is reached through its embed page, which carries the
// address of the machine that serves the video right now ("the edge"), the
// channel's own slug, and a token the edge hands out just before a playlist
// is read. The token lives for two minutes; the app mints one when it needs
// a playlist and keeps it a little past that.
//
// Two marks make this door what it is, and both are checked here:
//   - it answers over HTTP/2 only. The plain http/1 client the rest of the
//     app uses gets a flat "forbidden" in reply, so the host is registered
//     with the upstream client as an h2 host when the page is read.
//   - it expects to be read as a page that is inside the embed: the origin
//     and the referer of the embed travel with every request.
//
// The embed page itself is a plain document again - no cloud door in front
// of it - so the whole hop from a channel name to a playable playlist is
// asked of the network in one breath.

import { registerH2Host, upstreamText } from '@/lib/server/upstream';
import { providerJson, providerText } from '@/lib/server/sources/providers/http';
import { READER_UA } from '@/lib/server/mirror/schedule';

const EMBED = 'https://dembed.st/premiumtv/daddy.php';

/** The origin the embed presents, which the edge reads back. */
export const EMBED_ORIGIN = 'https://dembed.st';

/** One channel resolved to its delivery. */
export interface MirrorDelivery {
  /** The edge that serves the playlist ("https://edge.xxxxx.top"). */
  readonly edge: string;
  /** The channel's slug on that edge ("premium589"). */
  readonly slug: string;
}

/** One token of one channel on one edge. */
interface MirrorToken {
  readonly token: string;
  /** The playlist address this token belongs to. */
  readonly manifestUrl: string;
  /** Unix ms before which the token is believed to still work. */
  readonly expiresAt: number;
}

const TOKEN_MARGIN_MS = 15_000;
const tokens = new Map<string, MirrorToken>();

/** One embed page in flight at a time, per channel. */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * The edge the app last resolved.
 *
 * One edge carries every channel of the schedule, and the token door is a
 * few hundred bytes where the embed page is the better part of a megabyte.
 * A channel is tried against the edge the app already knows before its own
 * page is read; when the edge has moved on, the page says so and the app
 * follows it there.
 */
let knownEdge: string | null = null;

/**
 * The delivery of one channel, from its embed page.
 *
 * The page names the edge and the slug in its own configuration block, in
 * the open - the app reads them straight out of the text.
 */
export async function mirrorDelivery(channelId: string): Promise<MirrorDelivery | null> {
  const page = await providerText(`${EMBED}?id=${encodeURIComponent(channelId)}`, {
    timeoutMs: 12_000,
    headers: { 'user-agent': READER_UA, referer: 'https://thedaddy.li/' },
  });
  if (!page) return null;

  const edge = page.match(/const\s+EDGE\s*=\s*"([^"]+)"/)?.[1];
  const slug = page.match(/const\s+CHANNEL\s*=\s*"([^"]+)"/)?.[1];
  const src = page.match(/const\s+SRC\s*=\s*"([^"]+)"/)?.[1];
  if (!edge || !slug || !src || !/index\.m3u8$/.test(src)) return null;

  try {
    const host = new URL(edge).host;
    // Everything from here on speaks to the edge as the embed would. The
    // upstream client attaches these headers itself, because the server
    // never leaves them out - including mid-stream, when the app's own
    // cache fetches segments.
    registerH2Host(host, { origin: EMBED_ORIGIN, referer: `${EMBED_ORIGIN}/` });
  } catch {
    return null;
  }

  return { edge: edge.replace(/\/$/, ''), slug };
}

interface TokenAnswer {
  readonly token?: string;
  readonly ttl?: number;
}

/**
 * A fresh token for one channel.
 *
 * The edge answers with the token and the seconds it will live; the app
 * keeps it until a little before the end.
 */
async function mintToken(delivery: MirrorDelivery): Promise<MirrorToken | null> {
  const answer = await providerJson<TokenAnswer>(
    `${delivery.edge}/api/playlist-token?slug=${encodeURIComponent(delivery.slug)}`,
    { timeoutMs: 8_000 },
  );
  if (!answer || !answer.token) return null;
  const ttlMs = Math.max(30_000, (Number(answer.ttl) || 120) * 1000) - TOKEN_MARGIN_MS;
  const manifestUrl = `${delivery.edge}/${delivery.slug}/index.m3u8`;
  return { token: answer.token, manifestUrl, expiresAt: Date.now() + ttlMs };
}

/**
 * The playlist address of a channel, with a working token in it.
 *
 * A token in hand is kept until shortly before it dies; after that the next
 * read mints a new one. The address is held in one unchanging form - edge,
 * slug, token - because the app treats an address as its own for as long as
 * it plays.
 */
export async function mirrorManifestUrl(channelId: string): Promise<string | null> {
  const cached = tokens.get(channelId);
  if (cached && Date.now() < cached.expiresAt) return `${cached.manifestUrl}?t=${encodeURIComponent(cached.token)}`;

  const running = inFlight.get(channelId);
  if (running) return running;

  const work = (async (): Promise<string | null> => {
    const slug = `premium${channelId}`;

    // The edge the app already knows first: the token door alone answers
    // whether this channel is served where the others are.
    if (knownEdge) {
      const token = await mintToken({ edge: knownEdge, slug }).catch(() => null);
      if (token) {
        tokens.set(channelId, token);
        return `${token.manifestUrl}?t=${encodeURIComponent(token.token)}`;
      }
    }

    const delivery = await mirrorDelivery(channelId);
    if (!delivery) return null;
    knownEdge = delivery.edge;
    const token = await mintToken(delivery);
    if (!token) return null;
    tokens.set(channelId, token);
    return `${token.manifestUrl}?t=${encodeURIComponent(token.token)}`;
  })();

  inFlight.set(channelId, work.catch(() => null));
  try {
    return await work;
  } finally {
    inFlight.delete(channelId);
  }
}

/**
 * A playlist, as the app would read it: bytes that answer.
 *
 * Used by the probe - it plays the playlist before the feed is offered,
 * and a door that does not hand out a playlist is not offered.
 */
export async function mirrorManifestBody(url: string, timeoutMs: number): Promise<string | null> {
  const response = await upstreamText(url, { timeoutMs });
  if (response.status < 200 || response.status >= 300) return null;
  return response.body;
}
