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
      files: [
        join(ROOT, 'lib', 'server', 'streamfree.ts'),
        join(ROOT, 'lib', 'server', 'provider.ts'),
        join(ROOT, 'lib', 'server', 'espn-watch.ts'),
        join(ROOT, 'lib', 'sources.ts'),
        join(ROOT, 'lib', 'broadcasters.ts'),
      ],
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
const { buildCandidates, renditionsForSlot, looksLikeMedia } = await import(pathToFileURL(compiled).href);
const { sourceUrls } = await import(pathToFileURL(join(OUT, 'lib', 'sources.js')).href);
const { directMediaUrl } = await import(pathToFileURL(join(OUT, 'lib', 'server', 'provider.js')).href);
const { isBlockedFeed, BLOCKED_LEAGUES } = await import(
  pathToFileURL(join(OUT, 'lib', 'broadcasters.js')).href
);
const { parseWatchListings, skycastMatchups, skycastOnlyGames, isSkycastMatchup, isCollegeFootball } =
  await import(pathToFileURL(join(OUT, 'lib', 'server', 'espn-watch.js')).href);

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

// 7. A match the provider has not switched on yet is probed anyway.
//
//    The provider's own "this feed is live" flag and the media do not always
//    agree: the flag lags behind, and it has been known to stay off while the
//    media was already up. The media is the ground truth, so the published
//    slot is probed even when no slot is flagged live - that is what puts the
//    server rows on the screen before the kick-off instead of a good while
//    after it.
const notStarted = buildCandidates(KEY, [slot1_1080, slot2_1080], [], true, true);
const notStartedIds = notStarted.map((c) => `${c.slot}-${c.quality}-${c.backend}`);
check(
  'a match that is not switched on yet is probed anyway',
  notStartedIds.includes('1-1080p-cdn') && notStartedIds.includes('1-1080p-origin'),
  notStartedIds.join(', '),
);
check(
  'the published slot is probed once per mirror',
  notStartedIds.filter((id) => id.startsWith('1-1080p-')).length === 3,
  notStartedIds.join(', '),
);
check(
  'a slot that is not published as live is still left alone',
  !notStartedIds.some((id) => id.startsWith('2-')),
  notStartedIds.join(', '),
);
check(
  'without the early probe a match that is not switched on yields nothing',
  buildCandidates(KEY, [slot1_1080, slot2_1080], [], true).length === 0,
);

// --- feeds the app refuses --------------------------------------------------
// The provider names no broadcaster, so a feed is recognised by the names it
// does print. A feed the provider calls "Skycast" never reaches the player.
check(
  'a feed the provider calls Skycast is refused',
  isBlockedFeed({ name: 'Skycast' }) && isBlockedFeed({ league: 'skycast' }) &&
    isBlockedFeed({ streamKey: 'skycast-rivalry' }) && isBlockedFeed({ embedName: 'Skycast' }),
);
check(
  'a feed with a similar name is not refused',
  !isBlockedFeed({ name: 'Sky Sports F1' }) && !isBlockedFeed({ league: 'SKY' }) &&
    !isBlockedFeed({ streamKey: 'skysportscricket' }),
);
check(
  'an ordinary feed is not refused',
  !isBlockedFeed({ name: 'Fulham vs Aston Villa', category: 'soccer', league: 'Premier League' }),
);

// The rule engine has to honour the league list as it is configured - the
// list itself changes with the competitions that are refused.
BLOCKED_LEAGUES.push('Refused-League');
check(
  'a competition on the refused list is refused',
  isBlockedFeed({ name: 'Any game', league: 'Refused-League' }) &&
    isBlockedFeed({ name: 'Any game', category: 'refused-league' }),
);
BLOCKED_LEAGUES.pop();
check(
  'a competition that is not on the refused list is kept',
  !isBlockedFeed({ name: 'Any game', league: 'Premier League' }),
);

