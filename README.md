# Streamed Arena

A free, open-source live sports streaming platform with a native Windows desktop app. It aggregates
every live and upcoming match from the public [Streamed.pk API](https://streamed.pk/docs), layers
live box-score stats on top from ESPN's public API, and wraps it all in a black & red
neo-brutalist dark UI — shipped both as a website you can run yourself and as a self-contained
Windows installer (no Node.js required).

> Streamed Arena hosts no content of its own — it is a front-end for publicly available third-party
> streams. The bundled ad-blocking engine is [uBlock Origin](https://github.com/gorhill/uBlock)
> (GPLv3, © Raymond Hill & contributors).

## Features

- **Live dashboard** — stat strip, live billboard hero with kick-off countdown, fixture hub with
  live/upcoming tabs, and a marquee ticker of everything on air right now (15 s polling)
- **Watch pages** — every match gets its own `/watch/[id]` page: full-page player, server/channel
  switcher, and a live statline panel (score + clock, possession, shots, corners, cards, fouls,
  player leaders with headshots — via ESPN, no API key)
- **Multistream** — 4-screen wall at `/multistream`: search-to-add slots persisted in localStorage,
  per-slot channel switcher, and a fullscreen mode that spreads all feeds across the display
- **Adaptive HLS player** — HLS.js with ABR + low-latency mode, quality menu, PiP, fullscreen,
  reload/retry failover across source groups; embed mode for provider iframes
- **Built-in ad blocker** — full uBlock Origin 1.75 engine compiled into the desktop app:
  network filtering (EasyList/EasyPrivacy), cosmetic hiding and scriptlets against every page and
  embed iframe, plus a main-process popup/popunder shield (Alt → uBlock Origin → Open dashboard)
- **Schedule & sport pages** — upcoming fixtures grouped by day, per-sport channels with on-air and
  upcoming grids
- **Native Windows app** — Electron-packaged with an Inno Setup wizard installer: per-user install,
  Start Menu/Desktop shortcuts, in-place upgrades, proper uninstaller, custom red/black icon
- **Fast & light** — zero backdrop-filters/translucent layers, `content-visibility: auto` cards, one
  shared clock, React Query caching with hidden-tab polling pause, pruned API cache

## Download

Grab **`Streamed Arena Setup.exe`** from the
[Releases page](https://github.com/Braedennn/streamed-arena/releases), run it, done — no Node.js,
no dependencies, no admin rights. The app is fully portable too: the packaged folder in each release
can be copied anywhere and run directly.

## Run from source

```bash
npm install
npm run dev        # http://localhost:3000
```

| Script              | Purpose                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| `npm run dev`       | Development server                                                       |
| `npm run build`     | Production build (type + route check)                                    |
| `npm start`         | Serve the production build                                               |
| `npm run typecheck` | Strict TypeScript pass (`tsc --noEmit`)                                  |
| `npm run build:exe` | Package the site as a Windows desktop app (`release/Streamed Arena-win32-x64/`) |
| `npm run installer` | Compile the Windows Setup installer (`release/Streamed Arena Setup.exe`) |
| `npm run release`   | Both of the above in one go                                              |

`npm run build:exe` builds a standalone Next server (`BUILD_STANDALONE=1`) and packages it with
`@electron/packager`; at launch the Electron main process runs the embedded server through the
Electron binary itself (`ELECTRON_RUN_AS_NODE=1`) on a random free port, then opens a themed
1600x1000 window with custom minimize/maximize/close controls and drag-region header/ticker. A
themed splash screen (`electron/splash.html`) shows immediately at launch and hands off once the
main window is ready. External origins open in the system browser; a single-instance lock focuses
the existing window.
`npm run installer` requires [Inno Setup 6](https://jrsoftware.org/isinfo.php)
(`winget install JRSoftware.InnoSetup`).

To debug the packaged app: `ELECTRON_DEBUG_PORT=9223 "Streamed Arena.exe"`, then connect to
`http://127.0.0.1:9223`.

### Auto-update, signing & rollback

The desktop app keeps itself current from GitHub Releases (`electron/updater.cjs`). On launch —
and every 2 h after — it asks the Releases API for the latest tag; if it is newer than the running
build, the matching `Streamed.Arena.Setup.exe` downloads in the background into
`%APPDATA%\streamed-arena\updates` and a prompt offers **Restart to update** — the installer runs
silently (`/SILENT /UPDATE=1`), replaces the app and relaunches it. **Later** installs on the next
restart and leaves the update reachable from **Streamed Arena → Restart to install update**;
**Check for Updates…** force-checks anytime. Updates are full re-downloads — no deltas — and stale
payloads are deleted as soon as the running version catches up.

**Releases are signed.** `npm run release` produces `Streamed.Arena.Setup.exe.sig`: an Ed25519
signature over `<tag>:<sha256>` made with the private key at
`%USERPROFILE%\.streamed-arena\release-signing.pem` (generated on first run, **never committed —
back it up**). Clients verify every release against the public key committed in
`electron/release-key.json` and refuse anything that fails, so a compromised GitHub account cannot
push code to existing installs — publish whatever you like, it will not install. Both files must be
attached to every release. Signing starts with v1.4.0 (earlier clients take one unverified hop);
rollback only reaches signed releases.

**If a release turns out bad:**

1. **Quarantine** — mark the release as a *pre-release* on GitHub. Pre-releases are invisible to
   `/releases/latest`, so within one check cycle clients discard any downloaded copy and stop
   offering it.
2. **Rollback** — anyone already on the bad version uses
   **Streamed Arena → Roll Back to a Previous Version…** to download the previous signed release
   and silently roll back on restart. While rolled back, the fled-from release is not re-offered
   automatically until something newer ships.

The release tag must be `vX.Y.Z` matching `package.json`.

## iOS (sideload)

There is no App Store build. `.github/workflows/ios.yml` builds an **unsigned** `.ipa` on a GitHub
macOS runner (Actions tab -> "iOS build" -> Run workflow, or any push to `main`); download it from
the run's Artifacts, unzip, and install it with a sideloading tool (iloader "Import IPA", SideStore,
AltStore), which signs it with your own Apple ID.

The iOS app is the static export (`BUILD_MOBILE=1`) wrapped with Capacitor (`ios/`). uBlock Origin
only exists in the desktop app; on iOS a native shield in `ios/App/App/SceneDelegate.swift` drops
popups and whole-page redirects fired from stream embeds. Ads drawn inside an embed still show.

## Pages

| Route              | Content                                                                    |
| ------------------ | -------------------------------------------------------------------------- |
| `/`                | Dashboard: stat strip, live billboard hero, fixture hub (live/upcoming tabs) |
| `/live`            | Every live + in-play match, sport shelf filter, HD/SD + viewer tags        |
| `/schedule`        | Upcoming fixtures grouped by day (Today / Tomorrow / date)                 |
| `/sports/[sport]`  | Per-sport channel: on-air grid + upcoming grid (e.g. `/sports/football`)   |
| `/watch/[id]`      | Full-page watch experience: player, server/channel switcher, up-next rail  |
| `/multistream`     | 4-screen wall: search-to-add slots, per-slot channel switcher, fullscreen  |
| `/404`             | Styled "Off the board" not-found page                                      |

Shared shell (ticker, header with nav/search/category menu/live counter, footer) lives in the
`(site)` route group layout.

## Stack

- **Next.js 15 App Router** + React 19, TypeScript `strict` (+ `noUncheckedIndexedAccess`)
- **Tailwind CSS 3.4** design tokens, opaque surface tokens, pulse/marquee keyframes
- **Framer Motion** hero + dialog transitions (grid cards use plain CSS entrance animation)
- **Radix UI** dialog + tabs primitives, **Lucide** iconography, `cva` variants
- **TanStack Query v5** caching, polling, placeholder data, `useQueries` fan-out
- **HLS.js** adaptive bitrate, low-latency mode, quality menu, PiP, fullscreen
- **Electron 44** desktop shell, **uBlock Origin 1.75** net-filtering engine
- **Inter + Roboto Mono** via `next/font` (mono for counters, clocks, countdowns)

## Architecture

```
app/
  layout.tsx          root shell + metadata + Providers + FilterProvider
  providers.tsx       QueryClientProvider (client singleton)
  not-found.tsx       styled 404
  (site)/
    layout.tsx        ticker + header + footer (shared shell)
    page.tsx          dashboard: stat strip, hero, fixture hub
    live/page.tsx     live now board
    schedule/page.tsx upcoming grouped by day
    sports/[sport]/   per-sport page
    watch/[id]/       full-page watch experience
    multistream/page.tsx 4-screen wall (slots + fullscreen)
  globals.css         tokens, surface/skeleton utilities
lib/
  types.ts            Streamed API entities + derived domain types
  api.ts              fetch client (timeout, TTL cache, stale-if-error), image URL builders
  espn.ts             ESPN public API client: scoreboards, summaries, team-name matching, box-score parsing
  hooks.ts            sports / live / fixtures / streams / game-stats queries, countdown, debounce, useStreamSelection
  utils.ts            status derivation, kick-off formatting, sport fallbacks, streamKey
components/
  providers/          FilterProvider (shared search / sport / grid density state)
  layout/             Header (nav, search, category menu, live counter), Ticker, Footer
  hero/               HeroArena billboard + kick-off countdown + side rail
  fixtures/           FixtureHub tabs, SportsShelf, MatchCard, skeletons, empty state
  arena/              StreamSwitcher, HlsPlayer, IframePlayer, MultiStream (4-screen wall)
  watch/              ArenaWatch (player + switcher), GameStats (live statline + leaders)
  media/              SafeImage (lazy, blur placeholder, initials fallback)
  ui/                 button, badge, panel, tabs, dialog, menu primitives
electron/
  main.cjs            embedded server boot, window, popup shield, uBlock loading
  preload.cjs         IPC bridge for window controls
  extensions/netfilter/  bundled uBlock Origin (MV2, Electron-accommodated)
scripts/
  build-exe.mjs       @electron/packager wrapper
  make-installer.mjs  Inno Setup script generator + compiler (version injected from package.json)
```

## API mapping

| Concern            | Endpoint                                   | Client behaviour |
| ------------------ | ------------------------------------------ | ---------------- |
| Sports             | `GET /api/sports`                          | 30 min stale time, graceful fallback to built-in category list |
| Live matches       | `GET /api/matches/live`                    | poll every **15s**, drives live badges, hero, ticker |
| All fixtures       | `GET /api/matches/all`                     | poll every **30s**, merged with the live set, sorted for upcoming |
| Stream sources     | `GET /api/stream/:source/:id`              | 20s TTL, aggregated per match with `Promise.allSettled` multi-source resolver |
| Quality previews   | same stream endpoint                       | `useQueries` fan-out for the first 8 live cards (HD/SD + viewer tags) |
| Team badges        | `GET /api/images/badge/:id.webp`           | `next/image` optimizer + initials fallback |

Status is derived client-side: the live feed wins, everything in the future is `upcoming`,
matches started less than 3.5 h ago are `in-play`, older ones are `ended`.

## Player

1. **Embed mode** – provider `embedUrl` rendered in an unrestricted iframe (no `sandbox`,
   normal referrer) with a quick reload button; ads are stopped by the built-in uBlock Origin
   engine and the main-process popup shield.
2. **HLS mode** – any `.m3u8` source runs through HLS.js with
   ABR, low-latency config, quality selector, PiP and fullscreen.
3. **Failover** – server chips switch between `alpha…intel` source groups, channel rows switch
   language/quality, reload + retry paths cover fatal stream errors.
4. The `/watch/[id]` page uses one `useStreamSelection` hook
   (server + channel state, auto-select first stream, reset per match).
5. **Multistream** – `/multistream` builds a 4-screen wall: search-to-add slots (persisted in
   localStorage), per-slot channel switcher + remove, and a fullscreen mode that spreads all
   selected feeds across the whole display.
6. **Live game stats** – the watch area gets a statline panel for the specific game via ESPN's
   public API (no key, CORS open): Streamed.pk fixtures are matched to ESPN games by team-name
   scoring, then the box score streams in — score + live clock, team statline (possession, total
   shots, shots on target, corners, cards, fouls…, red-highlighting the leading side) and player
   leaders with headshots. The summary refreshes every **15 s**; scoreboards every 60 s. Sports
   without an ESPN scoreboard degrade to a graceful note.

## Design system

Black & red neo-brutalist dark minimal / flat high-tech:

- `#070405` canvas, cards `#100A0D`, elevated tiles `#180E12`, hover `#25161A` — 100% opaque,
  zero `backdrop-filter`, zero translucent panels, zero box shadows (crisp 1px borders instead:
  `#2B1518` default, `#472226` hover)
- Accents: `#FF2233` vivid red (live badges, watch CTAs), `#E0202F` deep red (active
  filters/tabs/nav), `#FF1744` crimson (alerts/errors) — all solid fills with black-on-accent text
- Inter for UI, Roboto Mono for numbers/counters/clocks; corners capped at 6px (`rounded-md`),
  circles only for pulse dots and avatars
- Marquee ticker bar, auto-sync chips, skeleton loaders that mirror card layouts
- Mobile-first: single-column cards, mobile nav pill row, horizontally scrolling sport shelf,
  zero horizontal overflow

## Performance

- Zero `backdrop-filter` layers (each one snapshots the page behind it), no poster/gradient
  overlay layers on cards or the hero — flat solid surfaces paint cheap and fast
- Grid cards are plain DOM with a CSS entrance animation and `content-visibility: auto`, so
  off-screen cards skip layout/paint entirely
- One shared clock (module-level interval + `useSyncExternalStore`) instead of a timer per countdown
- React Query `gcTime` 60 s, polling pauses while the tab is hidden, API response cache is pruned
  (128 entries / 30 min)
- `next/image` generated widths capped at 1080px with 1 h CDN cache

## License

The application code is released under the [MIT License](LICENSE). The bundled uBlock Origin
engine (`electron/extensions/netfilter/`) remains under its own GPLv3 license.
