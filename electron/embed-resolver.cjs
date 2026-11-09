// The embed resolver.
//
// A provider that publishes only its own player gives the app a page and
// nothing else: the match is inside the page, and the playlist the page plays
// is put together at runtime - a token is fetched, a small program is run, and
// only then does the page ask for a playlist. There is no API to ask, and the
// token cannot be read out of the page by reading the page: it comes back
// encrypted.
//
// So the app asks the one thing that can answer it: a browser. The page is
// opened in a hidden window, and the playlist the page asks for is caught as
// it goes out. That address is then the app's own - the app fetches it, keeps
// it on disk and serves it from its own server, like every other feed.
//
// The browser is needed for the fetching too, not only for the finding.
//
// The door behind those addresses reads the client that asks, and it knows
// one: the browser's. The same address answers a page 200 and a plain
// network client 403, from one moment to the next, with the same headers and
// the same address - the difference is the handshake itself. So the playlists
// are read through the browser as well, and handed to the app's own server
// over the loopback interface.
//
// The resolver is a small service of its own. It listens on the loopback
// interface only, it resolves the pages of the providers the app knows and
// nothing else, and it is run by the app's own Electron process (or, when the
// app is started from a terminal, by a resolver of its own).
//
// Two ways to use it:
//   - require('./embed-resolver.cjs').startResolver({ port }) - inside the
//     app's own Electron process
//   - npx electron electron/embed-resolver.cjs - on its own, which is what
//     the development server starts

const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

/** The pages the app is allowed to open. */
const ALLOWED_ORIGINS = new Set(['https://taifood-blog.asia']);

/** The hosts a playlist may come from. */
const ALLOWED_MEDIA = /(^|\.)indianservers\.st$/i;

/** The referer the door wants. */
const DOOR_REFERER = 'https://taifood-blog.asia/';

/**
 * Is this a request for media rather than for a playlist?
 *
 * The media of this door is served from a host of its own, and the segments
 * are the parts of it that are big. The app's own server fetches those; the
 * page only has to keep its playlist.
 */
function isSegment(url) {
  return /\.(?:ts|m4s|mp4|webm)(?:\?|$)/i.test(url) || /~tplv[^/]*\.image(?:\?|$)/i.test(url);
}

/** How long the page has to ask for its playlist. */
const RESOLVE_TIMEOUT_MS = Number(process.env.ARENA_RESOLVER_TIMEOUT_MS ?? 18_000);

/** How long a door has to answer when the browser reads it. */
const FETCH_TIMEOUT_MS = Number(process.env.ARENA_RESOLVER_FETCH_MS ?? 12_000);

/** How long a resolved address is remembered. */
const RESOLVE_TTL_MS = Number(process.env.ARENA_RESOLVER_TTL_MS ?? 5 * 60_000);

/**
 * How long a page is left alone after it was asked again and did not answer.
 *
 * Opening a page takes seconds. The app reads the playlist every second, so
 * a page that is dead would otherwise be opened again and again - once for
 * every read - and every one of those waits would be the app's wait.
 */
const REFRESH_COOLDOWN_MS = Number(process.env.ARENA_RESOLVER_REFRESH_MS ?? 30_000);

/** The default port, when the caller does not pick one. */
const DEFAULT_PORT = Number(process.env.ARENA_RESOLVER_PORT ?? 3911);

/**
 * How long a page is kept open after it was asked what it plays.
 *
 * The address belongs to the page that asked for it, so the page is kept a
 * moment - long enough for the address to be established - and is then
 * closed. The address does not need the page to stay on: it lives on its own
 * for as long as the event does, and the app reads it again if it ever stops
 * answering.
 */
const WINDOW_KEEP_MS = Number(process.env.ARENA_RESOLVER_WINDOW_MS ?? 45_000);

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A free port on the loopback interface. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Fetches an address with the browser's own network stack.
 *
 * This is the reason the resolver is not only a finder but also a reader: the
 * door behind the addresses it hands out reads the client that asks, and it
 * knows the browser. The very same address, asked at the very same moment
 * with the very same headers, is answered 200 here and 403 by a plain
 * network client - so the playlists are read here and handed over.
 */
