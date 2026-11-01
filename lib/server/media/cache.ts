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

export function channelDir(channelId: string): string {
  return path.join(cacheRoot(), safeComponent(channelId));
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
