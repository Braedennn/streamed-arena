'use client';

import { readValue, writeValue } from '@/lib/store';

/**
 * The volume the user last chose.
 *
 * A new stream must not open at 100% — the first thing you hear should be
 * the level you left the last stream at, otherwise every game starts with a
 * blast. The value is kept in the app's settings store (see lib/store.ts), so
 * it survives a reload *and* a restart of the app — in the desktop app the
 * window is served from a port that changes with every launch, so the
 * browser's own storage would not do.
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

function fromRaw(parsed: unknown): VolumePreference {
  if (!parsed || typeof parsed !== 'object') return { ...DEFAULT };
  const record = parsed as Partial<VolumePreference>;
  return {
    volume: typeof record.volume === 'number' ? clamp(record.volume) : DEFAULT.volume,
    muted: Boolean(record.muted),
  };
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
    cached = fromRaw(JSON.parse(raw));
  } catch {
    // A broken or unreadable entry must never break playback.
    cached = { ...DEFAULT };
  }
  return cached;
}

/**
 * The remembered volume, read from the store that really holds it.
 *
 * In the desktop app the value lives in the app's own file, and asking for
 * it takes a moment — so the player waits for this instead of opening at
 * full volume and then jumping down.
 */
export async function loadVolumePreference(): Promise<VolumePreference> {
  const stored = await readValue<unknown>(STORAGE_KEY, null);
  if (stored === null || stored === undefined) return getVolumePreference();
  cached = fromRaw(stored);
  return cached;
}

/** Remembers the volume for the next stream. */
export function saveVolumePreference(preference: VolumePreference): void {
  cached = {
    volume: clamp(preference.volume),
    muted: Boolean(preference.muted),
  };
  writeValue(STORAGE_KEY, cached);
}