function browserFetch(rawUrl, headers = {}) {
  const { net: electronNet, session } = require('electron');
  return new Promise((resolve, reject) => {
    let request;
    try {
      request = electronNet.request({ url: rawUrl, method: 'GET', session: session.defaultSession });
    } catch (error) {
      reject(error);
      return;
    }

    // A door that does not answer must not hold the answer open for ever.
    const timer = setTimeout(() => {
      try {
        request.abort();
      } catch {
        // The request is already gone.
      }
      reject(new Error('the door did not answer in time'));
    }, FETCH_TIMEOUT_MS);

    const chunks = [];
    request.on('response', (response) => {
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        clearTimeout(timer);
        resolve({
          status: response.statusCode || 0,
          headers: response.headers || {},
          body: Buffer.concat(chunks),
        });
      });
    });
    request.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);
    request.end();
  });
}

/**
 * Is this a page the app may open?
 *
 * The resolver is a service on the loopback interface, and it opens pages in
 * a browser. That is enough to be an open proxy for anything that can reach
 * the port, so the pages it opens are named here and nowhere else.
 */
function allowedPage(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  const origin = `${url.protocol}//${url.host}`;
  if (!ALLOWED_ORIGINS.has(origin)) return null;
  if (!url.pathname.startsWith('/embed/')) return null;
  return url.toString();
}

/**
 * Starts the resolver.
 *
 * Returns the port it listens on and a way to stop it again.
 */
