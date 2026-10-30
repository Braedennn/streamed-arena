// Regression check for the server pool.
//
// Two things went wrong in the wild:
//
//  1. The provider publishes a page per quality for the same feed slot
//     ("...1080p" and "...2160p"), and every one of those pages carries a
//     token map for *all* qualities. An earlier resolver walked the pages one
//     by one, so it probed the same mirror several times and listed it
//     several times - one match showed twelve rows for six mirrors.
//
//  2. The provider changed the shape of its source lists: plain URL strings
//     became {quality, url} objects. A filter that kept only strings emptied
//     the list silently, and the app told the user that a running game "has
//     not started yet".
//
// This compiles the resolver and checks both:
//   - one candidate per (slot, quality, backend), never a duplicate
//   - only the pages the provider marks as live are probed
//   - a slot that is not switched on is not probed at all
//   - both source-list shapes are read the same way
//
// Run with: node scripts/resolver-check.mjs

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      files: [join(ROOT, 'lib', 'server', 'streamfree.ts'), join(ROOT, 'lib', 'sources.ts')],
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
  console.error(`${error.stdout ?? ''}${error.stderr ?? ''}`);
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
const { sourceUrls } = await import(pathToFileURL(join(OUT, 'lib', 'sources.js')).href);

// --- the source list shape ------------------------------------------------
const urlA = 'https://strmfree.st/embed/football/example1080p';
const urlB = 'https://strmfree.st/embed/football/example540p';
check('plain URL strings are read', sourceUrls([urlA, urlB]).length === 2, JSON.stringify(sourceUrls([urlA, urlB])));
check(
  '{quality, url} objects are read',
  sourceUrls([{ quality: 'FHD', url: urlA }, { quality: 'SD', url: urlB }]).join(',') === `${urlA},${urlB}`,
  JSON.stringify(sourceUrls([{ quality: 'FHD', url: urlA }])),
);
check('a mixed list is read', sourceUrls([urlA, { quality: 'SD', url: urlB }]).length === 2);
check('junk is ignored', sourceUrls([null, 3, {}, { quality: 'FHD' }]).length === 0, JSON.stringify(sourceUrls([null, 3, {}, { quality: 'FHD' }])));
check('a missing list is empty', sourceUrls(undefined).length === 0);

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
  'both live qualities of the slot are probed',
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

// 3. A published page that is not live is not probed - its media is not up.
const onlyFhd = buildCandidates(KEY, [slot1_1080, slot2_1080], [slot1_1080.url], true);
const onlyFhdIds = onlyFhd.map((candidate) => `${candidate.slot}-${candidate.quality}-${candidate.backend}`);
check(
  'only the live page of a slot is probed',
  onlyFhdIds.length === 3 && onlyFhdIds.every((id) => id.startsWith('1-1080p-')),
  onlyFhdIds.join(', '),
);

// 4. With both slots live, every mirror is listed exactly once.
const bothLive = buildCandidates(KEY, pages, [slot1_1080.url, slot1_2160.url, slot2_1080.url], true);
const bothIds = bothLive.map((candidate) => `${candidate.slot}-${candidate.quality}-${candidate.backend}`);
check('two live slots still have no duplicates', new Set(bothIds).size === bothIds.length, bothIds.join(', '));
check(
  'the second slot is probed once it is live',
  bothIds.filter((id) => id.startsWith('2-')).length === 3,
  bothIds.join(', '),
);

// 5. The embed flag is the fallback when the sources API could not be read.
const apiDown = buildCandidates(KEY, pages, [], false);
const apiDownIds = apiDown.map((candidate) => `${candidate.slot}-${candidate.quality}-${candidate.backend}`);
check(
  'the embed flag decides which slot is live when the API is down',
  apiDownIds.length > 0 && apiDownIds.every((id) => id.startsWith('1-')),
  apiDownIds.join(', '),
);

// 6. A slot yields one rendition per published page - the token map lists all
//    qualities, but only the published ones exist as streams.
const onePage = renditionsForSlot([slot1_1080]);
check('one page yields one rendition', onePage.length === 1, onePage.map((r) => r.quality).join(', '));
check('the rendition is the page quality', onePage[0]?.quality === '1080p', onePage[0]?.quality ?? '');
const twoPages = renditionsForSlot([slot1_1080, slot1_2160]);
check(
  'two pages yield two renditions, best first',
  twoPages.map((r) => r.quality).join(',') === '2160p,1080p',
  twoPages.map((r) => r.quality).join(','),
);

// --- report ---------------------------------------------------------------
const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

rmSync(OUT, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
