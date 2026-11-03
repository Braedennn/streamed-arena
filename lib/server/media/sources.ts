// Sources the user brought themselves.
//
// The app can run without a third party at all: point it at a manifest URL
// and the personal server serves *that* - no provider, no mirrors, no
// third-party host anywhere in the path.
//
// The setting lives in a file of the app's own - `personal-sources.json` in
// the app's data directory (the desktop app points the server at it, see
// electron/main.cjs). It can also be given through the environment:
//
//   ARENA_PERSONAL_SOURCE       one manifest URL, used for every match
//   ARENA_PERSONAL_SOURCES      the same file, as JSON, in one variable
//   ARENA_PERSONAL_SOURCES_FILE where the file is (the app's data directory)
//
// The file looks like this:
//
//   {
//     "default": "https://example.com/live/index.m3u8",
//     "referer": "https://example.com/",
//     "label": "My own server",
//     "matches": {
//       "genoa-vs-lecce": "https://example.com/live/genoa/index.m3u8",
//       "milan-vs-roma": {
//         "url": "https://example.com/live/milan/index.m3u8",
//         "referer": "https://example.com/"
//       }
//     }
//   }
//
// A match with an entry of its own is served from that entry and from
// nowhere else - the provider is not asked for it at all. A match without one
// falls back to "default", and the default is used only when the provider's
// own doors stop answering.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

/** One source the user set for one match. */
export interface PersonalMatchSource {
  /** The match's stream key - the one in the app's own address. */
  readonly key: string;
  /** The manifest URL of the feed. */
  readonly url: string;
  /** The referer this host demands, when it demands one. */
  readonly referer?: string;
  /** A name for this source. */
  readonly label?: string;
}

/** Everything the user configured, in one shape. */
export interface PersonalSourcesConfig {
  /** The source used when a match has none of its own. */
  readonly default?: string;
  /** The source of every match that has one. */
  readonly matches: readonly PersonalMatchSource[];
  /** A referer the host demands, for every source. */
  readonly referer?: string;
  /** A name for the source, shown in the server list. */
  readonly label?: string;
}

/** Where the setting came from. */
export type PersonalSourcesOrigin = 'env' | 'file' | 'none';

interface RawEntry {
  readonly url?: unknown;
  readonly referer?: unknown;
  readonly label?: unknown;
}

interface RawConfig {
  readonly default?: unknown;
  readonly matches?: unknown;
  readonly referer?: unknown;
  readonly label?: unknown;
}

/** A stream key is a name - never a path, never a command. */
const KEY = /^[a-zA-Z0-9._%\-]{1,120}$/;

/** The file the setting is kept in. */
export function personalSourcesFilePath(): string {
  const configured = process.env.ARENA_PERSONAL_SOURCES_FILE?.trim();
  if (configured) return path.resolve(configured);
  return path.join(process.cwd(), 'personal-sources.json');
}

/** A manifest URL, or nothing when it is not one. */
function normalizeUrl(value: unknown): string {
  if (typeof value !== 'string') return '';
  const url = value.trim();
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
  } catch {
    return '';
  }
  return url;
}

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text ? text : undefined;
}

/** Reads one entry of the "matches" table, whatever shape it arrives in. */
function readEntry(value: unknown): { url: string; referer?: string; label?: string } | null {
  if (typeof value === 'string') {
    const url = normalizeUrl(value);
    return url ? { url } : null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entry = value as RawEntry;
  const url = normalizeUrl(entry.url);
  if (!url) return null;
  return {
    url,
    referer: optionalText(entry.referer),
    label: optionalText(entry.label),
  };
}

/** Brings a raw configuration into the shape the app works with. */
export function normalizePersonalSources(raw: RawConfig | null): PersonalSourcesConfig {
  if (!raw) return { matches: [] };

  const matches: PersonalMatchSource[] = [];
  const table = raw.matches;
  if (table && typeof table === 'object' && !Array.isArray(table)) {
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (!KEY.test(key)) continue;
      const entry = readEntry(value);
      if (!entry) continue;
      matches.push({ key, ...entry });
    }
  }

  const fallback = normalizeUrl(raw.default);
  const referer = optionalText(raw.referer);
  const label = optionalText(raw.label);

  return {
    default: fallback || undefined,
    matches,
    referer,
    label,
  };
}

/* ------------------------------------------------------------------ */
/* Reading                                                              */
/* ------------------------------------------------------------------ */

const CACHE_KEY = '__arena_personal_sources__';
const CACHE_TTL_MS = 5_000;

interface CacheEntry {
  readonly at: number;
  readonly origin: PersonalSourcesOrigin;
  readonly config: PersonalSourcesConfig;
}

/**
 * The cache lives on `globalThis`.
 *
 * Next.js bundles every route separately, so a module-level variable would
 * give each route its own copy - and a source saved through one route would
 * stay invisible to the others for as long as their copy was warm.
 */
function cache(): CacheEntry | null {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[CACHE_KEY];
  return existing && typeof existing === 'object' ? (existing as CacheEntry) : null;
}

