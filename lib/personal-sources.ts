'use client';

// The sources the user brought themselves - the page's side of them.
//
// The app hosts every stream itself. Where the bytes come from is the user's
// call: point the app at a feed you own and the app hosts that one, asking
// nobody else for it. This module talks to the app's own server about it -
// the same server that serves the media - so the page never talks to anyone
// else either.

export interface PersonalMatchSource {
  /** The match's stream key - the one in the app's own address. */
  readonly key: string;
  /** The manifest URL of the feed. */
  readonly url: string;
  readonly referer?: string | null;
  readonly label?: string | null;
}

export interface PersonalSources {
  /** True when the app has been pointed at sources of its own. */
  readonly configured: boolean;
  /** Where the setting comes from: the app's file, the environment, or nowhere. */
  readonly origin: 'env' | 'file' | 'none';
  /** The file the setting is kept in. */
  readonly file: string;
  /** The source used when a match has none of its own. */
  readonly default: string | null;
  readonly referer?: string | null;
  readonly label?: string | null;
  /**
   * The app on its own: no third party is contacted at all.
   *
   * The board comes from the scoreboards the app reads itself, the feed comes
   * from the broadcaster's own pages, and the sources are the user's own.
   */
  readonly strict?: boolean;
  /** True when the environment carries the switch, which wins over the file. */
  readonly strictFromEnvironment?: boolean | null;
  /** The source of every match that has one. */
  readonly matches: readonly PersonalMatchSource[];
}

async function readJson(response: Response): Promise<PersonalSources | null> {
  if (!response.ok) return null;
  try {
    return (await response.json()) as PersonalSources;
  } catch {
    return null;
  }
}

/** The configuration in force. */
export async function readPersonalSources(): Promise<PersonalSources | null> {
  try {
    const response = await fetch('/api/media/sources', { cache: 'no-store' });
    return await readJson(response);
  } catch {
    return null;
  }
}

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
  /** The app on its own: no third party is contacted at all. */
  readonly strict?: boolean | null;
}

/** Saves the configuration. */
export async function writePersonalSources(
  input: PersonalSourcesInput,
): Promise<PersonalSources | null> {
  try {
    const response = await fetch('/api/media/sources', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    return await readJson(response);
  } catch {
    return null;
  }
}

/** Removes the configuration. */
export async function removePersonalSources(): Promise<PersonalSources | null> {
  try {
    const response = await fetch('/api/media/sources', { method: 'DELETE' });
    return await readJson(response);
  } catch {
    return null;
  }
}

/** The source a match is played from, if it has one of its own. */
export function matchSource(
  sources: PersonalSources | null,
  key: string,
): PersonalMatchSource | null {
  return sources?.matches.find((entry) => entry.key === key) ?? null;
}
