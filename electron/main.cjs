const { app, BrowserWindow, shell, dialog, session, Menu, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const SERVER_SCRIPT = path.join(ROOT, '.next-standalone', 'standalone', 'server.js');
const FILTER_PATH = path.join(__dirname, 'extensions', 'netfilter');
const PRELOAD_PATH = path.join(__dirname, 'preload.cjs');

let mainWindow = null;
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

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.loadURL(url);
  mainWindow.on('maximize', sendWindowState);
  mainWindow.on('unmaximize', sendWindowState);

  // Popup-ad shield: Electron's reduced extension API means uBlock Origin
  // cannot see or close popup windows itself, so popups are adjudicated here.
  // Popups opened by the app's own UI (referrer = app origin) are legit links
  // and are handed to the system browser; anything opened from a third-party
  // frame (stream-embed iframes, ad scripts — the classic popup/popunder ads)
  // is denied outright, so it never spawns an app window nor a browser tab.
  mainWindow.webContents.setWindowOpenHandler(({ url: target, referrer }) => {
    let fromAppUI = false;
    try {
      fromAppUI = new URL(referrer || '').origin === appOrigin;
    } catch {
      fromAppUI = false;
    }
    if (fromAppUI && /^https?:\/\//.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, target) => {
    let next;
    try {
      next = new URL(target);
    } catch {
      return;
    }
    if (next.origin !== appOrigin) {
      event.preventDefault();
      if (target.startsWith('http')) void shell.openExternal(target);
    }
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
    buildMenu();

    try {
      const ext = await session.defaultSession.extensions.loadExtension(FILTER_PATH, {
        allowFileAccess: true,
      });
      uboExtensionId = ext.id;
    } catch (error) {
      dialog.showErrorBox(
        'Streamed Arena',
        `Failed to load the ad blocker (uBlock Origin):\n\n${error.message}`,
      );
    }

    try {
      const { child, port } = await startServer();
      serverProcess = child;
      await waitForServer(`http://127.0.0.1:${port}/`);
      createWindow(`http://127.0.0.1:${port}/`);
    } catch (error) {
      dialog.showErrorBox('Streamed Arena', `Failed to start the embedded server:\n\n${error.message}`);
      app.quit();
    }
  });

  app.on('window-all-closed', () => {
    stopServer();
    app.quit();
  });

  app.on('before-quit', stopServer);

  process.on('exit', stopServer);
}
