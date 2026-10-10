// Auto-update from GitHub Releases.
//
// Packaging here is @electron/packager + Inno Setup, not electron-builder, so
// electron-updater is not a fit (it expects NSIS installers plus blockmap
// metadata). This module talks to the Releases API directly instead:
//
//   launch + every 2 h  ->  GET /releases/latest  ->  tag newer than app.getVersion()
//   ->  download the Setup.exe into userData/updates (size + sha256 verified)
//   ->  prompt: "Restart to update" / "Later" (a toast reminds "Later" users
//       that the update applies on the next restart)
//   ->  on restart: spawn the installer with /SILENT /UPDATE=1 and quit. The
//       Inno script kills any running Streamed Arena.exe itself, then relaunches
//       the app after installing (the /UPDATE=1 gate keeps interactive installs
//       on the classic "launch app" checkbox instead).
//
// A release is prompted at most once per session; after that the menu keeps a
// "Restart to install update" entry reachable, and the prompt returns on next
// launch. Stale payloads (already-installed versions) are cleaned up so the
// ~130 MB download never lingers after it served its purpose.

const { app, dialog, net, Notification } = require('electron');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { once } = require('node:events');
const {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} = require('node:fs');
const { join } = require('node:path');

const REPO = 'Braedennn/streamed-arena';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
// GitHub rewrites spaces in asset names to dots on upload.
const SETUP_ASSET_NAME = 'Streamed.Arena.Setup.exe';
const INSTALLER_SWITCHES = ['/SILENT', '/SP-', '/SUPPRESSMSGBOXES', '/NORESTART', '/UPDATE=1'];

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 2 * 60 * 60_000;
const METADATA_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

const updateDir = join(app.getPath('userData'), 'updates');
const setupPath = join(updateDir, 'Streamed Arena Setup.exe');
const partPath = `${setupPath}.part`;
const statePath = join(updateDir, 'state.json');

let getWindow = () => null;
let downloading = false;
let promptedTag = null;
const stateListeners = new Set();

function versionNumbers(version) {
  return String(version ?? '')
    .replace(/^v/i, '')
    .split('.')
    .map((part) => parseInt(part, 10) || 0);
}

