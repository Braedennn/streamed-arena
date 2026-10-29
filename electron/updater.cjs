// Auto-update from GitHub Releases.
//
// Packaging here is @electron/packager + Inno Setup, not electron-builder, so
// electron-updater is not a fit (it expects NSIS installers plus blockmap
// metadata). This module talks to the Releases API directly instead:
//
//   launch + every 2 h  ->  GET /releases/latest  ->  tag newer than app.getVersion()
//   ->  verify the Ed25519 release signature (see scripts/sign-release.mjs)
//   ->  download the Setup.exe into userData/updates (size + sha256 verified)
//   ->  a themed in-app popup (rendered by the site via the preload bridge)
//       offers a one-click restart; dismissed popups return next launch and
//       the menu keeps the update reachable — nothing is ever forced
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

const { app, dialog, ipcMain, net, shell } = require('electron');
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
// The repository's release feed. It is a plain web request (not the REST
// API), so polling it costs no rate limit — which is what makes a fast
// update check possible at all.
const RELEASES_FEED = `https://github.com/${REPO}/releases.atom`;
// GitHub rewrites spaces in asset names to dots on upload.
const SETUP_ASSET_NAME = 'Streamed.Arena.Setup.exe';
const SIGNATURE_ASSET_NAME = `${SETUP_ASSET_NAME}.sig`;
const INSTALLER_SWITCHES = ['/SILENT', '/SP-', '/SUPPRESSMSGBOXES', '/NORESTART', '/UPDATE=1'];

const FIRST_CHECK_DELAY_MS = 15_000;
// How often the release feed is watched. A release published now is on the
// feed within seconds, so the popup appears about a minute later instead of
// up to two hours later.
const FEED_CHECK_INTERVAL_MS = 60_000;
// The REST API is rate limited (60 requests/hour per IP, and even a 304
// counts), so it is only consulted when the feed says something changed —
// plus this slow backstop in case the feed is unreachable.
const API_CHECK_INTERVAL_MS = 15 * 60_000;
// Minimum gap between two release-feed requests caused by window focus.
const FOCUS_CHECK_MIN_GAP_MS = 60_000;
// Below this many API calls left in the window, the API is left alone.
const API_BUDGET_FLOOR = 2;
// A failed download is not retried on every single poll.
const DOWNLOAD_RETRY_MS = 10 * 60_000;
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
let promptedPhase = null;
// Fingerprint of the newest entry of the release feed ("tag@updated"). A
// change means "something happened on GitHub" — a new release, or an existing
// one that was edited (e.g. a pre-release promoted to a full release).
let feedFingerprint = null;
// Remaining REST API calls in the current rate-limit window (null = unknown).
let apiBudget = null;
let lastApiCheckAt = 0;
let lastFeedCheckAt = 0;
let lastDownloadAttempt = { tag: null, at: 0 };
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
  noteApiBudget(response);
  if (!response.ok) throw new Error(`GitHub API replied ${response.status}`);
  return response.json();
}

// How many REST calls are left in the current window. The feed is the fast
// path, so the API budget is only spent when it really has to be.
function noteApiBudget(response) {
  const remaining = response.headers.get('x-ratelimit-remaining');
  if (remaining !== null) {
    const value = Number(remaining);
    if (Number.isFinite(value)) apiBudget = value;
  }
}

function apiBudgetLeft() {
  return apiBudget === null ? true : apiBudget > API_BUDGET_FLOOR;
}

/**
 * The newest release as listed by the repository's release feed.
 *
 * The feed is a normal web request with no rate limit, so it can be watched
 * every minute. It is only a trigger: the release itself is still fetched
 * through the REST API, which knows about assets, signatures and the
 * pre-release flag.
 */
function parseFeed(xml) {
  const entry = xml.match(/<entry>([\s\S]*?)<\/entry>/)?.[1] ?? '';
  if (!entry) return null;
  const tag = entry.match(/<id>[^<]*\/([^/<]+)<\/id>/)?.[1]?.trim() ?? '';
  const updated = entry.match(/<updated>(.*?)<\/updated>/)?.[1]?.trim() ?? '';
  if (!tag) return null;
  return { tag, updated };
}