async function startResolver(options = {}) {
  const { app, BrowserWindow, session } = require('electron');

  // The page plays with the sound on and without a click: a page that waits
  // for a gesture never asks for its playlist.
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

  /** The resolutions that are running, by the id of the window asking. */
  const pending = new Map();
  /** The answers already known, by the page they belong to. */
  const cache = new Map();
  /** The pages that are still open, by their address. */
  const openWindows = new Map();
  /** The directory each page's address sits in, by the page. */
  const dirByPage = new Map();
  /** The page each directory was handed out by - including the old ones. */
  const pageByDir = new Map();
  /** The front each page's address had, by the page. */
  const prefixByPage = new Map();
  /** Where a front moved to, when its page was asked again. */
  const prefixMoves = new Map();
  /** When a page was asked again, by the page. */
  const lastRefresh = new Map();
  /** The pages that are being opened at this moment, by their address. */
  const pendingResolves = new Map();

  /**
   * The directory an address sits in.
   *
   * The addresses of this door carry a token in their path, and the token is
   * what expires. Everything below the token - the network, the qualities,
   * the playlists - is the same from one token to the next, so a directory is
   * what a token is replaced by.
   *
   * The directory ends at the token and not at the playlist: a master and
   * the qualities below it are not one under the other but beside each
   * other, and they all carry the same token. So they all move together.
   */
  function tokenDir(raw) {
    try {
      const url = new URL(raw);
      const mark = url.pathname.indexOf('/secure/');
      if (mark >= 0) {
        const rest = url.pathname.slice(mark + '/secure/'.length);
        const slash = rest.indexOf('/');
        if (slash > 0) {
          return `${url.origin}${url.pathname.slice(0, mark + '/secure/'.length + slash + 1)}`;
        }
      }
      const cut = url.pathname.lastIndexOf('/');
      return `${url.origin}${url.pathname.slice(0, cut + 1)}`;
    } catch {
      return '';
    }
  }

  /**
   * The front of an address: everything up to the network.
   *
   * An address of this door reads
   *
   *   /secure/<token>/<start>/<end>/<network>/<playlist>
   *
   * and the two parts of it move together: a page that is asked again hands
   * out a new token *and* a new window - the window is the event's own, and
   * it slides on as the event goes on. An address that keeps the old window
   * under the new token is refused, because the window it names is over.
   *
   * So the front is what a rotation replaces, and the network below it - the
   * channel's own name - is what stays.
   */
  function windowPrefix(raw) {
    try {
      const url = new URL(raw);
      const mark = url.pathname.indexOf('/secure/');
      if (mark < 0) return '';
      const rest = url.pathname.slice(mark + '/secure/'.length);
      const parts = rest.split('/');
      // token / start / end / network / ...
      if (parts.length < 4 || !parts[0] || !parts[2]) return '';
      const head = url.pathname.slice(0, mark + '/secure/'.length);
      return `${url.origin}${head}${parts[0]}/${parts[1]}/${parts[2]}/`;
    } catch {
      return '';
    }
  }

  /**
   * An address with the moves of its front applied.
   *
   * When a page is asked again it hands out a new token and a new window, and
   * the address that was handed out before is dead. The app is still holding
   * that old address, so it is moved onto the new one here - the app does not
   * have to know that anything happened.
   */
  function rewrite(raw) {
    let target = raw;
    for (let step = 0; step < 8; step += 1) {
      let from = '';
      let to = '';
      for (const [candidateFrom, candidateTo] of prefixMoves) {
        if (target.startsWith(candidateFrom) && candidateFrom.length > from.length) {
          from = candidateFrom;
          to = candidateTo;
        }
      }
      if (!from) break;
      target = to + target.slice(from.length);
    }
    return target;
  }

  /**
   * The page whose address this one came from, when it is known.
   *
   * Every directory a page has handed out is remembered, the old ones as
   * well - the address the app is holding is an old one, and it still has to
   * be traced back to the page that handed it out.
   */
  function pageFor(raw) {
    let best = '';
    let page = '';
    for (const [dir, candidatePage] of pageByDir) {
      if (raw.startsWith(dir) && dir.length > best.length) {
        best = dir;
        page = candidatePage;
      }
    }
    return page;
  }

  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    // The page plays the match while it is open, and it would download the
    // whole stream a second time. The app's own server is the one that
    // fetches the media, so the segments are stopped here - the playlist is
    // let through, because the page asks for it again and again.
    if (isSegment(details.url)) {
      callback({ cancel: true });
      return;
    }

    const waiting = pending.get(details.webContentsId);
    if (waiting && /\.m3u8(\?|$)/i.test(details.url)) {
      let host = '';
      try {
        host = new URL(details.url).hostname;
      } catch {
        host = '';
      }
      if (ALLOWED_MEDIA.test(host)) {
        // The address is taken, and the request is let through: the page
        // keeps asking for its playlist while it plays, and the door expects
        // to be asked.
        waiting.resolve(details.url);
      }
    }
    callback({});
  });

  /**
   * Opens a page and waits for the playlist it asks for.
   */
  async function resolvePage(pageUrl) {
    const win = new BrowserWindow({
      width: 640,
      height: 360,
      show: false,
      webPreferences: {
        backgroundThrottling: false,
        autoplayPolicy: 'no-user-gesture-required',
        // The page is a document, not a program the app runs: it gets no
        // access to the app.
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const found = new Promise((resolve) => {
      pending.set(win.webContents.id, { resolve });
    });

    const started = Date.now();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve(''), RESOLVE_TIMEOUT_MS);
    });

    try {
      await win.loadURL(pageUrl).catch(() => {});
    } catch {
      // A page that does not load answers with nothing.
    }

    const url = await Promise.race([found, timeout]);
    if (timer) clearTimeout(timer);
    pending.delete(win.webContents.id);

    if (url) {
      const dir = tokenDir(url);
      dirByPage.set(pageUrl, dir);
      pageByDir.set(dir, pageUrl);
    }

    // The window is not closed straight away.
    //
    // The address belongs to the page that asked for it, so the page is kept
    // a moment - long enough for the address to be established - and is then
    // closed. The address does not need the page to stay on: it lives on its
    // own for as long as the event does, and the app reads it again if it
    // ever stops answering.
    //
    // A page that is asked again replaces the one that was open: the old
    // window would keep the old address alive, and the old address is the one
    // that stopped answering.
    const open = openWindows.get(pageUrl);
    if (open) {
      clearTimeout(open.timer);
      try {
        open.window.destroy();
      } catch {
        // The window is already gone.
      }
    }
    const timerKeep = setTimeout(() => {
      openWindows.delete(pageUrl);
      try {
        win.destroy();
      } catch {
        // The window is already gone.
      }
    }, WINDOW_KEEP_MS);
    timerKeep.unref?.();
    openWindows.set(pageUrl, { window: win, timer: timerKeep });

    return { url, ms: Date.now() - started };
  }

  /**
   * The playlist of a page, remembered for a while.
   *
   * The address a page asks for carries the event's own start and end, so it
   * stays good for as long as the event is on - but the app does not have to
   * trust that: when the feed stops answering, the page is opened again.
   *
   * Only one page is opened at a time for a given page. The app asks for a
   * fresh address while the resolver is already opening the page - that is
   * the normal case, not a rare one - and a second window would hand out a
   * second token and throw the first one away.
   */
  async function resolve(rawUrl, fresh = false) {
    const pageUrl = allowedPage(rawUrl);
    if (!pageUrl) return { error: 'that page is not one the app opens' };

    const known = cache.get(pageUrl);
    if (!fresh && known && Date.now() - known.at < RESOLVE_TTL_MS) {
      return { url: known.url, cached: true, ms: 0 };
    }

    const running = pendingResolves.get(pageUrl);
    if (running) return running;

    const answer = openPage(pageUrl);
    pendingResolves.set(pageUrl, answer);
    try {
      return await answer;
    } finally {
      pendingResolves.delete(pageUrl);
    }
  }

  /** Opens a page and takes the address it hands out. */
  async function openPage(pageUrl) {
    // The front the page handed out last time. It is remembered before the
    // page is asked, because the new address replaces it.
    const previous = prefixByPage.get(pageUrl);

    const answer = await resolvePage(pageUrl);
    if (!answer.url) {
      return { error: 'the page did not ask for a playlist' };
    }

    // A page that is asked again hands out a new token and a new window, and
    // the address the app is holding is dead from that moment on. The old
    // front is moved onto the new one, so the app keeps asking for the
    // address it knows and the answer comes from the token and the window
    // that are alive.
    const current = windowPrefix(answer.url);
    if (previous && current && previous !== current) prefixMoves.set(previous, current);
    prefixByPage.set(pageUrl, current);

    const dir = tokenDir(answer.url);
    dirByPage.set(pageUrl, dir);
    if (dir) pageByDir.set(dir, pageUrl);

    cache.set(pageUrl, { at: Date.now(), url: answer.url });
    return { url: answer.url, cached: false, ms: answer.ms };
  }

  /**
   * Forgets what a page handed out.
   *
   * The app asks for this when a feed stops answering: the address the page
   * handed out is dead, and the next question has to open the page again.
   *
   * The directory the page handed out is kept: it is what the next address is
   * compared against, so the app's address can be moved onto the new one.
   */
  function forget(rawUrl) {
    const pageUrl = allowedPage(rawUrl);
    if (!pageUrl) return false;
    cache.delete(pageUrl);
    return true;
  }

  /**
   * Reads a playlist, and asks for a new one when the address is dead.
   *
   * The token in an address of this door expires. When it does, the address
   * is refused - and the page that handed it out is asked again, which hands
   * out a new one. The app does not have to know that anything happened: it
   * keeps asking for the address it knows, and the answer comes from the new
   * token.
   *
   * The page is opened in the background. Opening it takes seconds, and the
   * app reads the playlist every second - making the reader wait for a page
   * to open would turn one dead address into a stall on every read.
   */
  async function readPlaylist(rawUrl) {
    const target = rewrite(rawUrl);

    let answer;
    try {
      answer = await browserFetch(target, { referer: DOOR_REFERER });
    } catch (error) {
      return { error: error.message };
    }

    // The page the address came from. The app is told, so that it can ask
    // for a new address when this one is refused - it cannot work the page
    // out of the address itself.
    const page = pageFor(target);

    if (answer.status >= 200 && answer.status < 300) return { answer, url: target, page };
    if (!page) return { answer, url: target };

    // The address is refused: the page that handed it out is asked again.
    refreshPage(page);

    return { answer, url: target, page };
  }

  /**
   * Asks a page again, in the background.
   *
   * A page is not asked again and again: the app reads the playlist every
   * second, and a page that is opened for every one of those reads would
   * spend its life opening pages. A page is asked once, and the answer is
   * there for the reads that follow.
   */
  function refreshPage(page) {
    const last = lastRefresh.get(page);
    if (last && Date.now() - last < REFRESH_COOLDOWN_MS) return;
    lastRefresh.set(page, Date.now());

    void resolve(page, true).then((answer) => {
      if (answer.error) {
        if (process.env.ARENA_RESOLVER_DEBUG === '1') {
          process.stdout.write(`[resolver] refresh failed: ${answer.error} ${page}\n`);
        }
      }
    });
  }

  const port = options.port ?? (await freePort());

  const server = http.createServer((request, response) => {
    const send = (status, payload) => {
      const body = JSON.stringify(payload);
      response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      response.end(body);
    };

    let url;
    try {
      url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
    } catch {
      send(400, { error: 'bad request' });
      return;
    }

    if (url.pathname === '/health') {
      send(200, { ok: true, port, pid: process.pid });
      return;
    }

    if (url.pathname === '/resolve') {
      const target = url.searchParams.get('url') ?? '';
      // "fresh" asks the page again even when an address is known - which is
      // what the app does when the address it has stops answering.
      const fresh = url.searchParams.get('fresh') === '1';
      resolve(target, fresh)
        .then((answer) => {
          if (answer.error) send(404, answer);
          else send(200, answer);
        })
        .catch((error) => send(500, { error: error.message }));
      return;
    }

    // The forgetter: the app asks for this when a feed stops answering, so
    // the page is opened again and hands out a new address.
    if (url.pathname === '/forget') {
      const target = url.searchParams.get('url') ?? '';
      send(200, { forgotten: forget(target) });
      return;
    }

    // The reader: the address of a playlist, read with the browser's stack.
    //
    // Only the door the app knows is served here, and only its playlists -
    // the media itself is fetched by the app's own server, which the door
    // does not mind.
    //
    // The answer comes back with the address it was read from, so the app
    // can keep its own book of addresses in step with the door's.
    if (url.pathname === '/fetch') {
      const target = url.searchParams.get('url') ?? '';
      let host = '';
      try {
        host = new URL(target).hostname;
      } catch {
        host = '';
      }
      if (!ALLOWED_MEDIA.test(host) || !/\.m3u8(?:\?|$)/i.test(target)) {
        send(404, { error: 'that address is not one the app reads' });
        return;
      }
      readPlaylist(target)
        .then((result) => {
          if (result.error) {
            send(502, { error: result.error });
            return;
          }
          const answer = result.answer;
          const body = answer.body;
          if (process.env.ARENA_RESOLVER_DEBUG === '1') {
            process.stdout.write(
              `[resolver] fetch ${answer.status} ${body.length}b ${result.url}\n`,
            );
          }
          const headers = {
            'content-type': String(answer.headers['content-type'] ?? 'application/octet-stream'),
            'content-length': body.length,
            'cache-control': 'no-store',
            'x-arena-source': String(result.url),
          };
          if (result.page) headers['x-arena-page'] = String(result.page);
          response.writeHead(answer.status, headers);
          response.end(body);
        })
        .catch((error) => {
          if (process.env.ARENA_RESOLVER_DEBUG === '1') {
            process.stdout.write(`[resolver] fetch failed: ${error.message} ${target}\n`);
          }
          send(502, { error: error.message });
        });
      return;
    }

    send(404, { error: 'not found' });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', resolveListen);
  });

  return {
    port,
    close: () => {
      for (const waiting of pending.values()) waiting.resolve('');
      pending.clear();
      cache.clear();
      dirByPage.clear();
      pageByDir.clear();
      prefixByPage.clear();
      prefixMoves.clear();
      lastRefresh.clear();
      pendingResolves.clear();
      for (const open of openWindows.values()) {
        clearTimeout(open.timer);
        try {
          open.window.destroy();
        } catch {
          // The window is already gone.
        }
      }
      openWindows.clear();
      server.close();
    },
  };
}

