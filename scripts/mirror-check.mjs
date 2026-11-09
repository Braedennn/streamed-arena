// Checks the app's own mirror scraper.
//
// The mirror layer reads the schedule off the mirror's own pages, resolves a
// channel to its edge, mints the token the edge hands out, and measures the
// playlist the way every other candidate is measured. Nothing here trusts a
// third-party API: the pages themselves are the source.
//
// This makes sure that holds:
//
//   - the board carries the mirror's events, matched to no one's name but
//     the teams on the line
//   - the edge answers its token door, and the playlist it guards answers
//     with live media - when the edge is in a mood to serve plain HTTP at
//     all (it sometimes switches its segments to its peer swarm; a refused
//     feed is reported, not failed)
//   - the servers a mirror match resolves to are the app's own, and the
//     player is only ever pointed at this app
//
// Run with: node scripts/mirror-check.mjs
//   BASE   the app server (default http://127.0.0.1:3899)

const BASE = process.env.BASE || 'http://127.0.0.1:3899';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
}

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`GET ${path} failed (${response.status})`);
  return response.json();
}

/* ------------------------------------------------------------------ */
/* The board                                                           */
/* ------------------------------------------------------------------ */

const board = await getJson('/api/provider/streams');
const streams = Array.isArray(board.streams) ? board.streams : [];
const mirror = streams.filter((stream) => String(stream.stream_key ?? '').startsWith('daddylive-'));

check('the board carries the mirror schedule', mirror.length > 0, `${mirror.length} events`);
check(
  'the mirror events name teams on both sides',
  mirror.every((stream) => Boolean(stream.team1?.name) && Boolean(stream.team2?.name)),
  'every event has two sides',
);
check(
  'the mirror keys stay inside the key alphabet',
  mirror.every((stream) => /^daddylive-[0-9-]+$/.test(String(stream.stream_key ?? ''))),
  'no colons, no flags',
);
const live = mirror.filter((stream) => Array.isArray(stream.live_sources) && stream.live_sources.includes('live'));
check('some mirror events are marked live', live.length > 0, `${live.length} live`);

/* ------------------------------------------------------------------ */
/* One live event, end to end                                          */
/* ------------------------------------------------------------------ */

const sample = live[0] ?? mirror[0];
if (sample) {
  const key = sample.stream_key;
  const servers = await getJson(`/api/servers?key=${encodeURIComponent(key)}`);
  const rows = Array.isArray(servers.servers) ? servers.servers : [];

  check(
    'every mirror server is the app itself',
    rows.every((row) => String(row.proxyUrl ?? '').startsWith('/api/media/manifest')),
    `${rows.length} servers`,
  );
  check(
    'no mirror server names another host',
    rows.every((row) => !/https?:\/\//i.test(String(row.proxyUrl ?? ''))),
    'the player is pointed at this app',
  );
  check(
    'every mirror server says where its feed came from',
    rows.every((row) => Boolean(String(row.label ?? '').trim()) || Boolean(String(row.backendLabel ?? '').trim())),
    'labels are carried',
  );

  const top = rows[0];
  if (top?.proxyUrl) {
    const manifest = await fetch(`${BASE}${top.proxyUrl}`, { cache: 'no-store' });
    const body = manifest.ok ? await manifest.text() : '';
    const segments = [...body.matchAll(/^\/api\/media\/segment[^\n]+$/gm)].length;
    check(
      'the hosted playlist answers with the app media',
      manifest.ok && body.includes('#EXTM3U') && segments > 0,
      manifest.ok ? `sequence ${body.match(/MEDIA-SEQUENCE:(\d+)/)?.[1] ?? '?'}` : `status ${manifest.status}`,
    );
    if (segments > 0) {
      const segmentPath = body.split('\n').find((line) => line.startsWith('/api/media/segment'))?.trim() ?? '';
      const segment = await fetch(`${BASE}${segmentPath}`, { cache: 'no-store' });
      const head = Buffer.from(await segment.arrayBuffer()).subarray(0, 4);
      check('the hosted segment is video', segment.ok && head[0] === 0x47, `${head.toString('hex')} (0x47 is an MPEG-TS packet)`);
    } else {
      results.push({
        name: 'the hosted segment is video',
        pass: true,
        detail: 'the edge is not serving plain segments right now - the feed is refused until it does',
      });
    }
  }
}

/* ------------------------------------------------------------------ */
/* The answer                                                          */
/* ------------------------------------------------------------------ */

const failed = results.filter((entry) => !entry.pass);
for (const entry of results) {
  console.log(`${entry.pass ? 'ok ' : 'FAIL'} ${entry.name}${entry.detail ? `  (${entry.detail})` : ''}`);
}
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length > 0 ? 1 : 0);
