// A small, predictable HTTPS client for upstream calls.
//
// Why not the global `fetch`? The app's server runs for hours inside Electron,
// and the global dispatcher degrades over time: sockets get reused after the
// CDN has closed them, and requests then hang until they time out. The
// symptom is a server that resolves streams fine on a fresh boot and returns
// nothing after a while.
//
// This client owns its sockets (one agent, bounded pool), enforces a hard
// deadline per request, and retries once on a transient network error. It is
// deliberately independent of Next.js' patched fetch so that route handlers
// and the resolver behave identically.

import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import {
  isBrowserDoor,
  movedAddress,
  noteBrowserDoor,
  pageForAddress,
  resolverFetch,
  resolverResolve,
  type RelayedResponse,
} from '@/lib/server/resolver';

const USER_AGENT = 'StreamedArena/1.6 (+https://github.com/Braedennn/streamed-arena)';

/**
 * The hosts that only answer over HTTP/2, and the headers they expect.
 *
 * A mirror edge serves its playlists over HTTP/2 alone and reads an Origin
 * header that plain requests leave out; a host lands here when one of the
 * app's own scrapers meets such a door.
 */
const h2Hosts = new Map<string, { origin?: string; referer?: string }>();

export function registerH2Host(host: string, headers: { origin?: string; referer?: string }): void {
  h2Hosts.set(host, { ...headers });
}

function isH2Host(url: URL): boolean {
  return url.protocol === 'https:' && h2Hosts.has(url.host);
}

/**
 * The hosts whose media only answers a browser.
 *
 * A media door may read the fingerprint of the program that knocks and
 * refuse the server's own stack. Those hosts are registered here, and their
 * bytes travel through the app's own browser instead — the relay in
 * electron/relay.cjs, which asks with Chromium's stack and answers with the
 * bytes it got.
 */
const browserHosts = new Set<string>();

export function registerBrowserHost(host: string): void {
  if (host) browserHosts.add(host.toLowerCase());
}

function isBrowserHost(url: URL): boolean {
  return browserHosts.has(url.host.toLowerCase());
}

/** The browser the app's own reads present as. */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';


/** One pool for every upstream host, with a hard cap on parallel sockets. */
const agent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 5_000,
  maxSockets: 16,
  maxFreeSockets: 8,
  timeout: 30_000,
  scheduling: 'lifo',
});

const MAX_TEXT_BYTES = 4 * 1024 * 1024;
/** A media segment is a few megabytes - the ceiling is generous on purpose. */
const MAX_BINARY_BYTES = 64 * 1024 * 1024;

export class UpstreamError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

export interface UpstreamOptions {
  readonly headers?: Record<string, string>;
  readonly method?: 'GET' | 'HEAD';
  readonly timeoutMs?: number;
  /** Extra attempts after a network-level failure (HTTP errors are not retried). */
  readonly retries?: number;
  /** Aborts the request when the caller goes away. */
  readonly signal?: AbortSignal;
}

export interface UpstreamTextResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface UpstreamHeadResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
}

export interface UpstreamPeekResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  /** The first bytes of the resource. */
  readonly head: Buffer;
}

export interface UpstreamBufferResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface UpstreamStreamResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly stream: IncomingMessage;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One HTTP/2 session per origin, kept warm between requests.
 *
 * An h2 connection costs a handshake to open and serves every variant of one
 * edge afterward; the segment fetches of a feed arrive in bursts, so the
 * answer is kept alive for a short while after its last use instead of being
 * re-handshaken for each segment.
 */
interface H2Entry {
  session: http2.ClientHttp2Session;
  idleTimer: NodeJS.Timeout;
}

const H2_IDLE_MS = 45_000;
const h2Sessions = new Map<string, H2Entry>();

function h2SessionFor(origin: string): http2.ClientHttp2Session {
  const cached = h2Sessions.get(origin);
  if (cached) {
    clearTimeout(cached.idleTimer);
    cached.idleTimer = setTimeout(() => closeH2Session(origin), H2_IDLE_MS);
    cached.idleTimer.unref?.();
    return cached.session;
  }

  const session = http2.connect(origin, { settings: { enablePush: false } });
  session.on('error', () => h2Sessions.delete(origin));
  session.on('close', () => h2Sessions.delete(origin));
  session.on('goaway', () => h2Sessions.delete(origin));
  const idleTimer = setTimeout(() => closeH2Session(origin), H2_IDLE_MS);
  idleTimer.unref?.();
  h2Sessions.set(origin, { session, idleTimer });
  return session;
}

