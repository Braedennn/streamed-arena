'use client';

// The app's own settings store.
//
// In a browser a setting lives in localStorage, and that is exactly where it
// belongs. In the desktop app the window is served from
// http://127.0.0.1:<port>/ and the port is a free one picked at launch — so
// every launch is a *different origin*, and the browser throws the old
// origin's localStorage away with it. A starred team would be gone the next
// morning, and the remembered volume with it.
//
// The desktop app therefore keeps these values in a file of its own (the
// Electron main process owns it, see electron/main.cjs), and this module
// talks to whichever store is there: the app's file when it exists, the
// browser's localStorage everywhere else.
//
// The value is kept as JSON text in both places, so the file stays readable
// and the browser's storage keeps working exactly as it did.

interface StoreBridge {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    arenaStore?: StoreBridge;
  }
}

/** The desktop app's store, when the page runs inside it. */
function bridge(): StoreBridge | null {
  if (typeof window === 'undefined') return null;
  const candidate = window.arenaStore;
  if (!candidate) return null;
  if (typeof candidate.get !== 'function' || typeof candidate.set !== 'function') return null;
  return candidate;
}

/** True when the page runs inside the desktop app. */
export function hasAppStore(): boolean {
  return bridge() !== null;
}

/** Reads a JSON value out of the browser's localStorage. */
export function readLocal<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Writes a value everywhere it can be kept.
 *
 * The browser's storage is written synchronously, so a reload always finds
 * it. The app's file is written through the bridge; a failure there is not
 * worth reporting — the setting still works for this session.
 */
export function writeValue(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  const text = JSON.stringify(value);
  try {
    window.localStorage.setItem(key, text);
  } catch {
    // Storage may be full or disabled - the value still works for this
    // session, it just will not be remembered.
  }
  const store = bridge();
  if (!store) return;
  void Promise.resolve(store.set(key, text)).catch(() => undefined);
}

/**
 * Reads the stored value back.
 *
 * The browser's storage answers immediately. The app's file has to be asked
 * for, so this is a promise: the callback receives the stored value, or the
 * fallback when nothing is stored.
 */
export function readValue<T>(key: string, fallback: T): Promise<T> {
  const store = bridge();
  if (!store) return Promise.resolve(readLocal<T>(key, fallback));
  return Promise.resolve(store.get(key))
    .then((raw) => {
      if (raw === null || raw === undefined) return fallback;
      if (typeof raw !== 'string') return raw as T;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return fallback;
      }
    })
    .catch(() => fallback);
}