// --- what a segment actually contains --------------------------------------
// The provider's "external" mirror answers with a placeholder image: the
// playlist is fine, the segment URL answers 200, and the payload is a PNG.
// A mirror that serves pictures cannot be played, so the resolver has to
// recognise it and keep it out of the pool.
const mpegTs = Buffer.concat([
  Buffer.from([0x47]),
  Buffer.alloc(187),
  Buffer.from([0x47]),
  Buffer.alloc(187),
]);
const png = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);
const fmp4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.alloc(16),
]);
check('MPEG-TS is recognised as media', looksLikeMedia(mpegTs));
check('an image is not recognised as media', !looksLikeMedia(png));
check('fMP4 is recognised as media', looksLikeMedia(fmp4));
check('a too-short answer is not media', !looksLikeMedia(Buffer.from([0x47])));
check('an empty answer is not media', !looksLikeMedia(Buffer.alloc(0)));

// --- where the media may be fetched from ------------------------------------
// The main site and the mirror hand their media to the browser: they answer
// any Referer and reflect the Origin header. The CDN edge wants the
// provider's Referer, but it serves the very same files as the main site, so
// the player can take them from there.
check(
  'the main site is fetched directly',
  directMediaUrl(new URL('https://strmfree.st/live/x/1.js')) ===
    'https://strmfree.st/live/x/1.js',
);
check(
  'the mirror is fetched directly',
  directMediaUrl(new URL('https://streamfree.top/live/x/1.js')) ===
    'https://streamfree.top/live/x/1.js',
);
check(
  'the CDN edge is taken from the main site',
  directMediaUrl(new URL('https://cdn1.strmfree.st/live/x/1.js')) ===
    'https://strmfree.st/live/x/1.js',
);
check(
  'a foreign host is never fetched directly',
  directMediaUrl(new URL('https://evil.example/live/x/1.js')) === null,
);
check(
  'a lookalike host is never fetched directly',
  directMediaUrl(new URL('https://strmfree.st.evil.example/live/x/1.js')) === null,
);
check(
  'a lookalike mirror is never fetched directly',
  directMediaUrl(new URL('https://streamfree.top.evil.example/live/x/1.js')) === null,
);

// --- the SkyCast list -------------------------------------------------------
// The provider names no broadcaster, so ESPN's watch schedule is where the
// name comes from: it lists the games it offers as SkyCast - the college
// football alternate with the picture and the crowd but no announcers.
const WATCH_ROWS = [
  '<td class="Table__TD--time Table__TD">7:30 pm</td>',
  '<td class="Table__TD--name Table__TD"><a class="AnchorLink" href="/watch/player/_/id/aaa">Mississippi State vs. #11 Texas</a></td>',
  '<td class="Table__TD--logo Table__TD"><img src="x.png" alt="espn1"/></td>',
  '<td class="Table__TD--name Table__TD"><a class="AnchorLink" href="/watch/player/_/id/ddd">#1 Miami vs. North Carolina</a></td>',
  '<td class="Table__TD--logo Table__TD"><img src="w.png" alt="espn_on_abc_events"/></td>',
  '<td class="Table__TD--name Table__TD"><a class="AnchorLink" href="/watch/player/_/id/bbb">SkyCast - #1 Miami vs. North Carolina (SkyCast)</a></td>',
  '<td class="Table__TD--logo Table__TD"><img src="y.png" alt="espn_unlimited_events"/></td>',
  '<td class="Table__TD--name Table__TD"><a class="AnchorLink" href="/watch/player/_/id/ccc">SkyCast - Mississippi St vs. #11 Texas (SkyCast)</a></td>',
  '<td class="Table__TD--logo Table__TD"><img src="z.png" alt="espn_unlimited_events"/></td>',
].join('');

