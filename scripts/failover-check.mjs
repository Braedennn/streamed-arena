// Does a match survive its feed dying?
//
// The app hosts one match behind one address. Behind that address are the
// feeds of the match - every provider that publishes it and, when the app is
// on its own, the broadcaster's own pages. The app reads the best one and
// moves to the next by itself when the one it is reading stops answering.
//
// This checks that end to end against a running app server:
//   - the match has more than one feed behind it
//   - the app is serving it
//   - the feed being read is dropped by hand (the same move the app makes
//     when a feed dies)
//   - the app moves to another feed
//   - the playlist keeps moving forward, and the number the player tracks
//     the window by never jumps
//
// Run with: node scripts/failover-check.mjs [stream-key]
//   BASE   the app server (default http://127.0.0.1:3899)

const BASE = process.env.BASE || 'http://127.0.0.1:3899';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function manifestOf(channelId) {
  const response = await fetch(`${BASE}/api/media/manifest?channel=${encodeURIComponent(channelId)}`);
  const body = await response.text();
  const sequence = Number(body.match(/MEDIA-SEQUENCE:(\d+)/)?.[1] ?? -1);
  const segments = [...body.matchAll(/EXTINF:([\d.]+)/g)].map((m) => parseFloat(m[1]));
  const names = [...body.matchAll(/\/api\/media\/segment\?[^" ]+/g)].map((m) => {
    const url = new URL(m[0], BASE);
    return url.searchParams.get('name') ?? '';
  });
  return { status: response.status, sequence, segments, names, body };
}

/**
 * Where the window ends, in the numbers the player tracks it by.
 *
 * The window's first segment does not move when the app moves to another
 * feed of the same match - the feed changes behind the playlist, not in it.
 * What moves is the end of the window: the new feed's segments continue
 * after the ones the app already held.
 */
function endOf(window) {
  return window.sequence + Math.max(0, window.segments.length - 1);
}

/**
 * A match that has more than one feed behind it.
 *
 * The point of the check is the move from one feed to another, so the match
 * it watches has to have a second feed to move to. The matches of the app's
 * own board come first: the app finds those by the names of their teams, so
 * every provider that publishes the game is asked for it - and a game that
 * two providers carry is a game with two feeds behind it.
 *
 * The matches are tried a few at a time. A match whose provider has nothing
 * costs the app as long as its probes take, and the board has many rows.
 */
async function matchWithTwoFeeds() {
  const board = await (await fetch(`${BASE}/api/provider/streams`)).json();
  const entries = (board.streams || []).filter((row) => (row.live_sources || []).length > 0);
  const own = entries.filter((row) => String(row.stream_key).startsWith('espn_'));
  const rest = entries.filter((row) => !String(row.stream_key).startsWith('espn_'));
  const ordered = [...own, ...rest];
  for (let start = 0; start < ordered.length; start += 3) {
    const batch = ordered.slice(start, start + 3);
    const found = await Promise.all(
      batch.map(async (row) => {
        const key = String(row.stream_key);
        try {
          const pool = await (
            await fetch(`${BASE}/api/servers?key=${encodeURIComponent(key)}`, { cache: 'no-store' })
          ).json();
          const server = (pool.servers || []).find((entry) => entry.proxyUrl);
          if (!server?.channelId) return null;
          const status = await (
            await fetch(`${BASE}/api/media/status?channel=${encodeURIComponent(server.channelId)}`)
          ).json();
          return (status.doors ?? 0) > 1 ? key : null;
        } catch {
          return null;
        }
      }),
    );
    const winner = found.find((entry) => entry);
    if (winner) return winner;
  }
  return '';
}

let key = process.argv[2] || '';

// A match is chosen when none is named: one that is on air, that the app can
// host, and that has a second feed behind it.
if (!key) {
  key = await matchWithTwoFeeds();
  if (!key) {
    console.log('failover-check: no match with two feeds is on air right now - nothing to check');
    process.exit(0);
  }
}
console.log('match:', key);

// The app starts hosting it.
await fetch(`${BASE}/api/media/subscribe?key=${encodeURIComponent(key)}`, { method: 'POST' });

const pool = await (await fetch(`${BASE}/api/servers?key=${encodeURIComponent(key)}`)).json();
const row = (pool.servers || []).find((server) => server.proxyUrl);
if (!row) {
  console.log('failover-check: the app is not hosting this match');
  process.exit(1);
}
const channelId = row.channelId;
check('the row names the channel it is served by', Boolean(channelId), String(channelId));

// Let it fill its window.
let before = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  before = await manifestOf(channelId);
  if (before.segments.length >= 3) break;
  await sleep(1000);
}
check('the app is serving a window', before.segments.length >= 3, `${before.segments.length} segments`);

const status = await (await fetch(`${BASE}/api/media/status?channel=${encodeURIComponent(channelId)}`)).json();
check('the match has more than one feed behind it', (status.doors ?? 0) > 1, `${status.doors} doors`);
check('the app is reading one of them', Boolean(status.reading), String(status.reading));

// The feed dies: the door being read is dropped, which is the move the app
// makes by itself when a feed stops answering.
const dropped = await (
  await fetch(`${BASE}/api/media/status?channel=${encodeURIComponent(channelId)}&drop=current`, {
    method: 'POST',
  })
).json();
check('the app moved to another feed', dropped.moved === true, `moved=${dropped.moved}`);
check(
  'the feed it moved to is a different one',
  dropped.reading !== status.reading,
  `${status.reading} -> ${dropped.reading}`,
);

// The window keeps moving, and the number the player tracks it by does not
// jump: a jump is what makes a player throw its buffer away.
let after = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  await sleep(1000);
  after = await manifestOf(channelId);
  if (after.segments.length >= 3 && endOf(after) > endOf(before)) break;
}
check('the window is still being served', after.segments.length >= 3, `${after.segments.length} segments`);
check(
  'the window moved forward',
  endOf(after) > endOf(before),
  `${endOf(before)} -> ${endOf(after)}`,
);
check(
  'the number the player tracks the window by never went backwards',
  after.sequence >= before.sequence,
  `${before.sequence} -> ${after.sequence}`,
);
check(
  'the number the player tracks the window by never jumped',
  after.sequence - before.sequence <= 60,
  `${after.sequence - before.sequence} steps`,
);

// What the app serves after the move is still media.
const newest = after.names[after.names.length - 1];
if (newest) {
  const segment = await fetch(
    `${BASE}/api/media/segment?channel=${encodeURIComponent(channelId)}&name=${encodeURIComponent(newest)}`,
  );
  const bytes = Buffer.from(await segment.arrayBuffer());
  check(
    'what the app serves after the move is really media',
    segment.status === 200 && bytes.length > 0 && bytes[0] === 0x47,
    `${segment.status}, ${bytes.length} bytes, magic ${bytes.subarray(0, 4).toString('hex')} (${newest})`,
  );
}

const finalStatus = await (await fetch(`${BASE}/api/media/status?channel=${encodeURIComponent(channelId)}`)).json();
check(
  'the app counts the move it made',
  (finalStatus.failovers ?? 0) > (status.failovers ?? 0),
  `${status.failovers} -> ${finalStatus.failovers}`,
);

console.log('');
for (const result of results) {
  console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.detail ? `  (${result.detail})` : ''}`);
}
const failed = results.filter((result) => !result.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
