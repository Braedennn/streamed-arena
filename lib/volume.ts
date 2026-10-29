'use client';

/**
 * The volume the user last chose.
 *
 * A new stream must not open at 100% — the first thing you hear should be
 * the level you left the last stream at, otherwise every game starts with a
 * blast. The value lives in localStorage (same pattern as the favourites
 * store), so it survives a reload and a restart of the app.
 *
 * The store hands out one stable object; it is replaced only when something
 * actually changes. A getter that built a fresh object on every call would
 * make React re-render forever.
 */

const STORAGE_KEY = 'streamed-arena.volume';

export interface VolumePreference {
  /** 0 … 1 */
  volume: number;
  muted: boolean;
}

const DEFAULT: VolumePreference = { volume: 1, muted: false };

let cached: VolumePreference | null = null;

function clamp(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT.volume;
  return Math.min(1, Math.max(0, value));
}

/**
 * The remembered volume. Safe to call during server rendering — there is no
 * storage there, so the default comes back.
 */
export function getVolumePreference(): VolumePreference {
  if (cached) return cached;
  if (typeof window === 'undefined') return DEFAULT;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cached = { ...DEFAULT };
      return cached;
    }
    const parsed = JSON.parse(raw) as Partial<VolumePreference>;
    cached = {
      volume: typeof parsed.volume === 'number' ? clamp(parsed.volume) : DEFAULT.volume,
      muted: Boolean(parsed.muted),
    };
  } catch {
    // A broken or unreadable entry must never break playback.
    cached = { ...DEFAULT };
  }
  return cached;
}

/** Remembers the volume for the next stream. */
export function saveVolumePreference(preference: VolumePreference): void {
  cached = {
    volume: clamp(preference.volume),
    muted: Boolean(preference.muted),
  };
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cached));
  } catch {
    // Storage may be full or disabled — the volume still works for this
    // session, it just will not be remembered.
  }
}
