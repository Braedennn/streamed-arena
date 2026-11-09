// The sources the user brought themselves.
//
// The app hosts the stream itself: it fetches the media ahead of the player,
// keeps it on disk and serves it from its own server. Where those bytes come
// from is the app's business, and the user can say so - point the app at a
// feed they own and the app hosts *that*, asking nobody else for it.
//
// This is the window into that setting: the configuration in force, where it
// lives, and the writing of it.
//
//   GET    /api/media/sources
//   POST   /api/media/sources   { default?, matches?, referer?, label? }
//   DELETE /api/media/sources
//
// The answer names the app's own file. It never names a provider: a source of
// the user's own is the user's own, and the app does not talk about anything
// else.

import {
  clearPersonalSources,
  hasPersonalSources,
  personalSources,
  personalSourcesFilePath,
  savePersonalSources,
} from '@/lib/server/media/sources';
import { resetAllStreams, resetStream } from '@/lib/server/media/ingest';
import { strictModeFromEnvironment } from '@/lib/server/mode';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KEY = /^[a-zA-Z0-9._%\-/]{1,160}$/;

interface MatchEntry {
  readonly key: string;
  readonly url: string;
  readonly referer?: string;
  readonly label?: string;
}

function isUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** Reads the "matches" table, whichever shape it arrives in. */
function readMatches(value: unknown): MatchEntry[] | null {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    if (typeof value !== 'object') return null;
    const table = value as Record<string, unknown>;
    const entries: MatchEntry[] = [];
    for (const [key, raw] of Object.entries(table)) {
      if (!KEY.test(key)) return null;
      if (typeof raw === 'string') {
        if (!isUrl(raw)) return null;
        entries.push({ key, url: raw.trim() });
        continue;
      }
      if (!raw || typeof raw !== 'object') return null;
      const entry = raw as { url?: unknown; referer?: unknown; label?: unknown };
      if (!isUrl(entry.url)) return null;
      entries.push({
        key,
        url: entry.url.trim(),
        referer: typeof entry.referer === 'string' ? entry.referer : undefined,
        label: typeof entry.label === 'string' ? entry.label : undefined,
      });
    }
    return entries;
  }

  const entries: MatchEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as { key?: unknown; url?: unknown; referer?: unknown; label?: unknown };
    if (typeof entry.key !== 'string' || !KEY.test(entry.key.trim())) return null;
    if (!isUrl(entry.url)) return null;
    entries.push({
      key: entry.key.trim(),
      url: entry.url.trim(),
      referer: typeof entry.referer === 'string' ? entry.referer : undefined,
      label: typeof entry.label === 'string' ? entry.label : undefined,
    });
  }
  return entries;
}

async function describe() {
  const { origin, config } = await personalSources();
  const fromEnvironment = strictModeFromEnvironment();
  return {
    configured: await hasPersonalSources(),
    origin,
    file: personalSourcesFilePath(),
    default: config.default ?? null,
    referer: config.referer ?? null,
    label: config.label ?? null,
    /**
     * The app on its own: no third party is contacted at all.
     *
     * `strictFromEnvironment` says that the switch is carried by the
     * environment - and the environment wins, so the switch in the file is
     * not in force while it is there.
     */
    strict: fromEnvironment ?? config.strict === true,
    strictFromEnvironment: fromEnvironment,
    matches: config.matches.map((entry) => ({
      key: entry.key,
      url: entry.url,
      referer: entry.referer ?? null,
      label: entry.label ?? null,
    })),
  };
}

function fail(message: string, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function GET() {
  try {
    return Response.json(await describe(), { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed';
    return fail(message, 500);
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail('The body is not JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return fail('The body is not an object.');
  }

  const input = body as {
    default?: unknown;
    matches?: unknown;
    referer?: unknown;
    label?: unknown;
    strict?: unknown;
  };

  const matches = readMatches(input.matches);
  if (matches === null) return fail('A match source is not a valid manifest URL.');

  if (input.default !== undefined && input.default !== null && input.default !== '') {
    if (!isUrl(input.default)) return fail('The default source is not a valid manifest URL.');
  }
  if (
    input.referer !== undefined &&
    input.referer !== null &&
    input.referer !== '' &&
    typeof input.referer !== 'string'
  ) {
    return fail('The referer is not text.');
  }
  if (
    input.label !== undefined &&
    input.label !== null &&
    input.label !== '' &&
    typeof input.label !== 'string'
  ) {
    return fail('The label is not text.');
  }
  if (
    input.strict !== undefined &&
    input.strict !== null &&
    typeof input.strict !== 'boolean'
  ) {
    return fail('The switch is not a yes or a no.');
  }

  const before = await personalSources();
  const beforeUrls = new Map(before.config.matches.map((entry) => [entry.key, entry.url]));
  const strictBefore = before.config.strict === true;

  try {
    await savePersonalSources({
      default: typeof input.default === 'string' ? input.default : null,
      matches: matches.map((entry) => ({
        key: entry.key,
        url: entry.url,
        referer: entry.referer ?? null,
        label: entry.label ?? null,
      })),
      referer: typeof input.referer === 'string' ? input.referer : null,
      label: typeof input.label === 'string' ? input.label : null,
      // A question that does not mention the switch leaves it as it was.
      strict:
        typeof input.strict === 'boolean' ? input.strict : before.config.strict === true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed';
    return fail(`The configuration could not be saved: ${message}`, 500);
  }

  // A match whose source changed is hosted again from scratch: the segments
  // on the disk belong to the old source and must never be served as if they
  // belonged to the new one. The matches that did not change are left alone.
  const after = await personalSources();
  const changed = new Set<string>();
  for (const entry of after.config.matches) {
    if (beforeUrls.get(entry.key) !== entry.url) changed.add(entry.key);
  }
  for (const key of beforeUrls.keys()) {
    if (!after.config.matches.some((entry) => entry.key === key)) changed.add(key);
  }
  for (const key of changed) {
    try {
      await resetStream(key);
    } catch {
      // The match is re-hosted the next time it is asked for.
    }
  }

  // The way the app reaches the media changed: everything that was hosted is
  // thrown away, so no segment of the old way is ever served as if it were
  // part of the new one.
  if (strictBefore !== (after.config.strict === true)) {
    try {
      await resetAllStreams();
    } catch {
      // The matches are re-hosted the next time they are asked for.
    }
  }

  return Response.json(await describe(), { headers: { 'cache-control': 'no-store' } });
}

export async function DELETE() {
  const before = await personalSources();
  try {
    await clearPersonalSources();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed';
    return fail(`The configuration could not be removed: ${message}`, 500);
  }
  for (const entry of before.config.matches) {
    try {
      await resetStream(entry.key);
    } catch {
      // The match is re-hosted the next time it is asked for.
    }
  }
  return Response.json(await describe(), { headers: { 'cache-control': 'no-store' } });
}
