// How the app talks to a provider API.
//
// The app's own HTTP client is used (lib/server/upstream.ts): it owns its
// sockets and its deadlines, which matters when the app runs for hours inside
// Electron and asks a dozen providers at once.
//
// A provider that does not answer is not an error: the app asks the next one.
// So every helper here answers with null instead of throwing.

import { upstreamText } from '@/lib/server/upstream';

const DEFAULT_TIMEOUT_MS = 8_000;

export interface ProviderRequest {
  readonly headers?: Record<string, string>;
  readonly timeoutMs?: number;
}

/** Fetches a small document as text. A failure is an empty answer. */
export async function providerText(
  url: string,
  options: ProviderRequest = {},
): Promise<string | null> {
  try {
    const response = await upstreamText(url, {
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      headers: options.headers,
    });
    if (response.status < 200 || response.status >= 300) return null;
    return response.body;
  } catch {
    return null;
  }
}

/** Fetches a small JSON document. A broken answer is an empty answer. */
export async function providerJson<T>(
  url: string,
  options: ProviderRequest = {},
): Promise<T | null> {
  const body = await providerText(url, {
    ...options,
    headers: { accept: 'application/json', ...options.headers },
  });
  if (body === null) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

/**
 * A value that is remembered for a while.
 *
 * A provider's board is read again and again - once per match the user opens -
 * and the board does not change from minute to minute. The last good answer is
 * kept, so a provider that is slow for a moment does not empty the app's
 * screen.
 */
export class ProviderCache<T> {
  private readonly store = new Map<string, { at: number; value: T }>();

  constructor(private readonly ttlMs: number) {}

  /** The remembered value, when it is still fresh. */
  peek(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.at > this.ttlMs) return undefined;
    return entry.value;
  }

  /** Remembers a value. */
  put(key: string, value: T): void {
    this.store.set(key, { at: Date.now(), value });
    if (this.store.size > 64) {
      const oldest = [...this.store.entries()].sort((a, b) => a[1].at - b[1].at);
      for (const [key] of oldest.slice(0, this.store.size - 32)) this.store.delete(key);
    }
  }

  /**
   * The remembered value, or a fresh one.
   *
   * A failure keeps the last good answer: a provider that stops answering for
   * a moment must not take its board away.
   */
  async read(key: string, load: () => Promise<T | null>): Promise<T | null> {
    const cached = this.peek(key);
    if (cached !== undefined) return cached;
    const value = await load();
    if (value === null) {
      const stale = this.store.get(key);
      return stale ? stale.value : null;
    }
    this.put(key, value);
    return value;
  }
}