function touchH2(origin: string): void {
  const entry = h2Sessions.get(origin);
  if (!entry) return;
  clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => closeH2Session(origin), H2_IDLE_MS);
  entry.idleTimer.unref?.();
}

function closeH2Session(origin: string): void {
  const entry = h2Sessions.get(origin);
  if (!entry) return;
  h2Sessions.delete(origin);
  clearTimeout(entry.idleTimer);
  entry.session.close();
}

/*
 * One request over an h2 session, shaped like the HTTP/1.1 answer above:
 * the plain `ClientHttp2Stream` is itself a Readable, so everything the
 * higher helpers do with a response applies to it unchanged.
 */
function requestOnceH2(url: URL, options: UpstreamOptions): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 8_000;
    const origin = url.origin;
    let session: http2.ClientHttp2Session;
    try {
      session = h2SessionFor(origin);
    } catch (error) {
      reject(error instanceof Error ? error : new UpstreamError('h2 session failed'));
      return;
    }
    touchH2(origin);

    const registry = h2Hosts.get(url.host);
    const headers: Record<string, string> = {
      'user-agent': USER_AGENT,
      // h2 answers in the same framing as the rest of the upstream client;
      // the playlist parser reads bytes, so nothing here wants compression.
      'accept-encoding': 'identity',
      ...options.headers,
    };
    // The headers the registered door expects, when the caller did not set
    // its own: referer and origin come from the page that would have sent
    // the request, and without them the edge refuses what it calls a
    // "forbidden" request.
    if (registry?.referer && !headers.referer) headers.referer = registry.referer;
    if (registry?.origin && !headers.origin) headers.origin = registry.origin;

    const request = session.request({
      ':method': options.method ?? 'GET',
      ':scheme': 'https',
      ':authority': url.host,
      ':path': `${url.pathname}${url.search}`,
      ...headers,
    });

    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      request.close();
      reject(error);
    };

    request.setTimeout(timeoutMs, () => fail(new UpstreamError(`upstream timed out after ${timeoutMs}ms`)));
    request.on('error', (error) => fail(error));
    request.on('response', (responseHeaders) => {
      if (settled) {
        request.close();
        return;
      }
      settled = true;
      const stream = request;
      (stream as unknown as { statusCode?: number }).statusCode = responseHeaders[':status'];
      (stream as unknown as { headers?: IncomingHttpHeaders }).headers = h1ify(responseHeaders);
      // The redirect walk looks for `location`; on h2 it arrives lowercase
      // already, which the header type also spells that way.
      resolve(stream as unknown as IncomingMessage);
    });

    if (options.signal) {
      if (options.signal.aborted) {
        fail(new UpstreamError('aborted'));
        return;
      }
      options.signal.addEventListener('abort', () => fail(new UpstreamError('aborted')), { once: true });
    }

    request.end();
  });
}

/** Lower-cases h2 pseudo headers into the shapes the http/1 definitions use. */
function h1ify(headers: IncomingHttpHeaders & { [key: string]: string | string[] | undefined }): IncomingHttpHeaders {
  const moved: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.startsWith(':')) continue;
    moved[key.toLowerCase()] = value;
  }
  return moved as IncomingHttpHeaders;
}

/**
 * Reads an address with the browser's own stack.
 *
 * Some doors read the client that asks and know only one: the browser's. The
 * same address, asked at the same moment with the same headers, is answered
 * 200 by the browser's stack and 403 by a plain network client - the
 * difference is the handshake itself, not the request.
 *
 * The browser is already there: the app runs in Electron, and the resolver
 * that finds these addresses in the first place is part of it. So the
 * address is read there and handed over, and the app's server carries on
 * exactly as it does for every other feed.
 *
 * How long the browser door is given to answer: the door's addresses carry a
 * token, and when the token has expired the resolver has to open the page
 * again before it can answer. That takes seconds rather than milliseconds,
 * so the reader is given more time than the other doors get - and the answer
 * it gets back is the door's own.
 */
const RELAY_TIMEOUT_MS = Number(process.env.ARENA_RELAY_TIMEOUT_MS ?? 15_000);

/**
 * Reads a refused address again, under a token that is alive.
 *
 * The token in an address of this door expires. When it does, the address is
 * refused - and the page that handed it out is asked again, which hands out a
 * new one. The app does not have to know that anything happened: it keeps
 * asking for the address it knows, and the answer comes from the new token.
 *
 * The resolver may already have asked the page again by itself - it does that
 * in the background when it refuses an address - so the address it knows is
 * tried first, and the page is only opened again when that is not enough.
 */
