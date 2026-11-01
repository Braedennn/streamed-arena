// Sources the user brought themselves.
//
// The app can run without a third party at all: point it at a manifest URL
// and the personal server serves *that* - no provider, no mirrors, no
// third-party host anywhere in the path. The setting is read from the
// environment or from `personal-sources.json` next to the app:
//
//   {
//     "default": "https://example.com/live/index.m3u8",
//     "matches": {
//       "genoa-vs-lecce": "https://example.com/live/genoa/index.m3u8"
//     }
//   }
//
// A match without its own entry falls back to "default".

import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface PersonalSource {
  /** The manifest URL of the feed. */
  readonly url: string;
  /** The referer the host demands, when it demands one. */
  readonly referer?: string;
  /** A name for the source, shown in the server list. */
  readonly label?: string;
  /**
   * Where the source came from.
   *
   * `match` is a source the user set for this one match - the app serves
   * that and nothing else, so this match involves no third party at all.
   *
   * `default` is a fallback: the provider is used while it works, and this
   * source takes over when it does not.
   */
  readonly kind: 'match' | 'default';
}

interface PersonalSourceFile {
  readonly default?: unknown;
  readonly matches?: unknown;
  readonly referer?: unknown;
  readonly label?: unknown;
}

let cached: { at: number; sources: PersonalSourceFile | null } | null = null;
const CACHE_TTL_MS = 30_000;

function readEnv(): PersonalSourceFile | null {
  const single = process.env.ARENA_PERSONAL_SOURCE?.trim();
  if (single) return { default: single };

  const raw = process.env.ARENA_PERSONAL_SOURCES?.trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersonalSourceFile;
  } catch {
    return null;
  }
}

async function readFileConfig(): Promise<PersonalSourceFile | null> {
  const candidates = [
    process.env.ARENA_PERSONAL_SOURCES_FILE?.trim(),
    path.join(process.cwd(), 'personal-sources.json'),
  ].filter((entry): entry is string => Boolean(entry));

  for (const file of candidates) {
    try {
      const raw = await readFile(file, 'utf8');
      return JSON.parse(raw) as PersonalSourceFile;
    } catch {
      // No file, or a broken one - the environment can still have one.
    }
  }
  return null;
}

async function config(): Promise<PersonalSourceFile | null> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.sources;

  const sources = readEnv() ?? (await readFileConfig());
  cached = { at: now, sources };
  return sources;
}

/** The source the user configured for a match, if there is one. */
export async function personalSourceFor(streamKey: string): Promise<PersonalSource | null> {
  const file = await config();
  if (!file) return null;

  const matches = (file.matches ?? {}) as Record<string, unknown>;
  const own = typeof matches[streamKey] === 'string' ? (matches[streamKey] as string) : '';
  const fallback = typeof file.default === 'string' ? (file.default as string) : '';
  const url = (own || fallback).trim();
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  } catch {
    return null;
  }

  return {
    url,
    referer: typeof file.referer === 'string' ? file.referer : undefined,
    label: typeof file.label === 'string' ? file.label : undefined,
    kind: own.trim() ? 'match' : 'default',
  };
}

/** True when the app has been pointed at sources of its own. */
export async function hasPersonalSources(): Promise<boolean> {
  const file = await config();
  if (!file) return false;
  if (typeof file.default === 'string' && file.default.trim()) return true;
  const matches = (file.matches ?? {}) as Record<string, unknown>;
  return Object.values(matches).some((value) => typeof value === 'string' && value.trim());
}