function isNewer(candidate, current) {
  const a = versionNumbers(candidate);
  const b = versionNumbers(current);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

async function fetchLatest() {
  const response = await net.fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'streamed-arena-updater' },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GitHub API replied ${response.status}`);
  const release = await response.json();
  const asset = (release.assets ?? []).find((entry) => entry.name === SETUP_ASSET_NAME);
  if (!asset?.browser_download_url) throw new Error('latest release has no Setup.exe asset');
  const digest = typeof asset.digest === 'string' ? asset.digest : '';
  return {
    tag: String(release.tag_name ?? ''),
    url: asset.browser_download_url,
    size: asset.size,
    sha256: digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : null,
  };
}

// Streams the installer to disk with backpressure; `once(out, 'error')` rides
// along every await so a failing disk never deadlocks the download loop.
async function downloadSetup(release) {
  mkdirSync(updateDir, { recursive: true });
  rmSync(partPath, { force: true });
  const response = await net.fetch(release.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok || !response.body) throw new Error(`download replied ${response.status}`);

  const out = createWriteStream(partPath);
  const failed = once(out, 'error').then(([error]) => {
    throw error;
  });
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), failed]);
      if (done) break;
      if (!out.write(value)) await Promise.race([once(out, 'drain'), failed]);
    }
    out.end();
    await Promise.race([once(out, 'finish'), failed]);
  } catch (error) {
    out.destroy();
    rmSync(partPath, { force: true });
    throw error;
  }

  const size = statSync(partPath).size;
  if (size !== release.size) {
    rmSync(partPath, { force: true });
    throw new Error(`downloaded ${size} bytes, expected ${release.size}`);
  }
  if (release.sha256) {
    const hash = createHash('sha256');
    hash.update(readFileSync(partPath));
    if (hash.digest('hex') !== release.sha256) {
      rmSync(partPath, { force: true });
      throw new Error('sha256 digest mismatch — download corrupted');
    }
  }
  // Atomic swap into place, then remember what the payload is.
  rmSync(setupPath, { force: true });
  renameSync(partPath, setupPath);
  const state = { ...release, path: setupPath, downloadedAt: new Date().toISOString() };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

function clearPendingUpdate() {
  rmSync(setupPath, { force: true });
  rmSync(partPath, { force: true });
  rmSync(statePath, { force: true });
}

// The pending update, or null. A payload whose version the running app already
// has (installer run by hand, say) is deleted on the spot to reclaim the space.
function pendingState() {
  let state = null;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
  if (!state?.tag || state.path !== setupPath || !existsSync(state.path)) return null;
  if (!isNewer(state.tag, app.getVersion())) {
    clearPendingUpdate();
    return null;
  }
  return state;
}

async function inform(title, message, detail) {
  const options = { type: 'info', title, message, detail, buttons: ['OK'] };
  const win = getWindow();
  if (win && !win.isDestroyed()) await dialog.showMessageBox(win, options);
  else await dialog.showMessageBox(options);
}

async function offerUpdate(state) {
  const options = {
    type: 'info',
    title: 'Update ready',
    message: `Streamed Arena ${state.tag} is ready to install`,
    detail: 'The new version downloaded in the background. Restart now and the update installs itself in a few seconds.',
    buttons: ['Restart to update', 'Later'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  };
  const win = getWindow();
  const { response } =
    win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  if (response === 0) {
    restartAndInstall();
    return;
  }
  // "Later" still deserves the heads-up: this is the "restart on your own
  // time" path, and the toast doubles as a one-click shortcut.
  if (Notification.isSupported()) {
    const toast = new Notification({
      title: 'Update deferred',
      body: `${state.tag} installs the next time you restart Streamed Arena.`,
    });
    toast.on('click', () => restartAndInstall());
    toast.show();
  }
}

function restartAndInstall() {
  const state = pendingState();
  if (!state) return;
  // Detached + unref: the installer outlives this process. The Inno script
  // taskkills any remaining Streamed Arena.exe at ssInstall — which also
  // covers the embedded server child, since it runs as the same exe — and
  // relaunches the app after installing via the /UPDATE=1 [Run] entry.
  spawn(state.path, INSTALLER_SWITCHES, { detached: true, stdio: 'ignore' }).unref();
  app.quit();
}

async function checkNow({ manual = false } = {}) {
  // Dev runs can't self-update (app.getVersion() would be Electron's own).
  if (!app.isPackaged || process.platform !== 'win32') {
    if (manual) {
      await inform('Streamed Arena', 'Updates are checked in the installed app only.', undefined);
    }
    return;
  }
  if (downloading) {
    if (manual) {
      await inform('Streamed Arena', 'Update download already in progress.', 'You will be notified when it is ready to install.');
    }
    return;
  }
  try {
    const release = await fetchLatest();
    if (!isNewer(release.tag, app.getVersion())) {
      clearPendingUpdate();
      if (manual) await inform('Streamed Arena', 'You are up to date.', `Streamed Arena v${app.getVersion()} is the latest version.`);
      return;
    }
    let state = pendingState();
    if (!state || state.tag !== release.tag) {
      downloading = true;
      try {
        state = await downloadSetup(release);
        for (const listener of stateListeners) listener();
      } finally {
        downloading = false;
      }
    }
    // One prompt per release per session; the menu entry and the next launch
    // keep the update reachable afterwards.
    if (promptedTag !== state.tag || manual) {
      promptedTag = state.tag;
      await offerUpdate(state);
    }
  } catch (error) {
    console.warn('[updater] check failed:', error.message);
    if (manual) {
      dialog.showErrorBox('Streamed Arena', `Update check failed:\n\n${error.message}`);
    }
  }
}

function start(windowGetter) {
  if (windowGetter) getWindow = windowGetter;
  if (!app.isPackaged || process.platform !== 'win32') return;
  pendingState();
  setTimeout(() => {
    void checkNow();
  }, FIRST_CHECK_DELAY_MS);
  setInterval(() => {
    void checkNow();
  }, CHECK_INTERVAL_MS);
  // A half-written installer is useless; never leave one behind.
  app.on('before-quit', () => rmSync(partPath, { force: true }));
}

module.exports = {
  start,
  checkNow,
  restartAndInstall,
  hasPendingUpdate: () => Boolean(pendingState()),
  pendingTag: () => pendingState()?.tag ?? null,
  onStateChange: (listener) => {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
};