async function reread(
  page: string,
  url: URL,
  options: UpstreamOptions,
): Promise<RelayedResponse | null> {
  const timeoutMs = Math.max(options.timeoutMs ?? 0, RELAY_TIMEOUT_MS);

  const known = await resolverResolve(page);
  const answered = await readMoved(url.toString(), known, timeoutMs);
  if (answered) return answered;

  const fresh = await resolverResolve(page, { fresh: true });
  return readMoved(url.toString(), fresh, timeoutMs);
}

/** Reads an address under another token, when that token is a different one. */
async function readMoved(
  from: string,
  address: string | null,
  timeoutMs: number,
): Promise<RelayedResponse | null> {
  if (!address) return null;
  const moved = movedAddress(from, address);
  if (moved === from) return null;
  const answered = await resolverFetch(moved, { timeoutMs });
  if (!answered || answered.status < 200 || answered.status >= 300) return null;
  return answered;
}

async function requestOnceRelay(url: URL, options: UpstreamOptions): Promise<IncomingMessage> {
  const first = await resolverFetch(url.toString(), {
    timeoutMs: Math.max(options.timeoutMs ?? 0, RELAY_TIMEOUT_MS),
  });
  if (!first) {
    throw new UpstreamError('the browser door did not answer');
  }
  let answered: RelayedResponse = first;

  /*
   * The door refused the address: the token in it has expired. The page that
   * handed it out is asked again, and the address is read under the token
   * that comes back - so a refusal costs one read and not a whole poll.
   */
  if (answered.status === 403 || answered.status === 410) {
    const page = answered.page ?? pageForAddress(url.toString());
    const again = page ? await reread(page, url, options) : null;
    if (again) answered = again;
  }

  const headers: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(answered.headers)) headers[name.toLowerCase()] = value;

  /*
   * The answer may have come from another address than the one that was
   * asked for: the door's addresses carry a token, the token expires, and
   * the resolver asks the page again when it does. The app keeps its own
   * book of addresses, so it is told which one answered.
   */
  if (answered.source && answered.source !== url.toString()) {
    noteBrowserDoor(url.toString(), answered.source);
  }

  const stream = Readable.from([answered.body]) as unknown as IncomingMessage;
  (stream as unknown as { statusCode?: number }).statusCode = answered.status;
  (stream as unknown as { headers?: IncomingHttpHeaders }).headers = headers;
  return stream;
}

/**
 * Is this address a playlist?
 *
 * The browser reads the playlists of that door and nothing else. The media
 * itself is fetched by the app's own server - the door does not mind that,
 * and the browser refuses an address that is not a playlist, so sending the
 * media there would lose the feed that was working.
 */
function isPlaylistAddress(url: URL): boolean {
  return /\.m3u8(?:\?|$)/i.test(`${url.pathname}${url.search}`);
}

function requestOnce(url: URL, options: UpstreamOptions): Promise<IncomingMessage> {
  if (isH2Host(url)) return requestOnceH2(url, options);
  if (isBrowserDoor(url) && isPlaylistAddress(url)) return requestOnceRelay(url, options);

  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = url.protocol === 'http:' ? http : https;
    const timeoutMs = options.timeoutMs ?? 8_000;

    const request = transport.request(url, {
      agent: url.protocol === 'http:' ? undefined : agent,
      method: options.method ?? 'GET',
      headers: {
        'user-agent': USER_AGENT,
        // The answer is read as text here. A compressed body would have to be
        // unpacked before it can be parsed, and nothing this client fetches
        // gains from being compressed on the way.
        'accept-encoding': 'identity',
        ...options.headers,
      },
    });

    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(error);
    };

    request.setTimeout(timeoutMs, () => {
      fail(new UpstreamError(`upstream timed out after ${timeoutMs}ms`));
    });

    if (options.signal) {
      if (options.signal.aborted) {
        fail(new UpstreamError('aborted'));
        return;
      }
      options.signal.addEventListener('abort', () => fail(new UpstreamError('aborted')), { once: true });
    }

    request.on('error', (error) => fail(error));
    request.on('response', (response) => {
      if (settled) {
        response.resume();
        return;
      }
      settled = true;
      resolve(response);
    });

    request.end();
  });
}

