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
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';

const USER_AGENT = 'StreamedArena/1.6 (+https://github.com/Braedennn/streamed-arena)';

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

export interface UpstreamStreamResult {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly stream: IncomingMessage;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function requestOnce(url: URL, options: UpstreamOptions): Promise<IncomingMessage> {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = url.protocol === 'http:' ? http : https;
    const timeoutMs = options.timeoutMs ?? 8_000;

    const request = transport.request(url, {
      agent: url.protocol === 'http:' ? undefined : agent,
      method: options.method ?? 'GET',
      headers: {
        'user-agent': USER_AGENT,
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

/** Fetches a small resource as text. */
export async function upstreamText(
  url: string,
  options: UpstreamOptions = {},
): Promise<UpstreamTextResult> {
  const response = await requestWithRetry(new URL(url), options);
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

  return {
    status: response.statusCode ?? 0,
    headers: response.headers,
    body: Buffer.concat(chunks).toString('utf8'),
  };
}

/** Fetches only the headers of a resource (used for segment health checks). */
export async function upstreamHead(
  url: string,
  options: UpstreamOptions = {},
): Promise<UpstreamHeadResult> {
  const response = await requestWithRetry(new URL(url), { ...options, method: 'HEAD' });
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
  const response = await requestWithRetry(new URL(url), options);
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
  const response = await requestWithRetry(new URL(url), {
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
