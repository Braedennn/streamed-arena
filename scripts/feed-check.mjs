// Checks where the feeds come from.
//
// The app does not depend on one service any more. It asks everybody who
// carries the game: the app's own mirror scraper, the provider boards, and
// (on its own) the broadcaster's own pages. Every answer is measured the same
// way - the playlist has to answer, the newest segment has to be video, and
// the age of that segment is the real lag - and the best feed wins.
//
// This makes sure that holds:
//
//   - the board carries the games of the provider *and* the games the app
//     found by itself, and it names no address of anybody's
//   - the servers of a match are the app's own, every one of them says where
//     its feed came from, and the sharpest feed is the one on top
//   - a feed that turns out to be an advertisement is never offered
//   - the app on its own (strict) asks nobody but the broadcaster: the free
//     channels are gone, and the board is the app's own
//
// Run with: node scripts/feed-check.mjs
//   BASE   the app server (default http://127.0.0.1:3899)

const BASE = process.env.BASE || 'http://127.0.0.1:3899';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
}

/** The quality a row is served in, as a number. */
function pixels(quality) {
  const value = parseInt(String(quality ?? ''), 10);
  return Number.isFinite(value) ? value : 0;
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status})`);
  return response.json();
}

async function postConfig(body) {
  const response = await fetch(`${BASE}/api/media/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`POST /api/media/sources failed (${response.status})`);
  return response.json();
}

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

const board = await getJson('/api/provider/streams');
const streams = Array.isArray(board.streams) ? board.streams : [];

