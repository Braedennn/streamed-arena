// The disk cache of the personal server.
//
// The segments are kept on disk rather than in memory: one segment of a 1080p
// feed is about six megabytes, and a rolling window of them would be tens of
// megabytes per feed that the app does not have to sit on.
//
// The cache is a cache and nothing more - when the app closes, the files are
// left behind and the next run starts with an empty window. That is what
// keeps the personal server honest: what it serves is always what it has
// just fetched.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

/** Where the segments are kept. */
export function cacheRoot(): string {
  const configured = process.env.ARENA_MEDIA_CACHE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(tmpdir(), 'streamed-arena-media');
}

/**
 * A path component that can only ever be a name.
 *
 * The channel id and the segment name both come from outside the cache
 * (from a URL), so they are stripped down to characters that cannot walk out
 * of the cache directory.
 */
function safeComponent(raw: string): string {
  const clean = raw.replace(/[^a-zA-Z0-9._-]/g, '_');
  return clean && clean !== '.' && clean !== '..' ? clean.slice(0, 120) : '_';
}

const RUN_KEY = '__arena_media_run__';

/**
 * The run this process belongs to.
 *
 * The segments of one run live in a directory of their own. A file left
 * behind by an earlier run has the same name as a segment the feed publishes
 * again later - the upstream numbers its segments, and an app that starts
 * again sees the same numbers - so a cache that outlived its run could serve
 * yesterday's bytes as today's. Every run gets its own directory, and the
 * files of an earlier run are simply somewhere else.
 */
export function runId(): string {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[RUN_KEY];
  if (typeof existing === 'string' && existing) return existing;
  const created = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  store[RUN_KEY] = created;
  return created;
}

export function channelDir(channelId: string): string {
  return path.join(cacheRoot(), 'runs', runId(), safeComponent(channelId));
}

export function segmentPath(channelId: string, name: string): string {
  return path.join(channelDir(channelId), safeComponent(name));
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Writes a segment. The write is atomic: a half-written file is never served. */
export async function writeSegment(
  channelId: string,
  name: string,
  data: Buffer,
): Promise<void> {
  const dir = channelDir(channelId);
  await ensureDir(dir);
  const target = segmentPath(channelId, name);
  const partial = `${target}.part`;
  await writeFile(partial, data);
  await rename(partial, target);
}

/** Reads a segment, or null when it is not cached. */
export async function readSegment(channelId: string, name: string): Promise<Buffer | null> {
  try {
    return await readFile(segmentPath(channelId, name));
  } catch {
    return null;
  }
}

/** Drops every segment of a channel that is no longer wanted. */
export async function pruneChannel(
  channelId: string,
  keep: readonly string[],
): Promise<void> {
  const wanted = new Set(keep.map((name) => safeComponent(name)));
  try {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(channelDir(channelId));
    await Promise.all(
      entries
        .filter((entry) => !wanted.has(entry))
        .map((entry) => rm(path.join(channelDir(channelId), entry), { force: true })),
    );
  } catch {
    // Nothing cached yet, or the directory is gone - nothing to prune.
  }
}

/** Removes everything a channel cached. */
export async function dropChannel(channelId: string): Promise<void> {
  await rm(channelDir(channelId), { recursive: true, force: true });
}

/**
 * Empties a channel's directory before it is filled for the first time.
 *
 * The window of a channel starts empty every time the channel is created, so
 * the directory is emptied with it: what the server holds is what it fetched,
 * and never what somebody else left there.
 */
export async function purgeChannel(channelId: string): Promise<void> {
  await rm(channelDir(channelId), { recursive: true, force: true });
}

/** How long a run's cache is kept after the app stopped using it. */
const RUN_TTL_MS = 6 * 60 * 60 * 1_000;

/**
 * Removes the cache of runs that are long gone.
 *
 * Each run of the app gets its own directory, so the cache would grow by one
 * directory per run. A directory nobody has touched for hours belongs to an
 * app that is not running any more.
 *
 * The directories of the layout before the runs existed are removed as well:
 * nothing reads them any more, and they are the ones a stale segment could
 * still hide in.
 */
export async function pruneOldRuns(): Promise<void> {
  const { readdir, stat } = await import('node:fs/promises');
  const root = cacheRoot();
  const current = runId();
  const cutoff = Date.now() - RUN_TTL_MS;

  const sweep = async (dir: string, keep: string | null) => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (keep !== null && entry === keep) continue;
      const target = path.join(dir, entry);
      try {
        const info = await stat(target);
        if (!info.isDirectory()) continue;
        if (info.mtimeMs < cutoff) {
          await rm(target, { recursive: true, force: true });
        }
      } catch {
        // The directory is gone, or it cannot be read - either way there is
        // nothing to clean.
      }
    }
  };

  // The runs of the current layout...
  await sweep(path.join(root, 'runs'), current);
  // ...and the channels of the layout before it, which nothing reads.
  await sweep(root, 'runs');
}