async function requestWithRetry(url: URL, options: UpstreamOptions): Promise<IncomingMessage> {
  const attempts = Math.max(0, options.retries ?? 1) + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await requestOnce(url, options);
    } catch (error) {
      lastError = error;
      // A caller-driven abort is final — retrying would ignore the intent.
      if (error instanceof UpstreamError && error.message === 'aborted') throw error;
      if (attempt < attempts - 1) await sleep(250 * (attempt + 1));
    }
  }

  throw lastError instanceof Error ? lastError : new UpstreamError('upstream request failed');
}

/** How many redirects are followed before the answer is given up on. */
const MAX_REDIRECTS = 5;

/**
 * Follows the redirects a carrier sends.
 *
 * A broadcaster's own address is often a door: the page names it, and the
 * door sends the reader to the machine that is serving the feed right now.
 * Not following them would mean reading a door as if it were a feed.
 */
async function requestFollowingRedirects(
  url: URL,
  options: UpstreamOptions,
): Promise<IncomingMessage> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await requestWithRetry(current, options);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    const redirect =
      status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
    if (!location || !redirect) return response;

    response.resume();
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      return response;
    }
    current = next;
  }
  return requestWithRetry(current, options);
}

function unpacked(response: IncomingMessage, body: Buffer): Buffer {
  const encoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
  if (encoding === 'gzip' || encoding === 'x-gzip') {
    try {
      return zlib.gunzipSync(body);
    } catch {
      return body;
    }
  }
  if (encoding === 'deflate') {
    try {
      return zlib.inflateSync(body);
    } catch {
      try {
        return zlib.inflateRawSync(body);
      } catch {
        return body;
      }
    }
  }
  return body;
}

/** Fetches a small resource as text. */
export async function upstreamText(
  url: string,
  options: UpstreamOptions = {},
): Promise<UpstreamTextResult> {
  const response = await requestFollowingRedirects(new URL(url), options);
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of response) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_TEXT_BYTES) {
        response.destroy();
        throw new UpstreamError('upstream response too large');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    response.destroy();
    throw error;
  }

  const body = unpacked(response, Buffer.concat(chunks));
  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: body.toString('utf8'),
  };
}

/**
 * Fetches a whole resource into memory.
 *
 * Used for the media segments the personal server caches: one segment is a
 * few megabytes, which is small enough to hold and far simpler than handing
 * a half-written file to the player.
 */
export async function upstreamBuffer(
  url: string,
  options: UpstreamOptions = {},
): Promise<UpstreamBufferResult> {
  const response = await requestFollowingRedirects(new URL(url), options);
  const chunks: Buffer[] = [];
  let size = 0;

  try {
    for await (const chunk of response) {
      const buffer = chunk as Buffer;
      size += buffer.length;
      if (size > MAX_BINARY_BYTES) {
        response.destroy();
        throw new UpstreamError('upstream response too large');
      }
      chunks.push(buffer);
    }
  } catch (error) {
    response.destroy();
    throw error;
  }

  return { status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) };
}

/** Fetches only the headers of a resource (used for segment health checks). */
export async function upstreamHead(
  url: string,
  options: UpstreamOptions = {},
): Promise<UpstreamHeadResult> {
  const response = await requestFollowingRedirects(new URL(url), { ...options, method: 'HEAD' });
  response.resume();
  return { status: response.statusCode ?? 0, headers: response.headers };
}

/**
 * Opens a streamed response. The caller owns the stream and must consume or
 * destroy it — otherwise the socket leaks and the pool degrades.
 */
export async function upstreamStream(
  url: string,
  options: UpstreamOptions = {},
): Promise<UpstreamStreamResult> {
  const response = await requestFollowingRedirects(new URL(url), options);
  return { status: response.statusCode ?? 0, headers: response.headers, stream: response };
}

/**
 * Fetches only the beginning of a resource.
 *
 * A ranged GET keeps the answer small; a server that ignores the range is cut
 * off after its first chunk, so a multi-megabyte segment never has to be
 * downloaded just to look at its first bytes.
 */
export async function upstreamPeek(
  url: string,
  bytes = 376,
  options: UpstreamOptions = {},
): Promise<UpstreamPeekResult> {
  const limit = Math.max(1, Math.min(bytes, 64 * 1024));
  const response = await requestFollowingRedirects(new URL(url), {
    ...options,
    headers: { ...options.headers, range: `bytes=0-${limit - 1}` },
  });

  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of response) {
      const buffer = chunk as Buffer;
      chunks.push(buffer);
      size += buffer.length;
      if (size >= limit) break;
    }
  } catch {
    // A truncated answer still says what the resource starts with.
  } finally {
    response.destroy();
  }

  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    head: Buffer.concat(chunks).subarray(0, limit),
  };
}