function setCache(entry: CacheEntry): void {
  const store = globalThis as unknown as Record<string, unknown>;
  store[CACHE_KEY] = entry;
}

/** Forgets the cached configuration - the next read goes to the file. */
export function invalidatePersonalSources(): void {
  const store = globalThis as unknown as Record<string, unknown>;
  delete store[CACHE_KEY];
}

function readEnv(): { origin: PersonalSourcesOrigin; raw: RawConfig | null } {
  const single = process.env.ARENA_PERSONAL_SOURCE?.trim();
  if (single) return { origin: 'env', raw: { default: single } };

  const raw = process.env.ARENA_PERSONAL_SOURCES?.trim();
  if (!raw) return { origin: 'none', raw: null };
  try {
    return { origin: 'env', raw: JSON.parse(raw) as RawConfig };
  } catch {
    return { origin: 'none', raw: null };
  }
}

async function readFileConfig(): Promise<{ origin: PersonalSourcesOrigin; raw: RawConfig | null }> {
  try {
    const raw = await readFile(personalSourcesFilePath(), 'utf8');
    return { origin: 'file', raw: JSON.parse(raw) as RawConfig };
  } catch {
    // No file, or a broken one - the environment can still have one.
    return { origin: 'none', raw: null };
  }
}

/**
 * The configuration in force, and where it came from.
 *
 * The environment wins over the file: a source that was handed to the app on
 * the command line is an instruction, and the file is a preference.
 */
export async function personalSources(): Promise<{
  readonly origin: PersonalSourcesOrigin;
  readonly config: PersonalSourcesConfig;
}> {
  const cached = cache();
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { origin: cached.origin, config: cached.config };
  }

  const env = readEnv();
  const source = env.origin === 'env' ? env : await readFileConfig();
  const entry: CacheEntry = {
    at: Date.now(),
    origin: source.origin,
    config: normalizePersonalSources(source.raw),
  };
  setCache(entry);
  return { origin: entry.origin, config: entry.config };
}

/** The source the user configured for a match, if there is one. */
export async function personalSourceFor(streamKey: string): Promise<PersonalSource | null> {
  const { config } = await personalSources();
  const own = config.matches.find((entry) => entry.key === streamKey);

  if (own) {
    return {
      url: own.url,
      referer: own.referer ?? config.referer,
      label: own.label ?? config.label,
      kind: 'match',
    };
  }

  if (config.default) {
    return {
      url: config.default,
      referer: config.referer,
      label: config.label,
      kind: 'default',
    };
  }

  return null;
}

/** True when the app has been pointed at sources of its own. */
export async function hasPersonalSources(): Promise<boolean> {
  const { config } = await personalSources();
  if (config.default) return true;
  return config.matches.length > 0;
}

/* ------------------------------------------------------------------ */
/* Writing                                                              */
/* ------------------------------------------------------------------ */

export interface PersonalSourcesInput {
  readonly default?: string | null;
  readonly matches?: readonly {
    readonly key: string;
    readonly url: string;
    readonly referer?: string | null;
    readonly label?: string | null;
  }[];
  readonly referer?: string | null;
  readonly label?: string | null;
}

/**
 * Saves the configuration to the app's file.
 *
 * The file is written whole and atomically: a crash halfway through cannot
 * leave a half-written configuration behind. When the environment carries a
 * source, that one keeps winning - the file is written all the same, so it is
 * there the moment the environment is gone.
 */
export async function savePersonalSources(
  input: PersonalSourcesInput,
): Promise<PersonalSourcesConfig> {
  const matches: PersonalMatchSource[] = [];
  for (const entry of input.matches ?? []) {
    const key = entry.key.trim();
    const url = normalizeUrl(entry.url);
    if (!KEY.test(key) || !url) continue;
    const referer = optionalText(entry.referer);
    const label = optionalText(entry.label);
    matches.push({
      key,
      url,
      ...(referer ? { referer } : {}),
      ...(label ? { label } : {}),
    });
  }

  const raw: Record<string, unknown> = {};
  const fallback = normalizeUrl(input.default);
  if (fallback) raw.default = fallback;
  if (matches.length > 0) {
    const table: Record<string, unknown> = {};
    for (const entry of matches) {
      table[entry.key] =
        entry.referer || entry.label
          ? { url: entry.url, referer: entry.referer, label: entry.label }
          : entry.url;
    }
    raw.matches = table;
  }
  const referer = optionalText(input.referer);
  if (referer) raw.referer = referer;
  const label = optionalText(input.label);
  if (label) raw.label = label;

  const target = personalSourcesFilePath();
  await mkdir(path.dirname(target), { recursive: true });
  // The write is atomic: a crash halfway through cannot leave a half-written
  // configuration behind.
  const temporary = `${target}.tmp`;
  await writeFile(temporary, JSON.stringify(raw, null, 2), 'utf8');
  await rename(temporary, target);

  invalidatePersonalSources();
  const { config } = await personalSources();
  return config;
}

/** Removes the configuration from the app's file. */
export async function clearPersonalSources(): Promise<void> {
  await rm(personalSourcesFilePath(), { force: true });
  invalidatePersonalSources();
}
