// Embed storage isolator — runs in the MAIN world of every embed.st /
// rockyembed.st frame at document_start, before any player script.
//
// Multistream walls four third-party embeds side by side, and they all live on
// the same origins. Their players (jwplayer/Clappr) use first-party storage as
// a global channel — `jwplayer.mute`, `jwplayer.volume`, `jwplayer.quality`,
// a `clappr` instance-claim marker — so every instance's state depends on
// whichever instance wrote last: loading a new embed (a server change)
// broadcasts player state to every other stream and can cut their audio.
//
// This replaces localStorage/sessionStorage with a per-frame, in-memory
// implementation: each embedded player becomes an island. Cookies are left
// untouched — stream CDNs use them for session/anti-bot tokens. The cost is
// that embeds no longer remember per-origin preferences across reloads, which
// for parallel third-party players is exactly the point.

(() => {
  if (window.__arenaStorageIsolated) return;
  window.__arenaStorageIsolated = true;

  const makeStorage = () => {
    const map = new Map();
    return {
      getItem: (key) => {
        const value = map.get(String(key));
        return value === undefined ? null : value;
      },
      setItem: (key, value) => {
        map.set(String(key), String(value));
      },
      removeItem: (key) => {
        map.delete(String(key));
      },
      clear: () => {
        map.clear();
      },
      key: (index) => {
        const keys = Array.from(map.keys());
        return Number.isInteger(index) && index >= 0 && index < keys.length ? keys[index] : null;
      },
      get length() {
        return map.size;
      },
    };
  };

  const localStorageShim = makeStorage();
  const sessionStorageShim = makeStorage();

  for (const [property, shim] of [
    ['localStorage', localStorageShim],
    ['sessionStorage', sessionStorageShim],
  ]) {
    try {
      Object.defineProperty(window, property, {
        configurable: true,
        get: () => shim,
      });
    } catch {
      // A page that already locked the property down keeps the real storage —
      // degraded, never fatal.
    }
  }
})();
