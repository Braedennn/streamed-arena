const { app, BrowserWindow, shell, dialog, session, Menu, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('node:fs');
const path = require('path');
const net = require('net');

const updater = require('./updater.cjs');

const ROOT = path.join(__dirname, '..');
const SERVER_SCRIPT = path.join(ROOT, '.next-standalone', 'standalone', 'server.js');
const FILTER_PATH = path.join(__dirname, 'extensions', 'netfilter');
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');

// Windows identity for toast notifications (and taskbar grouping niceties).
app.setAppUserModelId('com.streamed.arena');

// Boot trace: launch the app with ARENA_BOOT_DEBUG=1 and read
// %TEMP%\arena-boot.log — a timestamped hand-off trail (splash → server →
// window → reveal) that makes launch problems diagnosable without a
// debugger attached.
const BOOT_DEBUG = process.env.ARENA_BOOT_DEBUG === '1';
function boot(message) {
  if (!BOOT_DEBUG) return;
  try {
    fs.appendFileSync(path.join(process.env.TEMP || '.', 'arena-boot.log'), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Diagnostics must never break the boot.
  }
}

let mainWindow = null;
let splashWindow = null;
let serverProcess = null;
let uboExtensionId = null;
let appOrigin = null;

const debugPort = process.env.ELECTRON_DEBUG_PORT;
if (debugPort) app.commandLine.appendSwitch('remote-debugging-port', debugPort);

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

function waitForServer(url, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = async () => {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
        if (response.ok || response.status === 404) return resolve();
      } catch {
        // not up yet
      }
      if (Date.now() - started > timeoutMs) return reject(new Error('Server did not start in time'));
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

function startServer() {
  return freePort().then((port) => {
    const child = spawn(
      process.execPath,
      [SERVER_SCRIPT],
      {
        cwd: path.dirname(SERVER_SCRIPT),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          NODE_ENV: 'production',
          PORT: String(port),
          HOSTNAME: '127.0.0.1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );
    child.stdout.on('data', (chunk) => process.stdout.write(chunk));
    child.stderr.on('data', (chunk) => process.stderr.write(chunk));
    return { child, port };
  });
}

function stopServer() {
  if (!serverProcess) return;
  try {
    serverProcess.kill();
  } catch {
    // already gone
  }
  serverProcess = null;
}

function sendWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('arena-window-state', { maximized: mainWindow.isMaximized() });
}

ipcMain.on('arena-window', (event, action) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return;
  switch (action) {
    case 'minimize':
      win.minimize();
      break;
    case 'maximize':
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      break;
    case 'close':
      win.close();
      break;
  }
});

// Instantly-themed launch placeholder: the embedded Next server takes a few
// seconds to boot, and a blank taskbar-less gap reads as "app did nothing".
// The splash paints immediately and is dismissed by revealMainWindow() the
// moment the main window takes over. No exotic window flags here — plain
// frameless + skipTaskbar; focusable/movable quirks bought nothing.
function createSplash() {
  const splash = new BrowserWindow({
    width: 480,
    height: 300,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    show: true,
    center: true,
    backgroundColor: '#070405',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  splash.webContents.once('did-finish-load', () => boot('splash: painted'));
  splash.webContents.once('did-fail-load', (_event, code, desc) => boot(`splash: did-fail-load ${code} ${desc}`));
  splash.loadFile(path.join(__dirname, 'splash.html')).then(
    () => boot('splash: loadFile resolved'),
    (error) => boot(`splash: loadFile rejected: ${error.message}`),
  );
  return splash;
}

function closeSplash() {
  const splash = splashWindow;
  splashWindow = null;
  if (!splash) return;
  try {
    if (!splash.isDestroyed()) splash.close();
  } catch {
    try {
      splash.destroy();
    } catch {
      // already gone
    }
  }
}

// The reveal is deliberately multi-signal. ready-to-show is the fast path,
// but it is a compositor promise, not a guarantee — if it never fires
// (GPU/driver quirks, a stalled first paint), the did-finish-load fallback
// and an absolute timer still surface the window. Every path shows the
// window FIRST and closes the splash second: a closed splash with a hidden
// window behind it is an invisible zombie app.
function revealMainWindow(reason) {
  boot(`reveal: ${reason}`);
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  boot(`reveal done: visible=${mainWindow.isVisible()} focused=${mainWindow.isFocused()}`);
  closeSplash();
}

function createWindow(url) {
  appOrigin = new URL(url).origin;
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#070405',
    // Hide the native title bar entirely — no floating window-control overlay
    // covering the UI; the renderer's header provides its own themed controls
    // (see electron/preload.cjs + the header's window buttons).
    titleBarStyle: 'hidden',
    autoHideMenuBar: true,
    title: 'Streamed Arena',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: PRELOAD_PATH,
    },
  });

  boot('main: window created');
  mainWindow.once('ready-to-show', () => revealMainWindow('ready-to-show'));
  mainWindow.loadURL(url).then(
    () => boot('main: loadURL resolved'),
    (error) => boot(`main: loadURL rejected: ${error.message}`),
  );
  // Fallback #1: the page finished loading — paint follows within moments,
  // so if ready-to-show is late or lost, don't keep waiting for it.
  mainWindow.webContents.once('did-finish-load', () => {
    setTimeout(() => revealMainWindow('did-finish-load+600ms'), 600);
  });
  // If the first render dies outright, surface whatever there is instead of
  // leaving an invisible window behind the splash.
  mainWindow.webContents.once('did-fail-load', (event, code, desc, target, isMainFrame) => {
    boot(`main: did-fail-load ${code} ${desc} mainFrame=${isMainFrame}`);
    revealMainWindow('did-fail-load');
  });
  mainWindow.webContents.on('render-process-gone', (_event, details) => boot(`main: render-process-gone (${details.reason})`));
  mainWindow.webContents.on('unresponsive', () => boot('main: renderer unresponsive'));
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);

  // Popup-ad shield: Electron's reduced extension API means uBlock Origin
  // cannot see or close popup windows itself, so popups are adjudicated here.
  // Popups opened by the app's own UI (referrer = app origin) are legit links
  // and are handed to the system browser; anything opened from a third-party
  // frame (stream-embed iframes, ad scripts — the classic popup/popunder ads)
  // is denied outright, so it never spawns an app window nor a browser tab.
  mainWindow.webContents.setWindowOpenHandler(({ url: target, referrer }) => {
    // `referrer` is an object ({ url, policy }), not a string — parsing it
    // directly always threw, so even the app's own links were denied.
    let fromAppUI = false;
    try {
      fromAppUI = new URL((referrer && referrer.url) || '').origin === appOrigin;
    } catch {
      fromAppUI = false;
    }
    if (fromAppUI && /^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });

  // The window never leaves the app origin. A stream embed can still try to
  // redirect the whole window (`top.location = <ad>`); that used to be handed
  // to the system browser, i.e. an ad tab opening itself. Now an off-origin
  // navigation is only passed on when the app's own page started it.
  mainWindow.webContents.on('will-navigate', (event, target) => {
    let next;
    try {
      next = new URL(target);
    } catch {
      event.preventDefault();
      return;
    }
    if (next.origin === appOrigin) return;
    event.preventDefault();
    let fromAppUI = false;
    try {
      fromAppUI = Boolean(event.initiator) && new URL(event.initiator.url).origin === appOrigin;
    } catch {
      fromAppUI = false;
    }
    if (fromAppUI && /^https?:$/.test(next.protocol)) void shell.openExternal(target);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function openUBODashboard() {
  if (!uboExtensionId) return;
  const win = new BrowserWindow({
    width: 1280,
    height: 900,
    backgroundColor: '#070405',
    autoHideMenuBar: true,
    title: 'uBlock Origin — Dashboard',
  });
  win.loadURL(`chrome-extension://${uboExtensionId}/dashboard.html`);
}

function buildMenu() {
  const menu = Menu.buildFromTemplate([
    {
      // App menu: the update surface. "Restart to install update" stays
      // hidden until a verified installer sits on disk, so deferred
      // updates remain one menu click away for the whole session.
      label: 'Streamed Arena',
      submenu: [
        { label: 'Check for Updates…', click: () => void updater.checkNow({ manual: true }) },
        {
          label: `Restart to install ${updater.pendingTag() ?? 'update'}`,
          visible: updater.hasPendingUpdate(),
          click: () => updater.restartAndInstall(),
        },
        { label: 'Roll Back to a Previous Version…', click: () => void updater.rollback() },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'uBlock Origin',
      submenu: [
        {
          label: 'Open dashboard',
          click: () => openUBODashboard(),
        },
      ],
    },
    { role: 'viewMenu' },
  ]);
  Menu.setApplicationMenu(menu);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    boot('boot: whenReady');
    splashWindow = createSplash();
    buildMenu();
    updater.onStateChange(buildMenu);

    // uBlock is armor, not a dependency: a hung or failed extension load must
    // never block the boot, so it is raced against a timeout and the app
    // proceeds (with a visible complaint) if the engine misbehaves.
    try {
      uboExtensionId = await Promise.race([
        session.defaultSession.extensions
          .loadExtension(FILTER_PATH, { allowFileAccess: true })
          .then((ext) => {
            boot('boot: uBlock loaded');
            return ext.id;
          }),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error('extension load timed out after 15 s')), 15_000);
        }),
      ]);
    } catch (error) {
      boot(`boot: uBlock load failed: ${error.message}`);
      dialog.showErrorBox(
        'Streamed Arena',
        `Failed to load the ad blocker (uBlock Origin):\n\n${error.message}`,
      );
    }

    try {
      const { child, port } = await startServer();
      serverProcess = child;
      await waitForServer(`http://127.0.0.1:${port}/`);
      boot(`boot: server up on port ${port}`);
      createWindow(`http://127.0.0.1:${port}/`);
    } catch (error) {
      closeSplash();
      dialog.showErrorBox('Streamed Arena', `Failed to start the embedded server:\n\n${error.message}`);
      app.quit();
      return;
    }

    // Fallback #2 — absolute. Whatever happened above, the app shows itself
    // and never strands the user behind a splash.
    setTimeout(() => revealMainWindow('10s-absolute'), 10_000);

    // Auto-update: periodic release checks start shortly after the window is
    // up, so a slow network never delays app startup.
    updater.start(() => mainWindow);
  });

  app.on('window-all-closed', () => {
    boot('quit: window-all-closed');
    stopServer();
    app.quit();
  });

  app.on('before-quit', () => {
    boot('quit: before-quit');
    stopServer();
  });

  process.on('exit', () => {
    boot('quit: process exit');
    stopServer();
  });
}
