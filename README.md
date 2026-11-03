# Streamed Arena

[![Latest release](https://img.shields.io/github/v/release/Braedennn/streamed-arena?label=download&color=E0202F)](https://github.com/Braedennn/streamed-arena/releases/latest)
[![License MIT](https://img.shields.io/badge/license-MIT-E0202F)](LICENSE)
[![Windows installer](https://img.shields.io/badge/platform-Windows-2B1518?logo=electron&logoColor=white)](https://github.com/Braedennn/streamed-arena/releases/latest)

A free, open-source live sports streaming platform with a native Windows desktop app.

It does not just hand you a third-party embed, and it does not hand you somebody else's
"servers" either. **The app is the provider.** For every match the app resolves the feed
itself, **fetches the media ahead of the player, publishes a playlist of its own and serves
the segments from its own disk** — so the player only ever talks to this app, no third-party
host is ever named to it, and the provider's edge is never in the player's critical path.
The page never learns a provider's address at all: the fixture list is served by the app's own
server too, with the provider's media doors scrubbed out of the answer. Live box-score stats
are layered on top from ESPN's public API, and it all ships as a website you can run yourself
*and* as a self-contained Windows installer (no Node.js required).

> Streamed Arena hosts no content of its own — it is a front-end for publicly available third-party
> streams. The bundled ad-blocking engine is [uBlock Origin](https://github.com/gorhill/uBlock)
> (GPLv3, © Raymond Hill & contributors).
>
> Want no third party at all? Point the app at your own feeds — see
> [Your own sources](#your-own-sources).

## How it hosts a stream

1. **Resolve** — the app reads the match's source matrix (qualities × source slots × CDN backends)
   and builds the full list of candidate feeds itself.
2. **Measure** — every candidate is measured: HTTP latency, newest-segment availability and the
   **age of the newest segment** (that is the real live-edge lag, not a ping).
3. **Host** — the app's own server takes over the feed: it reads the upstream playlist on a loop,
   **downloads the segments as they appear** and keeps them on disk. The provider's doors are
   used here, behind the scenes, and the server moves to the next one by itself when the current
   one stops answering.
4. **Publish** — the app writes a playlist of its own: a gapless window of the segments it
   actually holds, in stream order, pointing at this app and nothing else.
5. **Serve** — the player pulls the playlist and the segments from the app. They are answered
   from the disk in milliseconds, because they were fetched a moment ago instead of being
   fetched while the player waits for them.
6. **Stay put** — the health check refreshes every 30 s, but the feed under you never changes
   because of it. Only a real failure swaps the server, and the previous one is marked failed.

### What this does and does not fix

The old server list was the provider's own doors — the CDN, the origin and the mirror. Those
are the same files on the same machines, so the list *looked* like a choice between servers and
was really one server with three names. It is gone: the list now shows the servers the app
runs.

Two different kinds of delay are involved, and only one of them was ever ours to fix:

- **The feed's own delay.** If the feed behind the provider is thirty seconds behind the
  stadium, every copy of it is thirty seconds behind too — a mirror, an edge and a personal
  server alike. The app cannot beat that, and the lag badge in the server list tells the truth
  about it instead of pretending.
- **The delivery delay.** This is the part that made the picture freeze: the provider's edge
  had to answer *while the player waited*, and the wait was the freeze. The app now fetches
  ahead, so the edge is never in the player's way. On top of that the player keeps a **30-second
  buffer** and sits a few segments behind the edge — the buffer is filled before it is needed,
  so a hiccup upstream costs nothing on the screen.

Measured on the same feed and the same minute, a segment that took **600–2600 ms** to arrive
from the provider's edge is served from the app's disk in **20–100 ms**.


### Before the whistle

A match that has not started yet has **no media at all** — the feed has not been switched on. The
app knows the difference between that and a broken feed, because the feed says so twice
(`live_sources` in the feed's list and the `IS_LIVE` flag on the feed's own page):

- the server list says *"The feed has not started yet"* instead of pretending the resolver failed
- the page keeps checking (every 15 s) and **starts hosting the feed by itself** the moment
  it goes live — no reload, no clicking through the embed player
- nothing is fetched until there is something to fetch, so an idle watch page costs one cheap
  check rather than two dozen requests

Matches the provider hosts on a third-party site are resolved too: the app follows the provider's
own pointer to the external manifest and hosts that one the same way.

## Your own sources

The app can be pointed at feeds of your own — then it involves **no third party at all** for
those matches. The setting can be written in three ways:

- **In the app** — the tower button in the header (*Your own sources*). It writes the setting
  through the app's own server into the app's data directory, so it is there for every launch and
  for every user of the app. The watch page has the same switch for the match you are looking at.
- **In a file** — `personal-sources.json` next to the app. The desktop app keeps it in its own
  data directory (`%APPDATA%\streamed-arena\personal-sources.json`); `personal-sources.example.json`
  is the template.
- **Through the environment** — `ARENA_PERSONAL_SOURCE` (one URL), `ARENA_PERSONAL_SOURCES` (the
  JSON below) or `ARENA_PERSONAL_SOURCES_FILE` (where the file is). The environment wins over the
  file: a source that was handed to the app on the command line is an instruction.

```json
{
  "matches": {
    "genoa-vs-lecce": "https://your.host/genoa/index.m3u8",
    "milan-vs-roma": {
      "url": "https://your.host/milan/index.m3u8",
      "referer": "https://your.host/"
    }
  },
  "default": "https://your.host/live/index.m3u8",
  "referer": "https://your.host/",
  "label": "My feed"
}
```

- A **match** entry replaces that match completely: the app serves it and asks nobody else — not
  for the playlist, not for a token, not for anything.
- A **default** entry is a fallback: the feed the app can find is used while it works, the default
  takes over when it does not.
- A match with a source of its own does not have to be on anybody's board: open
  `/watch?id=<the name you gave it>` and the app hosts it and plays it.

The app's own server treats a source of yours exactly like any other feed: it fetches ahead of
the player, publishes its own playlist and serves the media. `GET /api/media/sources` shows the
setting in force and where it is kept.

### Tuning the personal server

| Variable                   | Default | What it does                                     |
| -------------------------- | ------- | ------------------------------------------------ |
| `ARENA_MEDIA_CACHE`        | system temp | Where the fetched segments are kept          |
| `ARENA_INGEST_POLL_MS`     | `1000`  | How often the upstream playlist is read         |
| `ARENA_INGEST_PREFETCH`    | `6`     | How many segments are fetched ahead of the player   |
| `ARENA_INGEST_KEEP`        | `16`    | How many segments are kept on disk (8 are published) |
| `ARENA_INGEST_IDLE_TTL_MS` | `180000` | How long a feed keeps being fetched after the last request |
| `ARENA_MEDIA_DEBUG`        | –       | `1` logs what the server is doing               |

The player is tuned for the same reason the server is: the media comes out of the app's own disk,
so chasing the live edge buys nothing and costs stalls. hls.js sits a few segments behind the edge
with a **30-second buffer** (`liveSyncDurationCount: 4`, `maxBufferLength: 30`) instead of running
in low-latency mode, and the server keeps six segments in front of the player — the buffer is
filled before it is needed, which is what stops the picture from freezing.

Each run of the app writes into a cache directory of its own, and a segment is only ever served
when the app fetched it in this run: a file left behind by an earlier run can never be handed to
the player as if it were live.

`GET /api/media/status` shows what the server is doing right now: which feeds it hosts, how far
behind the live edge each one is, how many segments it holds and what went wrong.


## Features

- **Live dashboard** — stat strip, live billboard hero with kick-off countdown, fixture hub with
  live/upcoming tabs, and a marquee ticker of everything on air right now (15 s polling)
- **Favorite teams** — star any team and its fixtures pin to the top of every board while the game
  is on or about to kick off (favorite fixtures also claim the home-page hero); stars live on the
  match cards and the watch page, and they survive a restart of the app
- **Watch pages** — every match gets its own `/watch/[id]` page: full-page player, server
  switcher, and a live statline panel (score + clock, possession, shots, corners, cards, fouls,
  player leaders with headshots — via ESPN, no API key)
- **Personal servers** — the app **hosts the feed itself**: it resolves the match's source
  matrix, measures every candidate, then fetches the media ahead of the player, publishes a
  playlist of its own and serves the segments from its own disk. The server list shows the
  servers the app runs — no third-party host is ever named to the player — ranked by measured
  live-edge lag, and a dead feed is swapped out automatically mid-playback
- **One player, the app's own** — the watch page and every multistream tile play the app's
  server and nothing else: there is no provider iframe to fall back to, and no provider playlist
  is ever handed to the player. If the provider has no video for a match yet, the app says so
  and keeps looking by itself
- **Own sources** — point the app at feeds of your own (the header's *Your own sources* panel, a
  file, or the environment) and those matches involve no third party at all; the app hosts them
  exactly the same way, and a match of your own can be watched even when it is on nobody's board
- **Sticky playback** — the health check refreshes every 30 s and the ranking moves as the lag
  shifts, but the feed under you never changes because of it. A stream URL keeps a stable address
  (the server is addressed by name, not by a rotating token), so the player never restarts
  itself mid-match
- **Starts itself** — a match that is not on air yet is reported as *"the feed has not started"*,
  not as a failure, and the watch page keeps checking and flips to the app's own server the moment
  the provider switches the feed on
- **Multistream** — 4-screen wall at `/multistream`: search-to-add slots persisted with the rest
  of your settings, per-tile server switcher, and a fullscreen mode that spreads all feeds
  across the display
- **Adaptive HLS player** — HLS.js with ABR, quality menu, PiP, fullscreen, a 30-second buffer
  (the media is served from the app's own disk, so there is nothing to gain from chasing the
  live edge), reload/retry failover across the app's own servers, an idle-hiding control bar
  (it fades out after 3 s and takes the cursor with it) and a volume that carries over from the
  last stream you watched
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
| `npm run check:resolver` | Regression check of the resolver (no network needed)                |
| `npm run check:personal-server` | End-to-end check of the app's own server (needs a running app) |
| `npm run check:media` | Checks the media path: the app serves the bytes itself (needs a running app) |
| `npm run check:sources` | Checks the sources the user brought themselves (needs a running app) |
| `npm run check:provider` | Checks the packaged app: the page talks to nobody else and names no provider |
| `npm run build:exe` | Package the site as a Windows desktop app (`release/Streamed Arena-win32-x64/`) |
| `npm run installer` | Compile the Windows Setup installer (`release/Streamed Arena Setup.exe`) |
| `npm run release`   | Both of the above in one go                                              |

The network checks need a running app (`npm run dev`, or `npm start` after a build). They talk
to `http://127.0.0.1:3899` by default — point them somewhere else with
`BASE=http://127.0.0.1:3000 npm run check:personal-server`.
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

The desktop app also loads a tiny bundled extension (`electron/extensions/isolator/`) that gives
every embedded stream frame private in-memory storage. It was written for the days when the
provider's own player was shown in the app; the app no longer renders a provider player, but the
extension stays in place — it costs nothing and keeps any frame the user opens (a link to the
provider's page, say) from sharing storage with the app.

### Auto-update, signing & rollback

The desktop app keeps itself current from GitHub Releases (`electron/updater.cjs`). It watches the
repository's **release feed** (`releases.atom`) every **minute** — a plain web request with no rate
limit, so a release published now is noticed within about a minute instead of the two hours the old
polling interval needed. Only when the feed actually changed is the Releases **API** consulted
(it is rate limited to 60 calls/hour per IP, and even a `304` counts against that), so the app
never talks to the API just to be polite; a 15-minute backstop covers the case where the feed is
unreachable. The window also checks when it regains focus, throttled to one request a minute.

When a newer release is found, the popup appears **immediately** — it says *Downloading* while the
~124 MB installer comes down and only then offers **Restart to update** — so you learn about a new
version long before it is ready to install. The installer lands in
`%APPDATA%\streamed-arena\updates` and the themed in-app popup
(`components/updater/UpdatePopup.tsx`) offers **Restart to update** — the installer runs
silently (`/SILENT /UPDATE=1`), replaces the app and relaunches it. **Not now** dismisses the
popup (it returns on the next launch) and the update stays reachable from
**Streamed Arena → Restart to install update**; **Check for Updates…** force-checks anytime.
Nothing is ever force-installed. Updates are full re-downloads — no deltas — and stale payloads
are deleted as soon as the running version catches up. If Windows (usually antivirus) refuses to
launch the downloaded installer — the classic `spawn UNKNOWN` — the updater falls back through
alternate launch mechanisms and, failing those, shows the file location instead of crashing; the
payload stays on disk for a manual run or a menu retry. Code-signing the installer is the
systemic fix for that interference.

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
   `/releases/latest`, so within a check cycle (a minute or so) clients discard any downloaded copy
   and stop offering it.
2. **Rollback** — anyone already on the bad version uses
   **Streamed Arena → Roll Back to a Previous Version…** to download the previous signed release
   and silently roll back on restart. While rolled back, the fled-from release is not re-offered
   automatically until something newer ships.

**Version picker** — the gear icon in the desktop app's header opens a **Versions** panel listing
every GitHub release. Hovering a version previews its release notes; pre-releases and unsigned
legacy releases are listed but locked. Picking any other version (upgrade or downgrade) and
**Save** asks **Restart now** (silent install + relaunch) or **On next launch** — the chosen
version downloads, verifies, and installs itself the next time the app starts. A queued version
suppresses auto-update offers until it applies.

The release tag must be `vX.Y.Z` matching `package.json`.

### Windows code signing (Authenticode)

`npm run sign-binary` (part of the `release` chain, before the Ed25519 signature) Authenticode-signs
the app exe and the Setup.exe as publisher **TotallyNoire** — the trust layer Windows itself checks
(SmartScreen, antivirus, the UAC publisher line). A CA-issued certificate is required for real
trust; a publisher string or self-signed cert alone does **not** clear SmartScreen. Realistic
options: an **EV** certificate (instant SmartScreen reputation, strongest), an **OV** certificate
(reputation builds with downloads), **Azure Trusted Signing** (Microsoft-managed, org validation),
or **Certum's open-source signing** (cheap; the project is OSS).

Configure once, then `npm run release` signs every build automatically:

```
setx ARENA_CODESIGN_PFX "C:\path\to\cert.pfx"         # or:
setx ARENA_CODESIGN_PFX_PASSWORD "..."
setx ARENA_CODESIGN_THUMBPRINT "<cert thumbprint>"    # from Cert:\CurrentUser\My
setx ARENA_CODESIGN_SUBJECT "TotallyNoire"            # subject lookup
```

Order matters: Authenticode rewrites the binaries, so it runs **before** `sign-release` — the
Ed25519 signature is computed over the final, signed bytes, and clients verify exactly what ships.

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
app/api/
  espn/scoreboard/    server-side ESPN proxy (the renderer cannot call ESPN cross-origin)
  espn/summary/      server-side ESPN box-score proxy
  provider/          the provider's public API, read by the app's server (the board, the
                     categories, the per-match sources) — the provider's media addresses are
                     scrubbed out of the answer, so the page never learns them
  servers/            resolves + measures every feed of one match, lists the personal servers
  media/manifest/     the playlist the app publishes (its own window of the segments it holds)
  media/segment/      serves one media segment from the app's disk (streams it, honours Range)
  media/key/          serves the encryption key of a protected feed
  media/sources/      the sources the user brought themselves (read, write, remove)
  media/subscribe/    starts / stops fetching a feed (before the player asks / after it leaves)
  media/status/       what the server is doing: feeds hosted, lag, errors
lib/
  types.ts            the provider's entities + derived domain types
  api.ts              fetch client (timeout, TTL cache, stale-if-error) against the app's own
                      server-side feed proxy
  store.ts            the settings store: the app's own file in the desktop app, localStorage in the browser
  favorites.ts        favorite-team store + fixture pinning helpers
  volume.ts           remembered player volume + mute state
  espn.ts             ESPN public API client: scoreboards, summaries, team-name matching, box-score parsing
  hooks.ts            sports / live / fixtures / streams / game-stats queries, countdown, debounce
  servers.ts          client side of the server pool (ranked personal servers, lag badges)
  server/streamfree.ts  the resolver: reads the provider's matrix, probes every candidate, scores it
  server/upstream.ts    node:https client: own socket pool, hard deadlines, one retry
  server/media/
    channels.ts       the feeds the app hosts: state, the published window, the floor it slides on
    ingest.ts         the fetch loop: reads the upstream playlist, pulls the segments ahead of the player
    playlist.ts       reads an upstream playlist, writes the app's own playlist
    cache.ts          the segment cache on disk (a directory per run)
    format.ts         tells video apart from the provider's placeholder picture
    pool.ts           turns the measured feeds into the personal servers the list shows
    upstream.ts       how the app reaches the media: the user's own source, or the provider's doors
    sources.ts        sources the user brought themselves (the app's file / the environment)
  personal-sources.ts  the page's side of those sources (read, write, remove)
  utils.ts            status derivation, kick-off formatting, sport fallbacks
components/
  providers/          FilterProvider (shared search / sport / grid density state)
  layout/             Header (nav, search, category menu, live counter), Ticker, Footer
  hero/               HeroArena billboard + kick-off countdown + side rail
  fixtures/           FixtureHub tabs, SportsShelf, MatchCard, skeletons, empty state
  arena/              StreamSwitcher, HlsPlayer, MultiStream (4-screen wall)
  settings/           PersonalSources (the header panel), MatchSourceControl (per match)
  watch/              ArenaWatch (player + switcher), GameStats (live statline + leaders)
  media/              SafeImage (lazy, blur placeholder, initials fallback)
  ui/                 button, badge, panel, tabs, dialog, menu primitives
electron/
  main.cjs            embedded server boot, window, popup shield, uBlock loading, the settings store
  preload.cjs         IPC bridge for window controls and the settings store
  extensions/netfilter/  bundled uBlock Origin (MV2, Electron-accommodated)
scripts/
  build-exe.mjs       @electron/packager wrapper
  make-installer.mjs  Inno Setup script generator + compiler (version injected from package.json)
```

## API mapping

| Concern            | Endpoint                                   | Client behaviour |
| ------------------ | ------------------------------------------ | ---------------- |
| Sports             | `GET /api/v1/categories`                   | 30 min stale time, graceful fallback to built-in category list |
| Streams            | `GET /api/v1/streams`                      | every open fixture window in one list: live + soon-to-start; poll every **30s**, merged with the live set |
| Live filter        | same endpoint                              | rows with a non-empty `live_sources` array; feeds hero, ticker, live badges (poll every **15s**) |
| Per-sport          | `GET /api/v1/streams?category=:sport`      | same list, server-filtered |
| Stream sources     | `GET /api/v1/sources/:stream_key`          | 15s TTL; all quality/source variants in one response, cached copies of the board reuse the embed lists |
| Quality previews   | same sources endpoint                      | `useQueries` fan-out for the first 8 live cards (HD/SD tags) |
| Team badges        | — (not provided by the API)                | initials fallback chips everywhere |

The app also serves its own endpoints — the renderer never talks to a media host, and the
player is never told about one:

| App endpoint                          | Purpose                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `GET /api/servers?key=:stream_key`    | resolves + measures every feed of one match; returns the personal servers the app runs and the pool state (`ready` / `waiting` / `unknown`) |
| `GET /api/provider/:path`            | the provider's public API, read by the app's server (the fixture board, the categories, the per-match sources) — the page never calls the provider itself, and the provider's media addresses are scrubbed out of the answer |
| `GET /api/media/manifest?channel=`    | the playlist the app publishes — a gapless window of the segments it holds, pointing at this app |
| `GET /api/media/segment?channel=&name=` | serves one media segment from the app's disk (streams it, honours `Range`) |
| `GET /api/media/key?channel=&name=`   | serves the encryption key of a protected feed                          |
| `POST /api/media/subscribe?key=`      | starts fetching a match's feed before the player asks for it           |
| `DELETE /api/media/subscribe?key=`    | stops fetching a feed nobody is watching any more                      |
| `GET /api/media/status`               | what the server is doing: which feeds it hosts, their lag, its errors  |
| `GET /api/espn/scoreboard`            | same-origin ESPN proxy (ESPN rejects cross-origin reads from the app)   |
| `GET /api/espn/summary`               | same-origin ESPN box-score proxy                                        |

There is no endpoint that hands the provider's playlist or a provider segment to the player any
more: the app's own media server is the only way the player gets bytes.

Status is derived client-side from `match_timestamp`: everything in the future is `upcoming`,
matches started less than 3.5 h ago are `in-play`, older ones are `ended`; `live` wins for rows the
feed marks on air. The provider's embed pages are read by the app's server — they carry the
delivery matrix — but no embed is ever rendered in the app.

## Favorite teams

- Star a team on any match card (per-team star buttons on the full cards + the watch page chips) —
  favorited teams are stored as normalized names in the app's own settings store
  (`streamed-arena.favorites`).
- **They survive a restart** — in the desktop app the window is served from `http://127.0.0.1:<port>/`
  and the port is picked afresh on every launch, so the browser's localStorage would be a
  different origin every morning. The desktop app therefore keeps stars, the remembered volume
  and the multistream layout in a file of its own (`arena-store.json` in the app's data folder);
  in the browser the same values live in localStorage.
- **Pinning** — on the dashboard, live board and per-sport pages, a favorite's fixture floats to the
  top of every board while the game is on or starts within the next six hours; a match further out
  and ended fixtures keep their usual place.
- **Hero** — a favorite's on/soon fixture claims the home-page billboard before generic picks.

## Player

1. **Personal server mode — the only mode** – the app is the provider. It resolves the match's
   source matrix itself, measures every candidate on real numbers (HTTP latency, whether the
   newest segment still downloads, and how far behind the live edge it is — the CDN stamps
   segments with `Last-Modified`, so age *is* lag), and then **hosts the winning feed**:
   `lib/server/media/ingest.ts` reads the upstream playlist on a loop, downloads the segments as
   they appear and keeps them on disk, while `lib/server/media/playlist.ts` publishes a gapless
   window of what the server actually holds. The player pulls the playlist and the segments from
   this app — no provider iframe, no ads, no third-party scripts, and no third-party host named
   anywhere in the playlist.
   The public API only advertises two embed pages per match, but those embeds carry the real
   delivery matrix: a token map for up to four qualities (2160p/1080p/720p/540p), a source slot
   (`1`/`2`, often a completely independent upstream feed) and three interchangeable media
   backends (`/live/`, `/live-cdn/`, `/live-externalcdn/`). `lib/server/streamfree.ts` walks that
   matrix and scores every candidate; the doors behind it are the app's business, not the
   player's — when one stops answering, the server moves to the next one by itself.
   A feed the provider has no video for is never hosted as if it had one: the probe looks at the
   newest few segments (the newest one is regularly not downloadable yet), and a placeholder
   picture instead of video is refused rather than published.
2. **No third-party player** – the provider's own player is never put on the screen. The app
   either plays the feed from its own server, or it says what it is waiting for and keeps
   checking: the feed has not started, the provider has no video for it yet, or the arena does
   not carry it. There is no provider playlist and no provider segment URL anywhere in the
   player's path.
3. **HLS mode** – the app's own playlist runs through HLS.js with ABR, a quality selector, PiP
   and fullscreen.
4. **Failover** – a feed that dies is swapped for the next healthy server automatically
   (the player retries three times first). The `/watch/[id]` page keeps the running server
   **sticky**: the health check refreshes every 30 s and the ranking moves as the measured lag
   shifts, but the feed under you never changes because of it — only a real failure swaps it.
5. **Multistream** – `/multistream` builds a 4-screen wall: search-to-add slots (persisted with
   your settings), per-tile server switcher + remove, and a fullscreen mode that spreads all
   selected feeds across the whole display. Each tile uses the same personal servers.
6. **Live game stats** – the watch area gets a statline panel for the specific game via ESPN's
   public API (no key, CORS open): the fixtures are matched to ESPN games by team-name
   scoring, then the box score streams in — score + live clock, team statline (possession, total
   shots, shots on target, corners, cards, fouls…, red-highlighting the leading side) and player
   leaders with headshots. The summary refreshes every **15 s**; scoreboards every 60 s. Sports
   without an ESPN scoreboard degrade to a graceful note.
7. **Unobtrusive chrome** – the control bar fades out after **3 s** of pointer idle, even while
   the mouse is still resting on the video, and the cursor disappears with it so nothing sits
   over the action. Any mouse movement brings both back instantly; a paused player keeps its
   controls (and the cursor) where they are. Clicking a control (fullscreen, quality, mute…)
   does **not** leave the bar stuck on screen: a mouse click gives the keyboard focus back, so
   the idle timer can do its job again — while a keyboard user keeps the bar open for as long
   as the focus sits inside it. The hover-revealed toolbar of the multi-view tiles follows the
   same rule (an open channel menu still keeps its tile visible).
8. **The volume follows you** – a stream never opens at 100 %. The level you last chose is
   remembered in the app's settings store (the app's own file in the desktop app, localStorage in
   the browser) and every new stream — and every tile of the multi-view wall — starts at that
   level. Muting is remembered too, so a muted stream stays quiet instead of blasting the next
   one.
9. **A match that has not started** – a fixture whose kick-off has passed but whose feed has
   not been switched on yet has no media to host. The app asks whether the match is actually on
   air (the `live_sources` list in the feed, plus the `IS_LIVE` flag on the feed's own page)
   and answers with *"the feed has not started yet"* rather than an empty, broken-looking server
   list. The watch page keeps checking every 15 s and flips to the app's own server on its own when
   the feed appears — and because nothing is fetched until there is media, an idle watch page costs
   one cheap lookup instead of two dozen requests.

### Why the app hosts the stream itself

The provider's media hosts demand a `Referer: https://strmfree.st/` header and refuse cross-origin
reads, which the renderer cannot set — so the app's own server has to fetch the media anyway.
The question is only *when* it fetches it:

- **On demand** (what a plain proxy does): the player asks for a segment, the app asks the
  provider, and the player waits for the answer. The provider's edge is in the player's critical
  path, and every slow answer is a freeze on screen.
- **Ahead of the player** (what the app does now): the app reads the upstream playlist on a loop
  and downloads each segment the moment it appears, so the segment is already on the app's disk
  when the player asks for it. The answer comes from the disk in milliseconds. The provider's
  edge is out of the way entirely, and the app publishes a playlist of its own — a gapless window
  of the segments it actually holds, in stream order, with no discontinuity tags and no
  third-party host named anywhere in it.

Upstream calls go through `lib/server/upstream.ts`, a small `node:https` client with its own
socket pool, hard per-request deadlines and one retry: the global `fetch` dispatcher degrades in a
long-running desktop process and starts hanging, while this client keeps working for as long as
the app is open.

The old relay path (`/api/hls/manifest`, `/api/hls/segment`) is gone: there is no endpoint left
that hands the provider's playlist or a provider segment to the player.

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