/**
 * Runs the resolver on its own.
 *
 * This is what the development server starts: the app's own Electron process
 * is not there in development, so a resolver of its own is.
 */
async function runStandalone() {
  const { app } = require('electron');

  // The resolver gets a profile of its own. Two Electron processes that share
  // one profile fight over it - the second one cannot write its cache and
  // behaves strangely - and the app's own profile belongs to the app.
  const profile = path.join(app.getPath('temp'), 'streamed-arena-resolver');
  try {
    fs.mkdirSync(profile, { recursive: true });
    app.setPath('userData', profile);
  } catch {
    // The profile stays where it was: a resolver that shares a profile is
    // still a resolver.
  }

  await app.whenReady();
  const resolver = await startResolver({ port: DEFAULT_PORT });
  process.stdout.write(`[resolver] listening on http://127.0.0.1:${resolver.port}\n`);
  app.on('window-all-closed', () => {
    // The resolver has no windows of its own; the app stays up.
  });
}

module.exports = { startResolver, allowedPage, ALLOWED_ORIGINS, ALLOWED_MEDIA };

/**
 * Is this the resolver's own process?
 *
 * Electron runs a script through its own default application, so the script
 * is not the main module and cannot be recognised that way. What tells them
 * apart is the way the app was started: a script that was named on the
 * command line is the default application, and an app that was started from
 * its own directory is not.
 *
 * The script is looked for among the arguments that are not switches: a
 * switch of electron's own may stand in front of it.
 */
function runningOnItsOwn() {
  if (process.defaultApp !== true) return false;
  for (const argument of process.argv.slice(1)) {
    if (argument.startsWith('-')) continue;
    return path.basename(argument).toLowerCase() === 'embed-resolver.cjs';
  }
  return false;
}

if (runningOnItsOwn()) {
  runStandalone().catch((error) => {
    process.stderr.write(`[resolver] failed to start: ${error.stack ?? error.message}\n`);
    process.exit(1);
  });
}