async function fetchFeed() {
  const response = await net.fetch(RELEASES_FEED, {
    headers: { Accept: 'application/atom+xml', 'User-Agent': 'streamed-arena-updater' },
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`release feed replied ${response.status}`);
  return parseFeed(await response.text());
}

/** True when the feed shows something we have not looked at yet. */
async function feedChanged() {
  lastFeedCheckAt = Date.now();
  const entry = await fetchFeed();
  if (!entry) return false;
  const fingerprint = `${entry.tag}@${entry.updated}`;
  if (fingerprint === feedFingerprint) return false;
  feedFingerprint = fingerprint;
  return true;
}

function parseRelease(entry) {
  const asset = (entry.assets ?? []).find((item) => item.name === SETUP_ASSET_NAME);
  if (!asset?.browser_download_url) return null;
  const sigAsset = (entry.assets ?? []).find((item) => item.name === SIGNATURE_ASSET_NAME);
  const digest = typeof asset.digest === 'string' ? asset.digest : '';
  return {
    tag: String(entry.tag_name ?? ''),
    name: String(entry.name ?? ''),
    body: String(entry.body ?? ''),
    publishedAt: typeof entry.published_at === 'string' ? entry.published_at : null,
    prerelease: Boolean(entry.prerelease),
    // Releases without a .sig asset predate release signing (v1.4.0) and can
    // never pass verification — the versions panel locks them.
    signed: Boolean(sigAsset),
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

// The ready prompt lives in the app's own UI: a themed, dismissible popup
// rendered by the site (components/updater/UpdatePopup.tsx) through the
// preload bridge. No native modal, no stolen focus — the user is informed,
// not cornered. If the window is somehow gone, the payload and the menu
// entry carry the update instead.
function announceUpdate(payload) {
  const win = getWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send('arena-updater-ready', {
    tag: payload.tag,
    mode: payload.mode === 'rollback' ? 'rollback' : 'update',
    // 'downloading' = the release is known and being fetched right now,
    // 'ready' = it is on disk and can be installed.
    phase: payload.phase === 'downloading' ? 'downloading' : 'ready',
  });
}

// One popup per release per phase: the user sees "downloading" once and
// "ready to install" once, not a stream of repeats.
function announcePhase(tag, mode, phase, manual) {
  if (!manual && promptedTag === tag && promptedPhase === phase) return;
  promptedTag = tag;
  promptedPhase = phase;
  announceUpdate({ tag, mode, phase });
}

// Launch attempts get a short grace window: Windows reports some spawn
// failures synchronously (a throw out of spawn() itself) and others
// asynchronously (an 'error' event on the child). Either way the attempt
// settles here, so callers never see a stray ChildProcess crash.
function attemptLaunch(spawnFn) {
  return new Promise((resolve) => {
    let settled = false;
    let child;
    try {
      child = spawnFn();
      child.unref();
    } catch (error) {
      resolve({ ok: false, error });
      return;
    }
    child.once('error', (error) => {
      if (!settled) {
        settled = true;
        resolve({ ok: false, error });
      }
    });
    // No error within the window = the process took.
    setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve({ ok: true });
      }
    }, 800);
  });
}