const listings = parseWatchListings(WATCH_ROWS);
check('the watch schedule is read', listings.length === 4, listings.map((l) => l.name).join(' | '));
check(
  'the channel of a listing is read',
  listings.some((l) => l.channel === 'espn_unlimited_events'),
  listings.map((l) => l.channel).join(', '),
);
const skycast = skycastMatchups(listings);
check(
  'the SkyCast games are found',
  skycast.length === 2 &&
    skycast.includes('#1 Miami vs. North Carolina') &&
    skycast.includes('Mississippi St vs. #11 Texas'),
  skycast.join(' | '),
);
check(
  'a game ESPN offers as SkyCast is recognised',
  isSkycastMatchup('Miami Hurricanes vs North Carolina Tar Heels', skycast) &&
    isSkycastMatchup('Mississippi State Bulldogs vs Texas Longhorns', skycast),
);
check(
  'a game ESPN does not offer as SkyCast is kept',
  !isSkycastMatchup('Georgia Tech Yellow Jackets vs Pittsburgh Panthers', skycast) &&
    !isSkycastMatchup('Texas State Bobcats vs Boise State Broncos', skycast),
);
check(
  'a game that shares one team is kept',
  !isSkycastMatchup('Miami Hurricanes vs Florida State Seminoles', skycast),
);
check(
  'two teams that only share a common word are not the same team',
  !isSkycastMatchup('Ohio State Buckeyes vs Michigan Wolverines', [
    'Penn State Nittany Lions vs Michigan Wolverines',
  ]),
);

// --- the SkyCast rule -------------------------------------------------------
// SkyCast is an alternate. When ESPN lists the game under another name as
// well, the game has a regular feed - and that is the one the provider takes.
// Checked against the provider's own picture ("ESPN on abc", "ESPN") and its
// audio (the commentators are there).
const onlyGames = skycastOnlyGames(listings);
check(
  'a game with a regular listing is not refused',
  onlyGames.length === 0,
  onlyGames.join(' | '),
);

// The same schedule without the regular listings: now there is nothing else
// the provider could be serving, so the feed can only be the SkyCast one.
const skycastOnlyRows = [
  '<td class="Table__TD--name Table__TD"><a href="#">SkyCast - #1 Miami vs. North Carolina (SkyCast)</a></td>',
  '<td class="Table__TD--logo Table__TD"><img src="y.png" alt="espn_unlimited_events"/></td>',
  '<td class="Table__TD--name Table__TD"><a href="#">Georgia Tech vs. Pittsburgh</a></td>',
  '<td class="Table__TD--logo Table__TD"><img src="x.png" alt="espn2"/></td>',
].join('');
const onlyListings = parseWatchListings(skycastOnlyRows);
const onlySkycast = skycastOnlyGames(onlyListings);
check(
  'a game listed as SkyCast and nothing else is refused',
  onlySkycast.length === 1 && onlySkycast[0] === '#1 Miami vs. North Carolina',
  onlySkycast.join(' | '),
);
check(
  'the provider feed of that game is recognised',
  isSkycastMatchup('Miami Hurricanes vs North Carolina Tar Heels', onlySkycast),
);
check(
  'but not while the game has a regular feed as well',
  !isSkycastMatchup('Miami Hurricanes vs North Carolina Tar Heels', onlyGames),
);

// SkyCast is a college football product, so only those games are checked
// against ESPN's list. A name that matches a listing in another sport is a
// coincidence, not a SkyCast feed.
check(
  'college football is recognised',
  isCollegeFootball('football', 'NCAAF') && isCollegeFootball('football', 'NCAA Football'),
);
check(
  'other football and other sports are not college football',
  !isCollegeFootball('football', 'NFL') && !isCollegeFootball('soccer', 'MLS') &&
    !isCollegeFootball('', '') && !isCollegeFootball('basketball', 'NCAA'),
);

// --- report ---------------------------------------------------------------
const failed = results.filter((result) => !result.pass);
for (const result of results) {
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
}
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);

rmSync(OUT, { recursive: true, force: true });
process.exit(failed.length === 0 ? 0 : 1);
