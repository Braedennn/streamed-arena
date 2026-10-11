// Auto-update from GitHub Releases.
//
// Packaging here is @electron/packager + Inno Setup, not electron-builder, so
// electron-updater is not a fit (it expects NSIS installers plus blockmap
// metadata). This module talks to the Releases API directly instead:
//
//   launch + every 2 h  ->  GET /releases/latest  ->  tag newer than app.getVersion()
//   ->  verify the Ed25519 release signature (see scripts/sign-release.mjs)
//   ->  download the Setup.exe into userData/updates (size + sha256 verified)
//   ->  prompt: "Restart to update" / "Later" (a toast reminds "Later" users
//       that the update applies on the next restart)
//   ->  on restart: spawn the installer with /SILENT /UPDATE=1 and quit. The
//       Inno script kills any running Streamed Arena.exe itself, then relaunches
//       the app after installing (the /UPDATE=1 gate keeps interactive installs
//       on the classic "launch app" checkbox instead).
//
// Trust model: releases are only as trustworthy as the signing key, NOT the
// GitHub account — an unsigned or badly signed release is never installed,
// so a compromised account cannot push code to existing installs. Signatures
// start with v1.4.0; the "first hop" from v1.3.0 installs the first signed
// release, and everything after that is verified end to end.
//
// Bad-release handling:
//   * Quarantine — mark the bad release as a PRE-RELEASE on GitHub. It vanishes
//     from /releases/latest, so clients discard any downloaded copy within one
//     check cycle and stop offering it.
//   * Rollback — Streamed Arena menu -> "Roll Back to a Previous Version…"
//     downloads the newest earlier signed release and silently installs it.
//     While rolled back, the release the user fled from is not re-offered
//     automatically until something newer than it ships.
//
// Updates are always full re-downloads (~130 MB, no deltas): a fresh payload
// replaces any stale one on disk, and old payloads are deleted as soon as the
// running version catches up, so nothing lingers after it served its purpose.