// Launching a downloaded installer can be refused by Windows itself — AV
// on-execute scans and policy engines (AppLocker & friends) deny the launch
// with errors libuv surfaces as "spawn UNKNOWN". That used to escape the IPC
// handler as an uncaught exception and kill the app. Now the launch falls
// back through progressively different mechanisms, and if every one is
// refused the user gets the file location instead of a crash — the payload
// stays on disk for a manual run or a menu retry.
async function launchInstaller(state) {
  // Path A — direct detached spawn (the fast path).
  const direct = await attemptLaunch(() =>
    spawn(state.path, INSTALLER_SWITCHES, { detached: true, stdio: 'ignore' }));
  if (direct.ok) return { ok: true };
  console.warn('[updater] direct launch failed:', direct.error?.code ?? direct.error?.message);

  // Path B — PowerShell Start-Process: routes through ShellExecuteEx rather
  // than a direct CreateProcess (which some filter drivers treat differently)
  // and, unlike cmd's `start`, reports launch failure through its exit code.
  // A blocked ShellExecuteEx (e.g. a native "cannot run" prompt) would hang
  // PowerShell, so the attempt is raced against a timeout and the child is
  // killed if it never answers.
  let psChild = null;
  const viaPosh = await Promise.race([
    new Promise((resolve) => {
      try {
        const ps = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const target = state.path.replace(/'/g, "''");
        const switches = INSTALLER_SWITCHES.join(' ').replace(/'/g, "''");
        psChild = spawn(
          ps,
          ['-NoProfile', '-Command', `Start-Process -FilePath '${target}' -ArgumentList '${switches}'`],
          { stdio: 'ignore', windowsHide: true },
        );
        psChild.once('error', (error) => resolve({ ok: false, error }));
        psChild.once('exit', (code) => (code === 0 ? resolve({ ok: true }) : resolve({ ok: false, error: new Error(`exit ${code}`) })));
      } catch (error) {
        resolve({ ok: false, error });
      }
    }),
    new Promise((resolve) => {
      setTimeout(() => resolve({ ok: false, error: new Error('timed out after 15 s') }), 15_000);
    }),
  ]);
  try {
    psChild?.kill();
  } catch {
    // already gone
  }
  if (viaPosh.ok) return { ok: true, degraded: 'powershell' };
  console.warn('[updater] powershell launch failed:', viaPosh.error?.code ?? viaPosh.error?.message);

  // Path C — last resort: open the installer without silent switches. It
  // runs as a normal interactive setup (its taskkill step still replaces
  // the running app; the wizard's launch checkbox covers the restart).
  // openPath can block on a native prompt too, so it gets the same race.
  try {
    const problem = await Promise.race([
      shell.openPath(state.path),
      new Promise((resolve) => {
        setTimeout(() => resolve('timed out after 10 s'), 10_000);
      }),
    ]);
    if (!problem) return { ok: true, degraded: 'interactive' };
    console.warn('[updater] openPath refused:', problem);
  } catch (error) {
    console.warn('[updater] openPath threw:', error.message);
  }
  return { ok: false };
}

async function restartAndInstall() {
  try {
    const state = pendingState();
    if (!state) return;
    const result = await launchInstaller(state);
    if (result.ok) {
      // Detached + unref: the installer outlives this process. The Inno
      // script taskkills any remaining Streamed Arena.exe at ssInstall —
      // which also covers the embedded server child, since it runs as the
      // same exe — and relaunches the app after installing via the /UPDATE=1
      // [Run] entry.
      app.quit();
      return;
    }
    dialog.showErrorBox(
      'Streamed Arena',
      `Windows refused to launch the update installer:\n\n${state.path}\n\n` +
        'This is almost always antivirus interference — a code-signed installer (see the README) fixes it.\n\n' +
        'The update stays downloaded: run the file above by hand, or retry any time from the Streamed Arena menu.',
    );
  } catch (error) {
    console.warn('[updater] restart failed:', error.message);
    dialog.showErrorBox('Streamed Arena', `Could not start the update:\n\n${error.message}`);
  }
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
  // A version explicitly queued from the versions panel is the user's
  // standing choice — never override it with auto-offers.
  const queued = pendingState();
  if (queued?.installOnNextLaunch) {
    if (manual) {
      await inform(
        'Streamed Arena',
        `${queued.tag} is queued to install on the next launch.`,
        'Pick a different version any time from the versions panel (the gear icon).',
      );
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
    lastApiCheckAt = Date.now();
    // The REST API is rate limited, so an automatic check gives up when the
    // budget is spent — the release feed (checked every minute) will pick it
    // up later instead. A manual check always goes through.
    if (!manual && !apiBudgetLeft()) {
      console.warn('[updater] skipping automatic check: API budget spent');
      return;
    }
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
    const needsDownload = !state || state.tag !== release.tag;
    if (needsDownload) {
      // A failed download is not retried on every single poll.
      const retryable =
        lastDownloadAttempt.tag === release.tag && Date.now() - lastDownloadAttempt.at < DOWNLOAD_RETRY_MS;
      if (!retryable) {
        lastDownloadAttempt = { tag: release.tag, at: Date.now() };
        // Say so straight away: the popup must not wait for a 124 MB download
        // before the user learns there is a new version. Forced, so a retry
        // after a failed download still tells the user something is happening.
        announcePhase(release.tag, 'update', 'downloading', true);
        downloading = true;
        try {
          // Full re-download: any stale payload on disk is replaced wholesale.
          state = await downloadSetup(release, 'update');
          for (const listener of stateListeners) listener();
        } finally {
          downloading = false;
        }
      }
    }
    if (state && state.tag === release.tag) {
      // Now the installer is on disk and can be installed.
      announcePhase(state.tag, 'update', 'ready', manual);
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
    announcePhase(state.tag, 'rollback', 'ready', true);
  } catch (error) {
    console.warn('[updater] rollback failed:', error.message);
    dialog.showErrorBox('Streamed Arena', `Rollback failed:\n\n${error.message}`);
  }
}

// The versions panel: install ANY signed release, up or down. The panel
// grays out pre-releases and unsigned legacy releases, but main enforces
// the same rules — the renderer is never trusted with update policy.
// 'action' decides when: 'now' restarts into the installer immediately,
// 'later' queues the payload to install itself on the next launch.
async function selectVersion(tag, action) {
  try {
    if (!app.isPackaged || process.platform !== 'win32') {
      return { ok: false, error: 'Version switching works in the installed app only.' };
    }
    if (typeof tag !== 'string' || (action !== 'now' && action !== 'later')) {
      return { ok: false, error: 'Bad request.' };
    }
    const current = app.getVersion();
    if (tag === current || tag === `v${current}`) {
      return { ok: false, error: 'That version is already running.' };
    }
    const releases = await fetchRecentReleases();
    const release = releases.find((entry) => entry.tag === tag);
    if (!release) return { ok: false, error: 'That release is not on GitHub (or has no installer).' };
    if (release.prerelease) return { ok: false, error: 'Pre-releases are quarantined and cannot be installed.' };
    if (!release.signed || !release.signatureUrl || !release.sha256) {
      return { ok: false, error: 'That release predates signed releases and cannot be verified.' };
    }

    let state = pendingState();
    if (!state || state.tag !== tag) {
      release.signature = await ensureSignature(release);
      if (!verifyReleaseSignature(release)) {
        return { ok: false, error: 'Signature verification failed — nothing was downloaded.' };
      }
      if (downloading) return { ok: false, error: 'Another download is already in progress.' };
      downloading = true;
      try {
        const mode = isNewer(tag, current) ? 'update' : 'rollback';
        state = await downloadSetup(release, mode, { installOnNextLaunch: action === 'later' });
      } finally {
        downloading = false;
      }
    } else if (state.installOnNextLaunch !== (action === 'later')) {
      // Payload already on disk — only change when it applies.
      state = { ...state, installOnNextLaunch: action === 'later' };
      writeFileSync(statePath, JSON.stringify(state, null, 2));
    }
    if (action === 'now') {
      void restartAndInstall();
      return { ok: true, restarting: true };
    }
    return { ok: true, queued: true };
  } catch (error) {
    console.warn('[updater] version select failed:', error.message);
    return { ok: false, error: error.message };
  }
}

/**
 * The automatic check.
 *
 * The release feed is watched every minute — it costs no rate limit and
 * reflects a new release within seconds. Only when the feed actually changed
 * (or the slow API backstop is due) is the REST API consulted, so a new
 * version is picked up in about a minute instead of up to two hours.
 */
async function scheduledCheck() {
  if (downloading) return;

  let changed = false;
  try {
    changed = await feedChanged();
  } catch (error) {
    console.warn('[updater] release feed check failed:', error.message);
  }

  const backstopDue = Date.now() - lastApiCheckAt >= API_CHECK_INTERVAL_MS;
  if (!changed && !backstopDue) return;

  await checkNow();
}
function start(windowGetter) {
  if (windowGetter) getWindow = windowGetter;

  // Renderer bridge for the in-app update popup and versions panel (see
  // preload.cjs). Registered before the platform guard so the bridge always
  // answers — even in dev runs, where auto-update itself stays off.
  ipcMain.handle('arena-updater-state', () => {
    const state = pendingState();
    if (!state) return null;
    return {
      tag: state.tag,
      mode: state.mode === 'rollback' ? 'rollback' : 'update',
      // A release that is on disk is always ready to install.
      phase: 'ready',
    };
  });
  ipcMain.on('arena-updater-restart', () => {
    void restartAndInstall();
  });
  ipcMain.handle('arena-updater-releases', async () => {
    const state = pendingState();
    const pending = state
      ? {
          tag: state.tag,
          mode: state.mode === 'rollback' ? 'rollback' : 'update',
          installOnNextLaunch: Boolean(state.installOnNextLaunch),
        }
      : null;
    try {
      const releases = await fetchRecentReleases();
      return {
        current: app.getVersion(),
        pending,
        releases: releases.map((entry) => ({
          tag: entry.tag,
          name: entry.name,
          body: entry.body,
          publishedAt: entry.publishedAt,
          prerelease: entry.prerelease,
          signed: entry.signed,
          size: entry.size,
        })),
      };
    } catch (error) {
      return { current: app.getVersion(), pending, releases: [], error: error.message };
    }
  });
  ipcMain.handle('arena-updater-select', (_event, payload) => selectVersion(payload?.tag, payload?.action));

  if (!app.isPackaged || process.platform !== 'win32') return;
  pendingState();
  // A version queued from the versions panel ("apply on next launch")
  // installs itself once the window is up — that was the whole promise.
  const queued = pendingState();
  if (queued?.installOnNextLaunch) {
    setTimeout(() => {
      void restartAndInstall();
    }, FIRST_CHECK_DELAY_MS);
  }
  setTimeout(() => {
    void scheduledCheck();
  }, FIRST_CHECK_DELAY_MS);
  setInterval(() => {
    void scheduledCheck();
  }, FEED_CHECK_INTERVAL_MS);
  // Coming back to the app is a good moment to look: the user is here and
  // an outdated build is exactly what they would want to know about.
  // Throttled, so alt-tabbing around cannot hammer GitHub.
  const onFocus = () => {
    if (Date.now() - lastFeedCheckAt < FOCUS_CHECK_MIN_GAP_MS) return;
    void scheduledCheck();
  };
  app.on('browser-window-focus', onFocus);
  app.on('before-quit', () => rmSync(partPath, { force: true }));
}

module.exports = {
  start,
  checkNow,
  // The feed-driven automatic check. Exported for the updater's own tests.
  scheduledCheck,
  rollback,
  restartAndInstall,
  hasPendingUpdate: () => Boolean(pendingState()),
  pendingTag: () => pendingState()?.tag ?? null,
  onStateChange: (listener) => {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
};
