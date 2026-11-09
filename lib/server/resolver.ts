// The app's side of the resolver.
//
// The resolver is a service of its own, on the loopback interface: it runs in
// the app's own Electron process, and the server starts one of its own when
// it is running on its own (which is the case in development).
//
// Two things are asked of it:
//   - what does a provider's page play? (/resolve)
//   - what does this address say? (/fetch)
//
// The second one is not a convenience. The door behind the addresses of the
// providers that publish only their own player reads the client that asks,
// and it knows one: the browser's. The same address, asked at the same
// moment with the same headers, is answered 200 by the browser's stack and
// 403 by a plain network client. So the playlists are read through the
// browser, and handed to the app's own server from there.

import { spawn } from 'node:child_process';
import { existsSync, openSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The port the resolver listens on. */
const PORT = Number(process.env.ARENA_RESOLVER_PORT ?? 3911);
const BASE = `http://127.0.0.1:${PORT}`;

/** How long the resolver is given to answer. */
const ANSWER_TIMEOUT_MS = Number(process.env.ARENA_RESOLVER_ANSWER_MS ?? 25_000);

/** How long the server waits for a resolver it started itself. */
const START_TIMEOUT_MS = Number(process.env.ARENA_RESOLVER_START_MS ?? 25_000);

/** How long the resolver is remembered as awake. */
const AWAKE_TTL_MS = Number(process.env.ARENA_RESOLVER_AWAKE_MS ?? 5_000);

/** How long a resolved address is remembered. */
const ADDRESS_TTL_MS = Number(process.env.ARENA_RESOLVER_ADDRESS_TTL_MS ?? 5 * 60_000);

/**
 * The hosts whose answers only the browser gets.
 *
 * These are the hosts behind the addresses the resolver hands out. The media
 * itself is served from another host, which the app's own server can reach
 * on its own - it is only these playlists that the browser has to read.
 */
export const BROWSER_DOOR_HOSTS = /(^|\.)indianservers\.st$/i;

/** True when the address is one only the browser can read. */
export function isBrowserDoor(url: URL): boolean {
  return url.protocol === 'https:' && BROWSER_DOOR_HOSTS.test(url.hostname);
}

const CACHE_KEY = '__arena_resolver__';

interface ResolverState {
  /** The child the server started, when it started one. */
  child: ReturnType<typeof spawn> | null;
  /** When the server last found the resolver awake. */
  checkedAt: number;
  /** True while the server is waiting for a resolver to come up. */
  starting: boolean;
  /** The attempt to start a resolver that is running, when there is one. */
  startPromise: Promise<boolean> | null;
  /** The process the last answers came from. */
  pid: number;
  /** The addresses that were read, by the page they belong to. */
  readonly addresses: Map<string, { at: number; url: string }>;
}

function state(): ResolverState {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[CACHE_KEY] as Partial<ResolverState> | undefined;
  // The state lives on `globalThis` so that every route of the server shares
  // it - and the server is rebuilt from its own sources while it runs, in
  // development. A state of an older shape is not kept: it is replaced, and
  // what it knew is asked for again.
  if (existing && existing.addresses instanceof Map) return existing as ResolverState;
  const created: ResolverState = {
    child: null,
    checkedAt: 0,
    starting: false,
    startPromise: null,
    pid: 0,
    addresses: new Map(),
  };
  store[CACHE_KEY] = created;
  return created;
}

/**
 * The directory an address of the door sits in.
 *
 * The addresses carry a token in their path, and the token is what expires.
 * Everything below it - the network, the qualities, the playlists - is the
 * same from one token to the next, so the directory is what a token is
 * replaced by. It ends at the token and not at the playlist: a master and the
 * qualities below it are beside each other, not under each other, and they
 * all carry the same token.
 */
function doorDirectory(raw: string): string {
  try {
    const url = new URL(raw);
    const mark = url.pathname.indexOf('/secure/');
    if (mark >= 0) {
      const rest = url.pathname.slice(mark + '/secure/'.length);
      const slash = rest.indexOf('/');
      if (slash > 0) {
        return `${url.origin}${url.pathname.slice(0, mark + '/secure/'.length + slash + 1)}`;
      }
    }
    const cut = url.pathname.lastIndexOf('/');
    return `${url.origin}${url.pathname.slice(0, cut + 1)}`;
  } catch {
    return '';
  }
}

/**
 * The front of an address of the door: everything up to the network.
 *
 * An address of this door reads
 *
 *   /secure/<token>/<start>/<end>/<network>/<playlist>
 *
 * and the two parts of it move together: a page that is asked again hands
 * out a new token *and* a new window - the window is the event's own, and it
 * slides on as the event goes on. An address that keeps the old window under
 * the new token is refused, because the window it names is over.
 *
 * So the front is what a rotation replaces, and the network below it - the
 * channel's own name - is what stays.
 */
function doorPrefix(raw: string): string {
  try {
    const url = new URL(raw);
    const mark = url.pathname.indexOf('/secure/');
    if (mark < 0) return '';
    const rest = url.pathname.slice(mark + '/secure/'.length);
    const parts = rest.split('/');
    // token / start / end / network / ...
    if (parts.length < 4 || !parts[0] || !parts[2]) return '';
    const head = url.pathname.slice(0, mark + '/secure/'.length);
    return `${url.origin}${head}${parts[0]}/${parts[1]}/${parts[2]}/`;
  } catch {
    return '';
  }
}

/** Says what the resolver did, when the app is asked to be loud. */
function debug(message: string): void {
  if (process.env.ARENA_MEDIA_DEBUG !== '1') return;
  console.log(`[resolver] ${message}`);
}

/**
 * Asks the resolver whether it is awake.
 *
 * The answer is remembered for a moment: the server reads a playlist every
 * second, and a health check for every read would be a request of its own
 * for nothing.
 *
 * The process is remembered too. An address belongs to the resolver that
 * read it out of the page - the door knows that address - so when the
 * resolver is a different one, the addresses that were read are not read
 * any more and are forgotten.
 */
async function resolverPid(): Promise<number | null> {
  const current = state();
  if (current.checkedAt && Date.now() - current.checkedAt < AWAKE_TTL_MS) {
    return current.pid || null;
  }
  try {
    const response = await fetch(`${BASE}/health`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { ok?: boolean; pid?: number };
    if (payload.ok !== true) return null;
    const pid = Number(payload.pid ?? 0);
    if (pid && current.pid && pid !== current.pid) current.addresses.clear();
    current.pid = pid;
    current.checkedAt = Date.now();
    return pid || null;
  } catch {
    current.checkedAt = 0;
    return null;
  }
}

/** True when the resolver is there. */
export async function resolverAwake(): Promise<boolean> {
  return (await resolverPid()) !== null;
}

/**
 * The Electron binary of this checkout, when there is one.
 *
 * The app's own Electron process runs the resolver, so the server only has to
 * start one when it is running on its own - which is the case in development.
 * A packaged app has no binary to start, and does not need one.
 *
 * The binary is found without asking the `electron` package for it: that
 * package downloads a copy of electron when it cannot find its own, and the
 * app's server has no reason to download anything.
 */
function electronBinary(): string | null {
  const named = process.env.ARENA_RESOLVER_ELECTRON?.trim();
  if (named && existsSync(named)) return named;

  // The development server runs on the node that is built into electron, so
  // the program that is running it is the program that can open a window.
  if (!process.versions.electron) {
    // A server started on its own still has the checkout's electron in its
    // node_modules - the resolver is that browser, whatever process started
    // the server.
    const checkout = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
    if (existsSync(checkout)) return checkout;
    return null;
  }
  const execPath = process.execPath;
  if (!execPath || !existsSync(execPath)) return null;

  // A packaged app is not electron: it has its own resources, and running it
  // again would start a second copy of the app rather than a resolver.
  const resources = path.join(path.dirname(execPath), 'resources');
  if (!existsSync(path.join(resources, 'default_app.asar'))) return null;

  return execPath;
}

/**
 * Starts a resolver, when there is none and one can be started.
 *
 * The child is left running: the resolver is a service, and a service that
 * is started once per match would spend more time starting than working.
 *
 * A caller that arrives while the resolver is on its way waits for it rather
 * than giving up: the pages of one match are asked for at the same time, and
 * the second one must not be lost because the first one is starting the
 * resolver.
 */
export async function ensureResolver(): Promise<boolean> {
  const current = state();
  if (current.startPromise) return current.startPromise;

  const attempt = startResolver();
  current.startPromise = attempt;
  try {
    return await attempt;
  } finally {
    if (current.startPromise === attempt) current.startPromise = null;
  }
}

/** Starts a resolver and waits for it to answer. */
async function startResolver(): Promise<boolean> {
  const current = state();
  current.starting = true;
  try {
    if (await resolverAwake()) return true;

    const binary = electronBinary();
    if (!binary) {
      debug('there is no electron to start a resolver with');
      return false;
    }

    const script = path.join(process.cwd(), 'electron', 'embed-resolver.cjs');
    if (!existsSync(script)) {
      debug('the resolver is not in this checkout');
      return false;
    }

    /*
     * The resolver is a browser: it opens pages in a hidden window. The
     * development server runs on the node that is built into electron - and
     * that node asks its children to run as node too, which would leave the
     * resolver without a browser to open pages in.
     */
    const env: NodeJS.ProcessEnv = { ...process.env, ARENA_RESOLVER_PORT: String(PORT) };
    delete env.ELECTRON_RUN_AS_NODE;

    /*
     * The resolver is a service of its own, and it runs without a console:
     * what it says when it cannot start is written to a file of its own, so
     * that a resolver that did not come up can be looked at.
     */
    const logPath = path.join(os.tmpdir(), 'streamed-arena-resolver.log');
    let fd: number | null = null;
    try {
      fd = openSync(logPath, 'a');
    } catch {
      fd = null;
    }

    const child = spawn(binary, ['--disable-gpu', script], {
      cwd: process.cwd(),
      detached: true,
      stdio: ['ignore', 'ignore', fd ?? 'ignore'],
      windowsHide: true,
      env,
    });
    child.unref();
    current.child = child;

    const started = Date.now();
    while (Date.now() - started < START_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (await resolverAwake()) {
        debug('the resolver is up');
        return true;
      }
    }
    debug('the resolver did not come up');
    return false;
  } catch (error) {
    debug(`the resolver could not be started: ${error instanceof Error ? error.message : error}`);
    return false;
  } finally {
    current.starting = false;
  }
}

/**
 * The playlist behind a provider's page.
 *
 * The address is remembered for a moment. It belongs to the resolver that
 * read it, and the door knows it - so it is forgotten when the resolver is
 * another one, and asked for again when the feed stops answering.
 *
 * Returns null when the page cannot be resolved - the app then offers the
 * provider's own player instead, which plays the match as well.
 */
export async function resolverResolve(
  pageUrl: string,
  options: { fresh?: boolean } = {},
): Promise<string | null> {
  const current = state();
  if (!(await resolverAwake())) {
    if (!(await ensureResolver())) return null;
  }

  const known = current.addresses.get(pageUrl);
  if (!options.fresh && known && Date.now() - known.at < ADDRESS_TTL_MS) return known.url;

  try {
    const query = options.fresh ? '&fresh=1' : '';
    const response = await fetch(`${BASE}/resolve?url=${encodeURIComponent(pageUrl)}${query}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(ANSWER_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { url?: string };
    const url = typeof payload.url === 'string' ? payload.url.trim() : '';
    if (!url) return null;
    current.addresses.set(pageUrl, { at: Date.now(), url });
    return url;
  } catch {
    return null;
  }
}

/** Forgets a resolved address, so the next question asks the page again. */
export function forgetAddress(pageUrl: string): void {
  state().addresses.delete(pageUrl);
}

/**
 * Tells the resolver that an address has moved.
 *
 * The addresses of this door carry a token and a window, and both are what
 * expires. When they do, the resolver asks the page again and reads the new
 * address - so the answer comes from an address the app has never seen. The
 * app is told which one answered, and its own book of addresses is kept in
 * step: the token and the window in the address it holds are replaced by the
 * ones in the address that answered.
 */
export function noteBrowserDoor(from: string, to: string): void {
  const current = state();
  if (!from || !to || from === to) return;

  const fromPrefix = doorPrefix(from);
  const toPrefix = doorPrefix(to);
  if (!fromPrefix || !toPrefix || fromPrefix === toPrefix) return;

  for (const [page, entry] of current.addresses) {
    if (!entry.url.startsWith(fromPrefix)) continue;
    current.addresses.set(page, { at: entry.at, url: toPrefix + entry.url.slice(fromPrefix.length) });
  }
}

/**
 * The page whose address this one is, when the app knows it.
 *
 * The book of addresses is by the page they belong to, and an address of the
 * door says which directory - and so which token - it belongs to. The page
 * that handed out that token is the one to ask again.
 */
export function pageForAddress(url: string): string | null {
  const dir = doorDirectory(url);
  if (!dir) return null;
  for (const [page, entry] of state().addresses) {
    if (doorDirectory(entry.url) === dir) return page;
  }
  return null;
}

/**
 * The same address, under another token and another window.
 *
 * The address the app holds and the address that answered are the same
 * playlist with a different token and a different window in front of it - so
 * the answer is found by taking the front of the one and keeping the rest of
 * the other.
 */
export function movedAddress(from: string, to: string): string {
  const fromPrefix = doorPrefix(from);
  const toPrefix = doorPrefix(to);
  if (!fromPrefix || !toPrefix || fromPrefix === toPrefix) return from;
  return toPrefix + from.slice(fromPrefix.length);
}

/**
 * Asks the resolver to forget a page.
 *
 * The app asks for this when a feed stops answering: the address that page
 * handed out is dead, and the next question has to open the page again.
 */
export async function resolverForget(pageUrl: string): Promise<void> {
  if (!(await resolverAwake())) return;
  try {
    await fetch(`${BASE}/forget?url=${encodeURIComponent(pageUrl)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // The resolver is not there: the next question starts it again.
  }
}

export interface RelayedResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  /**
   * The address the answer came from.
   *
   * The door hands out addresses that carry a token, and the token expires.
   * When it does, the resolver asks the page again and reads the new
   * address - so the answer may come from a different address than the one
   * that was asked for. The address it came from is passed on, so the app
   * can keep its own book of addresses in step with the door's.
   */
  readonly source: string;
  /**
   * The page the answer came from, when the resolver knows it.
   *
   * The app cannot work the page out of an address itself - the token in the
   * address is what changes - so the resolver says which page handed the
   * address out. The app asks that page again when the address is refused.
   */
  readonly page: string | null;
}

/**
 * Reads an address with the browser's stack.
 *
 * Returns null when the resolver is not there: the caller then reads the
 * address the plain way, which is what every other door needs.
 */
export async function resolverFetch(
  url: string,
  options: { timeoutMs?: number } = {},
): Promise<RelayedResponse | null> {
  if (!(await resolverAwake())) {
    if (!(await ensureResolver())) return null;
  }

  const timeoutMs = options.timeoutMs ?? 15_000;
  try {
    const response = await fetch(`${BASE}/fetch?url=${encodeURIComponent(url)}`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const headers: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      headers[name] = value;
    });

    /*
     * The resolver answers with the door's own status: a refusal is a
     * refusal, and the app has to see it as one - it is the sign that the
     * token has expired and the page has to be opened again.
     *
     * The resolver's own failures are told apart by their shape: they are
     * an envelope of words, not the door's bytes.
     */
    const contentType = headers['content-type'] ?? '';
    if (contentType.includes('application/json')) {
      try {
        const payload = JSON.parse(body.toString('utf8')) as { error?: string };
        if (typeof payload.error === 'string') return null;
      } catch {
        return null;
      }
    }

    return {
      status: response.status,
      headers,
      body,
      source: headers['x-arena-source'] ?? url,
      page: headers['x-arena-page'] ?? null,
    };
  } catch {
    return null;
  }
}