const { app, dialog, net, Notification } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const { once } = require('node:events');
const {
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

// Public half of the release signing key; committed so every client shares it.
let RELEASE_KEY = null;
try {
  RELEASE_KEY = require('./release-key.json');
} catch {
  // Missing key file = nothing can ever verify — updater still runs, but
  // refuses every release. Should be impossible: the file is committed.
  RELEASE_KEY = null;
}

const REPO = 'Braedennn/streamed-arena';
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
// GitHub rewrites spaces in asset names to dots on upload.
const SETUP_ASSET_NAME = 'Streamed.Arena.Setup.exe';
const SIGNATURE_ASSET_NAME = `${SETUP_ASSET_NAME}.sig`;
const INSTALLER_SWITCHES = ['/SILENT', '/SP-', '/SUPPRESSMSGBOXES', '/NORESTART', '/UPDATE=1'];

const FIRST_CHECK_DELAY_MS = 15_000;
const CHECK_INTERVAL_MS = 2 * 60 * 60_000;
const METADATA_TIMEOUT_MS = 20_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

const updateDir = join(app.getPath('userData'), 'updates');
const setupPath = join(updateDir, 'Streamed Arena Setup.exe');
const partPath = `${setupPath}.part`;
const statePath = join(updateDir, 'state.json');
const rollbackInfoPath = join(updateDir, 'rollback.json');

let getWindow = () => null;
let downloading = false;
let promptedTag = null;
// A downloaded rollback silences automatic update offers for the session —
// don't fight a user who explicitly chose to go back.
let rollbackArmed = false;
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

let verifyKey = null;

// Signed message is "<tag>:<sha256>" — binds the payload hash to its version,
// so a valid (payload, signature) pair cannot be replayed under a newer tag.
function verifyReleaseSignature(release) {
  if (!RELEASE_KEY?.publicKey || !release?.tag || !release.sha256 || !release.signature) return false;
  try {
    verifyKey ??= crypto.createPublicKey({
      key: Buffer.from(RELEASE_KEY.publicKey, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return crypto.verify(
      null,
      Buffer.from(`${release.tag}:${release.sha256}`),
      verifyKey,
      Buffer.from(release.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

async function fetchJson(url, timeoutMs = METADATA_TIMEOUT_MS) {
  const response = await net.fetch(url, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'streamed-arena-updater' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`GitHub API replied ${response.status}`);
  return response.json();
}

function parseRelease(entry) {
  const asset = (entry.assets ?? []).find((item) => item.name === SETUP_ASSET_NAME);
  if (!asset?.browser_download_url) return null;
  const sigAsset = (entry.assets ?? []).find((item) => item.name === SIGNATURE_ASSET_NAME);
  const digest = typeof asset.digest === 'string' ? asset.digest : '';
  return {
    tag: String(entry.tag_name ?? ''),
    prerelease: Boolean(entry.prerelease),
    url: asset.browser_download_url,
    size: asset.size,
    sha256: digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : null,
    signatureUrl: sigAsset?.browser_download_url ?? null,
    // null = not fetched yet; '' = fetched but missing/empty. Verify only
    // accepts a real value, so both states fail closed.
    signature: null,
  };
}

async function ensureSignature(release) {
  if (release.signature !== null || !release.signatureUrl) return release.signature;
  const response = await net.fetch(release.signatureUrl, { signal: AbortSignal.timeout(METADATA_TIMEOUT_MS) });
  release.signature = response.ok ? (await response.text()).trim() : '';
  return release.signature;
}

async function fetchLatest() {
  const release = parseRelease(await fetchJson(`${RELEASES_API}/latest`));
  if (!release) throw new Error('latest release has no Setup.exe asset');
  release.signature = await ensureSignature(release);
  return release;
}

async function fetchRecentReleases() {
  const entries = await fetchJson(`${RELEASES_API}?per_page=10`);
  // Newest first; drafts never appear via unauthenticated API.
  return entries.map(parseRelease).filter(Boolean);
}

// Streams the installer to disk with backpressure; `once(out, 'error')` rides
// along every await so a failing disk never deadlocks the download loop.
async function downloadSetup(release, mode = 'update', extra = {}) {
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
    const hash = crypto.createHash('sha256').update(readFileSync(partPath));
    if (hash.digest('hex') !== release.sha256) {
      rmSync(partPath, { force: true });
      throw new Error('sha256 digest mismatch — download corrupted');
    }
  }
  // Atomic swap into place, then remember what the payload is.
  rmSync(setupPath, { force: true });
  renameSync(partPath, setupPath);
  const state = {
    tag: release.tag,
    url: release.url,
    size: release.size,
    sha256: release.sha256,
    mode,
    ...extra,
    path: setupPath,
    downloadedAt: new Date().toISOString(),
  };
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  return state;
}

function clearPendingUpdate() {
  rmSync(setupPath, { force: true });
  rmSync(partPath, { force: true });
  rmSync(statePath, { force: true });
}

function readRollbackInfo() {
  try {
    return JSON.parse(readFileSync(rollbackInfoPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeRollbackInfo(info) {
  try {
    mkdirSync(updateDir, { recursive: true });
    writeFileSync(rollbackInfoPath, JSON.stringify(info, null, 2));
  } catch {
    // Best-effort bookkeeping — never block a rollback on it.
  }
}

function clearRollbackInfo() {
  rmSync(rollbackInfoPath, { force: true });
}

// The pending payload, or null. An update payload is stale once the running
// version catches up; a rollback payload is stale once the running version
// moves past its target. Stale payloads are deleted on the spot.
function pendingState() {
  let state = null;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
  if (!state?.tag || state.path !== setupPath || !existsSync(state.path)) return null;

  if (state.mode === 'rollback') {
    if (isNewer(app.getVersion(), state.tag)) return state;
    // The rollback already happened — remember which release the user fled
    // from, so checkNow does not immediately re-offer it, then reclaim ~130 MB.
    if (state.rolledBackFrom) {
      writeRollbackInfo({ from: state.rolledBackFrom, to: state.tag, at: new Date().toISOString() });
    }
    clearPendingUpdate();
    return null;
  }

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

async function ask(message, detail, buttons) {
  const options = {
    type: 'question',
    title: 'Streamed Arena',
    message,
    detail,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  };
  const win = getWindow();
  const { response } =
    win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response;
}

async function offerUpdate(state, verb = 'update') {
  const rolling = verb === 'rollback';
  const options = {
    type: 'info',
    title: rolling ? 'Rollback ready' : 'Update ready',
    message: `Streamed Arena ${state.tag} is ready to ${rolling ? 'roll back to' : 'install'}`,
    detail: rolling
      ? 'The previous version downloaded in the background. Restart now and the rollback completes itself in a few seconds.'
      : 'The new version downloaded in the background. Restart now and the update installs itself in a few seconds.',
    buttons: ['Restart now', 'Later'],
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
      title: rolling ? 'Rollback deferred' : 'Update deferred',
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
    if (manual) await inform('Streamed Arena', 'Updates are checked in the installed app only.');
    return;
  }
  if (downloading) {
    if (manual) {
      await inform('Streamed Arena', 'A download is already in progress.', 'You will be notified when it is ready to install.');
    }
    return;
  }
  const armed = pendingState();
  if (rollbackArmed && armed?.mode === 'rollback') {
    if (manual) {
      await inform('Streamed Arena', `A rollback to ${armed.tag} is downloaded and waiting.`, 'Restart (Streamed Arena menu, or close the app) to complete it.');
    }
    return;
  }
  try {
    const release = await fetchLatest();
    if (!isNewer(release.tag, app.getVersion())) {
      clearPendingUpdate();
      rollbackArmed = false;
      // The app moved on — the rollback grudge is obsolete.
      const info = readRollbackInfo();
      if (info && info.to !== app.getVersion()) clearRollbackInfo();
      if (manual) await inform('Streamed Arena', 'You are up to date.', `Streamed Arena v${app.getVersion()} is the latest version.`);
      return;
    }

    // Don't re-offer the exact release the user rolled back from while they
    // are still running its predecessor; manual checks can override.
    const info = readRollbackInfo();
    if (info && app.getVersion() === info.to && release.tag === info.from) {
      if (!manual) return;
      if ((await ask(`Roll back guard`, `You previously rolled back from ${info.from}, which is still the latest release. Download it anyway?`, ['Download anyway', 'Not now'])) !== 0) {
        return;
      }
    }

    // Fail closed: an unsigned or badly signed release is never installed.
    if (!verifyReleaseSignature(release)) {
      console.warn(`[updater] refusing ${release.tag}: signature verification failed`);
      if (manual) {
        dialog.showErrorBox(
          'Streamed Arena',
          `The latest release (${release.tag}) failed signature verification.\n\n` +
            'It has NOT been downloaded. This usually means the release is missing its .sig asset or was published incorrectly — check the repository.',
        );
      }
      return;
    }

    let state = pendingState();
    if (!state || state.tag !== release.tag) {
      downloading = true;
      try {
        // Full re-download: any stale payload on disk is replaced wholesale.
        state = await downloadSetup(release, 'update');
        for (const listener of stateListeners) listener();
      } finally {
        downloading = false;
      }
    }
    // One prompt per release per session; the menu entry and the next launch
    // keep the update reachable afterwards.
    if (promptedTag !== state.tag || manual) {
      promptedTag = state.tag;
      await offerUpdate(state, 'update');
    }
  } catch (error) {
    console.warn('[updater] check failed:', error.message);
    if (manual) dialog.showErrorBox('Streamed Arena', `Update check failed:\n\n${error.message}`);
  }
}

// Downloads and installs the newest earlier signed release (menu-triggered).
async function rollback() {
  if (!app.isPackaged || process.platform !== 'win32') {
    await inform('Streamed Arena', 'Rollback works in the installed app only.');
    return;
  }
  if (downloading) {
    await inform('Streamed Arena', 'A download is already in progress.', 'You will be notified when it is ready to install.');
    return;
  }
  try {
    const releases = await fetchRecentReleases();
    const candidate = releases.find((release) => !release.prerelease && isNewer(app.getVersion(), release.tag));
    if (!candidate) {
      await inform('Streamed Arena', 'Nothing to roll back to.', 'No earlier signed release was found on GitHub.');
      return;
    }
    candidate.signature = await ensureSignature(candidate);
    if (!verifyReleaseSignature(candidate)) {
      dialog.showErrorBox(
        'Streamed Arena',
        `The previous release (${candidate.tag}) failed signature verification.\n\nNothing was downloaded. It may predate release signing (v1.4.0) or lack its .sig asset.`,
      );
      return;
    }
    const mb = Math.max(1, Math.round(candidate.size / 1e6));
    if ((await ask(`Roll back to ${candidate.tag}?`, `The previous version (~${mb} MB) downloads in the background and installs when you restart.`, ['Roll back', 'Cancel'])) !== 0) {
      return;
    }
    downloading = true;
    let state;
    try {
      state = await downloadSetup(candidate, 'rollback', { rolledBackFrom: `v${app.getVersion()}` });
    } finally {
      downloading = false;
    }
    rollbackArmed = true;
    for (const listener of stateListeners) listener();
    await offerUpdate(state, 'rollback');
  } catch (error) {
    console.warn('[updater] rollback failed:', error.message);
    dialog.showErrorBox('Streamed Arena', `Rollback failed:\n\n${error.message}`);
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
  rollback,
  restartAndInstall,
  hasPendingUpdate: () => Boolean(pendingState()),
  pendingTag: () => pendingState()?.tag ?? null,
  onStateChange: (listener) => {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
};