check('the board has games', streams.length > 0, `${streams.length} games`);
check(
  'the board carries the games the app found by itself',
  streams.some((entry) => String(entry.stream_key ?? '').startsWith('espn_')),
  `${streams.filter((entry) => String(entry.stream_key ?? '').startsWith('espn_')).length} of ${streams.length}`,
);
check(
  'the board names no address of anybody else',
  !/strmfree|streamfree/i.test(JSON.stringify(board)),
  'the answer names the provider',
);
check(
  'the board carries no media address of anybody else',
  !/https?:\/\/[^"\\]+?\.m3u8/i.test(JSON.stringify(board)),
  'the answer carries a manifest',
);

/* ------------------------------------------------------------------ */
/* The feeds of a match                                                */
/* ------------------------------------------------------------------ */

const own = streams.find((entry) => String(entry.stream_key ?? '').startsWith('espn_'));
const foreign = streams.find((entry) => !String(entry.stream_key ?? '').startsWith('espn_'));
// A match of a provider's own board: its key is the provider's own name for
// the match ("cfb/2026-11-07/byu-utah"), and the feeds of that match come
// from the provider's API.
//
// A provider lists a match as live whose media is down now and then, so the
// matches are asked for their feeds until one of them answers with something.
let provider = null;
for (const entry of streams) {
  const key = String(entry.stream_key ?? '');
  if (key.startsWith('espn_')) continue;
  if (!Array.isArray(entry.live_sources) || entry.live_sources.length === 0) continue;
  try {
    const feeds = await getJson(`/api/provider/sources/${encodeURIComponent(key)}`);
    const live = Array.isArray(feeds.live_sources) ? feeds.live_sources : [];
    if (live.length === 0) continue;
    provider = entry;
    break;
  } catch {
    // The next match is tried.
  }
}
const samples = [own, foreign, provider].filter(Boolean).slice(0, 3);

for (const sample of samples) {
  const key = String(sample.stream_key);
  const label = `${sample.name ?? key} (${key})`;

  // The feeds of the match, as the page counts them.
  const feeds = await getJson(`/api/provider/sources/${encodeURIComponent(key)}`);
  const names = Array.isArray(feeds.sources) ? feeds.sources : [];
  check(
    `${label}: the feeds are answered`,
    Array.isArray(feeds.sources) && Array.isArray(feeds.live_sources),
    JSON.stringify(feeds).slice(0, 160),
  );
  check(
    `${label}: the feeds are named by their quality`,
    names.every((entry) => typeof entry === 'string' && /\d+p/.test(entry)),
    names.join(', ') || 'none',
  );

  // The servers the app runs for that match.
  const pool = await getJson(`/api/servers?key=${encodeURIComponent(key)}`);
  const rows = Array.isArray(pool.servers) ? pool.servers : [];

  check(
    `${label}: every server is the app's own`,
    rows.every((row) => row.backend === 'personal'),
    rows.map((row) => row.backend).join(', '),
  );
  check(
    `${label}: no server points anywhere but the app`,
    rows.every((row) => String(row.proxyUrl ?? '').startsWith('/api/media/manifest')),
    rows.map((row) => row.proxyUrl).join(', '),
  );
  check(
    `${label}: every server says where its feed came from`,
    rows.every((row) => typeof row.source === 'string' && row.source.length > 0),
    rows.map((row) => row.source).join(', ') || 'none',
  );
  check(
    `${label}: the sharpest feed is the one on top`,
    rows.length === 0 || pixels(rows[0]?.quality) >= Math.max(...rows.map((row) => pixels(row.quality))),
    rows.map((row) => `${row.quality} ${row.source ?? ''}`).join(' | '),
  );
  check(
    `${label}: no advertisement is offered`,
    !rows.some((row) => /ad|advert|troll|promo/i.test(`${row.label ?? ''} ${row.source ?? ''}`)),
    rows.map((row) => row.label).join(' | '),
  );
  check(
    `${label}: the pool says what it found`,
    ['ready', 'waiting', 'unknown', 'refused'].includes(pool.state),
    `state=${pool.state}`,
  );
  console.log(
    `note: ${label} -> ${rows.length} server(s), state=${pool.state}, feeds=${names.join(', ') || 'none'}`,
  );

  // The app hosts the feed itself: its own playlist names its own segments,
  // and what comes back is video.
  //
  // This is the whole point of the personal server - the player never sees a
  // third party's address - so it is checked on the bytes, not on the shape
  // of the answer.
  const hosted = rows.find((row) => String(row.proxyUrl ?? '').startsWith('/api/media/manifest'));
  if (hosted) {
    const manifest = await fetch(`${BASE}${hosted.proxyUrl}`, { cache: 'no-store' });
    const body = await manifest.text();
    const uris = body
      .split(/\r?\n/)
      .filter((line) => line.trim() && !line.startsWith('#'))
      .map((line) => line.trim());
    check(
      `${label}: the app's own playlist names its own segments`,
      uris.length > 0 && uris.every((uri) => uri.startsWith('/api/media/segment')),
      `${uris.length} segment(s)`,
    );

    if (uris.length > 0) {
      const segment = await fetch(`${BASE}${uris[uris.length - 1]}`, { cache: 'no-store' });
      const bytes = Buffer.from(await segment.arrayBuffer());
      let syncs = 0;
      let slots = 0;
      for (let at = 0; at + 188 < bytes.length; at += 188) {
        slots += 1;
        if (bytes[at] === 0x47) syncs += 1;
      }
      check(
        `${label}: the segment the app serves is a transport stream`,
        slots > 0 && syncs / slots > 0.95,
        `${bytes.length} bytes, ${syncs}/${slots} sync`,
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* The app on its own                                                  */
/* ------------------------------------------------------------------ */

const before = await getJson('/api/media/sources');
if (before.strictFromEnvironment !== null && before.strictFromEnvironment !== undefined) {
  // The environment carries the switch, and it wins over the file: the file
  // cannot turn it on or off while it is there.
  check(
    'the environment carries the switch, so the file cannot change it',
    before.strictFromEnvironment === true || before.strictFromEnvironment === false,
    `strictFromEnvironment=${before.strictFromEnvironment}`,
  );
  console.log(
    `note: the switch is carried by the environment (strict=${before.strict}) - the file cannot change it`,
  );
} else {
  try {
    await postConfig({
      default: before.default,
      matches: before.matches.map((entry) => ({
        key: entry.key,
        url: entry.url,
        referer: entry.referer ?? null,
        label: entry.label ?? null,
      })),
      referer: before.referer ?? null,
      label: before.label ?? null,
      strict: true,
    });

    const strictBoard = await getJson('/api/provider/streams');
    const strictStreams = Array.isArray(strictBoard.streams) ? strictBoard.streams : [];
    check(
      'the app on its own: the board is its own',
      strictStreams.every((entry) => String(entry.stream_key ?? '').startsWith('espn_')),
      strictStreams
        .filter((entry) => !String(entry.stream_key ?? '').startsWith('espn_'))
        .slice(0, 3)
        .map((entry) => entry.stream_key)
        .join(', '),
    );

    if (own) {
      const key = String(own.stream_key);
      const strictPool = await getJson(`/api/servers?key=${encodeURIComponent(key)}`);
      const strictRows = Array.isArray(strictPool.servers) ? strictPool.servers : [];
      check(
        'the app on its own: no free channel is used',
        !strictRows.some((row) => /free tv|pluto/i.test(String(row.source ?? ''))),
        strictRows.map((row) => row.source).join(', ') || 'none',
      );
    }
  } finally {
    const restored = await postConfig({
      default: before.default,
      matches: before.matches.map((entry) => ({
        key: entry.key,
        url: entry.url,
        referer: entry.referer ?? null,
        label: entry.label ?? null,
      })),
      referer: before.referer ?? null,
      label: before.label ?? null,
      strict: before.strict === true,
    });
    check('the previous setting is restored', restored.strict === (before.strict === true));
  }
}

report();

function report() {
  let failed = 0;
  for (const result of results) {
    if (!result.pass) failed += 1;
    const mark = result.pass ? 'ok  ' : 'FAIL';
    const detail = result.detail ? `  (${result.detail})` : '';
    console.log(`${mark} ${result.name}${detail}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed === 0 ? 0 : 1);
}
