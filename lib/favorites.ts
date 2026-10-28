import { useSyncExternalStore } from 'react';
import { splitTitle } from '@/lib/utils';
import type { Fixture } from '@/lib/types';

// Favorited teams live in localStorage. Everything is keyed off normalized
// team names (the APIs only ever give us names, no stable ids).

const STORAGE_KEY = 'streamed-arena.favorites';

export function normalizeTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

function persist(favorites: readonly string[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(favorites));
  } catch {
    // Private mode / disabled storage — favorites stay in-memory only.
  }
}

function readFromStorage(): readonly string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(normalizeTeamName);
  } catch {
    return [];
  }
}

const EMPTY: readonly string[] = [];
let hydrated = false;
let snapshot: readonly string[] = EMPTY;
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
 * Favorites play first — but only while there is something to watch:
 * live, in-play and soon-to-start fixtures pin; ended matches stay put.
 * Stable, so favorites keep their relative order.
 */
export function pinFavoritesFirst<T extends Fixture>(
  items: readonly T[],
  favorites: readonly string[],
): T[] {
  if (favorites.length === 0) return [...items];
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const fixture of items) {
    if (fixture.status !== 'ended' && fixtureHasFavorite(fixture, favorites)) pinned.push(fixture);
    else rest.push(fixture);
  }
  return [...pinned, ...rest];
}

/** Ranking helper for sort comparators: favorites (not ended) sort first. */
export function favoriteRank(fixture: Fixture, favorites: readonly string[]): 0 | 1 {
  return fixture.status !== 'ended' && fixtureHasFavorite(fixture, favorites) ? 0 : 1;
}
