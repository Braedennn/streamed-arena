import { useSyncExternalStore } from 'react';
import { splitTitle } from '@/lib/utils';
import { readValue, writeValue } from '@/lib/store';
import type { Fixture } from '@/lib/types';

// Favorited teams are kept in a store that survives a restart of the app.
// Everything is keyed off normalized team names (the APIs only ever give us
// names, no stable ids).
//
// In the browser that is localStorage. In the desktop app it is the app's own
// file (see lib/store.ts): the window is served from a port that changes with
// every launch, so localStorage would be a different origin every morning and
// every star would be gone.

const STORAGE_KEY = 'streamed-arena.favorites';

export function normalizeTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function persist(favorites: readonly string[]) {
  writeValue(STORAGE_KEY, favorites);
}

function normalizeList(parsed: unknown): readonly string[] {
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map(normalizeTeamName);
}

function readFromStorage(): readonly string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return normalizeList(JSON.parse(raw));
  } catch {
    return [];
  }
}

const EMPTY: readonly string[] = [];
let hydrated = false;
let snapshot: readonly string[] = EMPTY;
/** The teams the user touched in this session - their word wins over the file. */
const touched = new Set<string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify() {
  for (const listener of listeners) listener();
}

// Hydrate exactly once. getSnapshot MUST return a stable identity until the
// store is written — re-reading storage (creating fresh array instances) on
// every call while the list is empty crashes React's useSyncExternalStore
// with "Maximum update depth exceeded" (#185) and takes down every page.
function ensureHydrated() {
  if (hydrated) return;
  hydrated = true;
  snapshot = readFromStorage();

  // The desktop app keeps the stars in a file of its own, because its
  // window is served from a port that changes with every launch. The stored
  // list is merged in — a star made in this session is never lost, and a
  // team the user unstarred here does not come back from the file.
  void readValue<unknown>(STORAGE_KEY, null).then((stored) => {
    const list = normalizeList(stored).filter((entry) => !touched.has(entry));
    if (list.length === 0) return;
    const merged = Array.from(new Set([...snapshot, ...list]));
    if (merged.length === snapshot.length) return;
    snapshot = merged;
    persist(merged);
    notify();
  });
}

function getSnapshot(): readonly string[] {
  ensureHydrated();
  return snapshot;
}

function getServerSnapshot(): readonly string[] {
  return EMPTY;
}

function writeFavorites(next: readonly string[]) {
  const unique = Array.from(new Set(next));
  snapshot = unique;
  persist(unique);
  notify();
}

export function toggleTeamFavorite(name: string) {
  const key = normalizeTeamName(name);
  if (!key) return;
  const favorites = getSnapshot();
  touched.add(key);
  writeFavorites(
    favorites.includes(key)
      ? favorites.filter((entry) => entry !== key)
      : [key, ...favorites],
  );
}

export interface Favorites {
  /** Normalized favorited team names, most recently added first. */
  readonly favorites: readonly string[];
  readonly isFavorite: (teamName: string | null | undefined) => boolean;
  readonly toggleFavorite: (teamName: string) => void;
}

export function useFavorites(): Favorites {
  const favorites = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const isFavorite = (teamName: string | null | undefined): boolean =>
    Boolean(teamName && favorites.includes(normalizeTeamName(teamName)));

  const toggleFavorite = (teamName: string): void => toggleTeamFavorite(teamName);

  return { favorites, isFavorite, toggleFavorite };
}

/** Both teams of a fixture as the boards would label them. */
export function fixtureTeamNames(fixture: Fixture): { home: string; away: string } {
  const fallback = splitTitle(fixture.title);
  return {
    home: fixture.home?.name ?? fallback.home,
    away: fixture.away?.name ?? fallback.away,
  };
}

export function fixtureHasFavorite(
  fixture: Fixture,
  favorites: readonly string[] | undefined,
): boolean {
  if (!favorites || favorites.length === 0) return false;
  const keys = new Set(favorites);
  const { home, away } = fixtureTeamNames(fixture);
  return (
    keys.has(normalizeTeamName(home)) ||
    keys.has(normalizeTeamName(away))
  );
}

/**
 * How far ahead a fixture counts as "about to go live".
 *
 * A starred team sits at the top of the boards while its match is on or
 * about to start. A match three days away is not about to start, and jumping
 * the queue for it would only bury the games that are actually on.
 */
export const PIN_AHEAD_MS = 6 * 60 * 60 * 1_000;

/** True when the fixture belongs at the top of the boards. */
export function isPinnedFixture(fixture: Fixture, now = Date.now()): boolean {
  if (fixture.status === 'ended') return false;
  if (fixture.status === 'live' || fixture.status === 'in-play') return true;
  return fixture.date - now <= PIN_AHEAD_MS;
}

/**
 * Favorites play first — but only while there is something to watch:
 * live, in-play and about-to-start fixtures pin; a match further out and
 * ended matches stay put. Stable, so favorites keep their relative order.
 */
export function pinFavoritesFirst<T extends Fixture>(
  items: readonly T[],
  favorites: readonly string[],
  now = Date.now(),
): T[] {
  if (favorites.length === 0) return [...items];
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const fixture of items) {
    if (isPinnedFixture(fixture, now) && fixtureHasFavorite(fixture, favorites)) pinned.push(fixture);
    else rest.push(fixture);
  }
  return [...pinned, ...rest];
}

/** Ranking helper for sort comparators: favorites (on or about to start) sort first. */
export function favoriteRank(
  fixture: Fixture,
  favorites: readonly string[],
  now = Date.now(),
): 0 | 1 {
  return isPinnedFixture(fixture, now) && fixtureHasFavorite(fixture, favorites) ? 0 : 1;
}
