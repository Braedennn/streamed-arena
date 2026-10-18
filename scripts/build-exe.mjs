import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const filterDir = join(root, 'electron', 'extensions', 'netfilter');
if (!existsSync(join(filterDir, 'manifest.json'))) {
  console.log('[0/3] Fetching filter engine...');
  const tmp = join(root, '.next-standalone', 'filter-download');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const zip = join(tmp, 'engine.zip');
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Invoke-WebRequest -Uri 'https://github.com/gorhill/uBlock/releases/download/1.75.0/uBlock0_1.75.0.chromium.zip' -OutFile '${zip}' -TimeoutSec 120; ` +
    `Expand-Archive -Path '${zip}' -DestinationPath '${tmp}' -Force`,
  ], { stdio: 'inherit' });
  const inner = join(tmp, 'uBlock0.chromium');
  if (!existsSync(join(inner, 'manifest.json'))) throw new Error('filter engine download failed');
  mkdirSync(dirname(filterDir), { recursive: true });
  rmSync(filterDir, { recursive: true, force: true });
  renameSync(inner, filterDir);
  rmSync(tmp, { recursive: true, force: true });
}

console.log('[1/3] Building standalone Next.js server...');
execFileSync(process.execPath, [join(root, 'node_modules', 'next', 'dist', 'bin', 'next'), 'build'], {
  cwd: root,
  env: { ...process.env, BUILD_STANDALONE: '1', NODE_ENV: 'production' },
  stdio: 'inherit',
});

const standaloneDir = join(root, '.next-standalone', 'standalone');
const standaloneStatic = join(standaloneDir, '.next-standalone', 'static');
console.log('[2/3] Copying client assets into standalone bundle...');
cpSync(join(root, '.next-standalone', 'static'), standaloneStatic, { recursive: true });
rmSync(join(standaloneDir, '.next'), { recursive: true, force: true });

const serverJs = join(root, '.next-standalone', 'standalone', 'server.js');
if (!existsSync(serverJs)) throw new Error(`standalone server.js missing at ${serverJs}`);

// Runtime image cache written by the embedded server inside the packaged app:
// strip it so it never ships in the payload (paths exceed MAX_PATH).
const runtimeCache = join(standaloneDir, '.next-standalone', 'cache');
if (existsSync(runtimeCache)) {
  console.log('[*] Stripping runtime image cache from the payload...');
  rmSync(runtimeCache, { recursive: true, force: true });
}

console.log('[3/3] Packaging Windows executable...');
const packagerModule = require('@electron/packager');
const packager = packagerModule.packager ?? packagerModule.default ?? packagerModule;
const electronVersion = require('electron/package.json').version;

const appPaths = await packager({
  dir: root,
  out: join(root, 'release'),
  name: 'Streamed Arena',
  platform: 'win32',
  arch: 'x64',
  electron: electronVersion,
  overwrite: true,
  icon: join(root, 'electron', 'icon.ico'),
  appBundleId: 'com.streamed.arena',
  appCopyright: 'TotallyNoire',
  win32metadata: {
    CompanyName: 'TotallyNoire',
    FileDescription: 'Streamed Arena — live sports streaming',
    ProductName: 'Streamed Arena',
    OriginalFilename: 'Streamed Arena.exe',
  },
  asar: false,
  ignore: (filePath) => {
    const rel = filePath.replace(/^\//, '').replace(/\\/g, '/');
    if (rel === 'package.json' || rel === '') return false;
    if (rel === 'electron' || rel.startsWith('electron/')) return false;
    if (rel === '.next-standalone') return false;
    if (rel.startsWith('.next-standalone/')) return !rel.startsWith('.next-standalone/standalone');
    return true;
  },
});

console.log('DONE');
for (const appPath of appPaths) {
  console.log('  ' + appPath);
}
