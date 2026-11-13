// The pages that are watching a match.
//
// The app fetches a feed ahead of the player, and a feed nobody watches is a
// feed the app should not be pulling. The page says who is watching: it
// registers itself when the match is opened and says goodbye when the page
// is closed. The feed is pulled for as long as somebody is watching it.
//
// The registry lives on `globalThis` for the same reason the channel
// registry does: Next.js bundles every route separately, and a module-level
// map would give each route its own copy of it - a watcher registered by one
// route would be invisible to the route that has to stop the feed.

const REGISTRY_KEY = '__arena_watchers__';

/**
 * How long a watcher is silent before it is forgotten.
 *
 * A page that is closed without saying goodbye - a crash, a killed window -
 * leaves its name behind. The heartbeat is the proof of life: a page that
 * has not said anything for this long is gone, and the feed it was watching
 * is not pulled for it any more.
 */
export const WATCHER_TIMEOUT_MS = 45_000;

export interface Watcher {
  /** The match being watched. */
  readonly key: string;
  /** The page's own name - one page, one name. */
  readonly session: string;
  /** When the page last said anything. */
  lastSeen: number;
}

interface Registry {
  readonly watchers: Map<string, Watcher>;
}

function registry(): Registry {
  const global = globalThis as unknown as Record<string, unknown>;
  const existing = global[REGISTRY_KEY];
  if (existing) return existing as Registry;
  const created: Registry = { watchers: new Map() };
  global[REGISTRY_KEY] = created;
  return created;
}

function watcherId(key: string, session: string): string {
  return `${key}|${session}`;
}

/** Forgets the watchers that have gone quiet. */
export function pruneWatchers(): void {
  const now = Date.now();
  for (const [id, watcher] of registry().watchers) {
    if (now - watcher.lastSeen > WATCHER_TIMEOUT_MS) registry().watchers.delete(id);
  }
}

/**
 * Registers a page as watching a match.
 *
 * Returns true when the page is new - the first word of a watching page -
 * and false when this is the heartbeat of a page that is already watching.
 */
export function addWatcher(key: string, session: string): boolean {
  if (!key || !session) return false;
  pruneWatchers();
  const id = watcherId(key, session);
  const existing = registry().watchers.get(id);
  if (existing) {
    existing.lastSeen = Date.now();
    return false;
  }
  registry().watchers.set(id, { key, session, lastSeen: Date.now() });
  return true;
}

/** Says that a page stopped watching a match. */
export function removeWatcher(key: string, session: string): boolean {
  if (!key || !session) return false;
  return registry().watchers.delete(watcherId(key, session));
}

/** How many pages are watching a match. */
export function watcherCount(key: string): number {
  pruneWatchers();
  let count = 0;
  for (const watcher of registry().watchers.values()) {
    if (watcher.key === key) count += 1;
  }
  return count;
}
