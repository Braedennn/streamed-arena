// Regression check for the server pool.
//
// The provider publishes a page per quality for the same feed slot
// ("...1080p" and "...2160p"), and every one of those pages carries a token
// map for *all* qualities. An earlier resolver walked the pages one by one,
// so it probed the same mirror several times and listed it several times —
// one match showed twelve rows for six mirrors.
//
// This compiles the resolver and checks the candidate list it builds:
//   - one candidate per (slot, quality, backend), never a duplicate
//   - a slot that is not switched on is not probed at all
//   - the token of a quality comes from the page that is that quality
//
// Run with: node scripts/resolver-check.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Module from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = mkdtempSync(join(tmpdir(), 'arena-resolver-check-'));

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
}

// --- compile the resolver -------------------------------------------------
const tsconfigPath = join(OUT, 'tsconfig.check.json');
writeFileSync(
  tsconfigPath,
  JSON.stringify(
    {
      extends: join(ROOT, 'tsconfig.json'),
      compilerOptions: {
        noEmit: false,
        outDir: OUT,
        module: 'commonjs',
        moduleResolution: 'node',
        esModuleInterop: true,
        skipLibCheck: true,
        strict: true,
        declaration: false,
        incremental: false,
        isolatedModules: false,
        jsx: 'preserve',
        lib: ['es2022', 'dom'],
      },
      files: [join(ROOT, 'lib', 'server', 'streamfree.ts')],
    },
    null,
    2,
  ),
);
try {
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', tsconfigPath],
    { cwd: ROOT, stdio: 'pipe' },
  );
} catch (error) {
  const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  console.error(output);
  console.error('resolver-check: the resolver did not compile');
  process.exit(1);
}

// The compiled output keeps the "@/..." path alias; point it at the output.
const resolveFilename = Module._resolveFilename;
Module._resolveFilename = function patched(request, ...rest) {
  const target = request.startsWith('@/')
    ? join(OUT, request.slice(2).replace(/\.ts$/, '.js'))
    : request;
  return resolveFilename.call(this, target, ...rest);
};

const compiled = join(OUT, 'lib', 'server', 'streamfree.js');
const { buildCandidates, renditionsForSlot } = await import(pathToFileURL(compiled).href);

// --- fixtures -------------------------------------------------------------
// The pages of a match that publishes a 4K page for the same slot, exactly
// as the provider does it: two pages for slot 1 and one for slot 2.
const KEY = 'carolina-panthers-vs-green-bay-packers';

function page(url, quality, suffix, isLive, tokenSuffix) {
  const tokens = {};
  for (const q of ['1080p', '2160p', '540p', '720p']) {
    tokens[q] = { _t: `${q}-token-${tokenSuffix}`, _e: 1793359464, _n: `nonce-${tokenSuffix}` };
  }
  return { quality, suffix, isLive, tokens, url };
}

const slot1_1080 = page(`${KEY}1080p`, '1080p', '', true, 'a');
const slot1_2160 = page(`${KEY}2160p`, '2160p', '', true, 'b');
const slot2_1080 = page(`${KEY}1080p2`, '1080p', '2', false, 'c');
const pages = [slot1_1080, slot1_2160, slot2_1080];

// 1. The duplicate case: two pages for slot 1, only slot 1 is live.
const liveSlot1 = buildCandidates(KEY, pages, [slot1_1080.url, slot1_2160.url], true);
const ids = liveSlot1.map((candidate) => `${candidate.slot}-${candidate.quality}-${candidate.backend}`);
check('no duplicate mirror is probed twice', new Set(ids).size === ids.length, ids.join(', '));
check('the dead slot is not probed', !ids.some((id) => id.startsWith('2-')), ids.join(', '));
check(
  'both published qualities of the live slot are probed',
  ['1-1080p-cdn', '1-2160p-cdn'].every((id) => ids.includes(id)),
  ids.join(', '),
);
check(
  'every backend of a quality is probed once',
  ids.filter((id) => id === '1-1080p-cdn').length === 1,
  ids.join(', '),
);

// 2. The token of a quality comes from the page that is that quality.
const cdn2160 = liveSlot1.find((candidate) => candidate.quality === '2160p' && candidate.backend === 'cdn');
check(
  'the 4K token comes from the 4K page',
  Boolean(cdn2160?.manifestUrl.includes('2160p-token-b')),
  cdn2160?.manifestUrl ?? '',
);
const cdn1080 = liveSlot1.find((candidate) => candidate.quality === '1080p' && candidate.backend === 'cdn');
check(
  'the 1080p token comes from the 1080p page',
  Boolean(cdn1080?.manifestUrl.includes('1080p-token-a')),
  cdn1080?.manifestUrl ?? '',
);

// 3. With both slots live, every mirror is listed exactly once.
const bothLive = buildCandidates(KEY, pages, [slot1_1080.url, slot1_2160.url, slot2_1080.url], true);
const bothIds = bothLive.map((candidate) => `${candidate.slot}-${candidate.quality}-${candidate.backend}`);
check('two live slots still have no duplicates', new Set(bothIds).size === bothIds.length, bothIds.join(', '));
check(
  'the second slot is probed once it is live',
  bothIds.filter((id) => id.startsWith('2-')).length === 12,
  bothIds.join(', '),
);

// 4. The embed flag is the fallback when the sources API could not be read.
const apiDown = buildCandidates(KEY, pages, [], false);
const apiDownIds = apiDown.map((candidate) => `${candidate.slot}-${candidate.quality}-${candidate.backend}`);
check(
  'the embed flag decides which slot is live when the API is down',
  apiDownIds.length > 0 && apiDownIds.every((id) => id.startsWith('1-')),
  apiDownIds.join(', '),
);

// 5. A slot with one page still offers every quality in its token map.
const onePage = renditionsForSlot([slot1_1080]);
check('one page yields all four qualities', onePage.length === 4, onePage.map((r) => r.quality).join(', '));
check('the best quality comes first', onePage[0]?.quality === '2160p', onePage[0]?.quality ?? '');

// --- report ---------------------------------------------------------------
const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

rmSync(OUT, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
