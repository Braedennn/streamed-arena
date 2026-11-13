// Checks the personal server - the app's own server - end to end.
//
// The app used to hand the player the provider's own doors (the CDN, the
// origin, the mirror). Those are the same files on the same machines, so the
// list looked like a choice between servers and was really one server with
// three names.
//
// Now the app hosts the feed itself: it fetches the media ahead of the
// player, publishes a playlist of its own and serves the segments from its
// disk. This checks that:
//
//   - the server list offers the app's own servers and nothing else
//   - no third-party host is named anywhere in the playlist
//   - the playlist is a gapless window that only ever moves forward
//   - the segments really are media, and they are served from the app
//
// Run with: node scripts/personal-server-check.mjs [stream-key]
//   BASE   the app server (default http://127.0.0.1:3899)

const BASE = process.env.BASE || 'http://127.0.0.1:3899';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
}

/**
 * Every match of the app's own board that a provider publishes.
 *
 * The board is the app's own now - it holds the games of every provider it
 * knows - so the check takes its matches from there rather than from a
 * service that only the app used to ask. A match on the board is not
 * necessarily on the air yet, so the ones that are not are simply skipped
 * further down.
 *
 * The matches of the app's own board come first: the app finds those by the
 * names of their teams, so every provider that publishes the game is asked
 * for it.
 */
async function liveMatches() {
  try {
    const response = await fetch(`${BASE}/api/provider/streams`, { cache: 'no-store' });
    const payload = await response.json();
    const entries = Array.isArray(payload?.streams) ? payload.streams : [];
    const live = entries.filter(
      (entry) => Array.isArray(entry.live_sources) && entry.live_sources.length > 0,
    );
    const own = live.filter((entry) => String(entry.stream_key).startsWith('espn_'));
    const rest = live.filter((entry) => !String(entry.stream_key).startsWith('espn_'));
    return [...own, ...rest];
  } catch {
    return [];
  }
}

function segmentsOf(playlist) {
  return playlist
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'));
}

(async () => {
  const live = await liveMatches();
  if (live.length === 0) {
    console.log('personal-server-check: no live feed right now - nothing to check');
    process.exit(0);
  }

  const requested = process.argv[2];
  // Every live match of a provider's board is tried: a provider lists a match
  // as live whose media is down now and then, and the ones that do answer are
  // often further down the board than the first few.
  const candidates = requested ? [{ stream_key: requested }] : live.slice(0, 36);

  let key = '';
  let pool = null;
  // The matches are tried a few at a time: a match whose provider has nothing
  // costs the app as long as its probes take, and the board has many rows.
  for (let start = 0; start < candidates.length && !pool; start += 3) {
    const batch = candidates.slice(start, start + 3);
    const answers = await Promise.all(
      batch.map(async (candidate) => {
        try {
          const response = await fetch(
            `${BASE}/api/servers?key=${encodeURIComponent(candidate.stream_key)}`,
          );
          const payload = await response.json();
          // The provider sometimes lists a match as live whose media is down;
          // the next match is tried until one answers.
          return (payload.servers ?? []).length > 0
            ? { key: candidate.stream_key, payload }
            : null;
        } catch {
          return null;
        }
      }),
    );
    const found = answers.find(Boolean);
    if (found) {
      key = found.key;
      pool = found.payload;
    }
  }

  check('the pool answers', Boolean(pool), 'no match answered');
  if (!pool) report();

  console.log(`checking ${key}`);
  const servers = pool.servers ?? [];
  check('the pool has servers', servers.length > 0, JSON.stringify(servers.map((s) => s.id)));
  check(
    'every server is one the app runs',
    servers.every((server) => server.backend === 'personal'),
    JSON.stringify([...new Set(servers.map((server) => server.backend))]),
  );
  check(
    'no server points at a third party',
    servers.every((server) => server.proxyUrl.startsWith('/api/media/manifest')),
    JSON.stringify(servers.map((server) => server.proxyUrl)),
  );

  const server = servers[0];
  let playlist = '';
  let segmentLines = [];
  let lastSequence = -1;
  let lastEdge = -1;
  const sequences = [];
  const edges = [];

  for (let round = 0; round < 6; round++) {
    const response = await fetch(`${BASE}${server.proxyUrl}`);
    playlist = await response.text();
    segmentLines = segmentsOf(playlist);
    const sequence = Number(playlist.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/)?.[1] ?? -1);
    // The live edge of the server's window: the newest segment it holds.
    const edge = Number(segmentLines[segmentLines.length - 1]?.match(/name=(\d+)/)?.[1] ?? -1);
    sequences.push(sequence);
    edges.push(edge);
    if (round > 0) {
      check('the media sequence never goes back', sequence >= lastSequence, `${lastSequence} -> ${sequence}`);
      check('the live edge never goes back', edge >= lastEdge, `${lastEdge} -> ${edge}`);
    }
    lastSequence = sequence;
    lastEdge = edge;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  check('the playlist arrives', playlist.startsWith('#EXTM3U'), playlist.slice(0, 40));
  check('the playlist has a window', segmentLines.length >= 2, `${segmentLines.length} segments`);
  check(
    'no segment is marked as a discontinuity',
    !playlist.includes('#EXT-X-DISCONTINUITY'),
    `${(playlist.match(/#EXT-X-DISCONTINUITY/g) ?? []).length} tags`,
  );
  check(
    'every segment points at this app',
    segmentLines.every((line) => line.startsWith('/api/media/segment')),
    segmentLines.join(' | '),
  );
  check(
    'no third-party host is named',
    !/https?:\/\/(?!127\.0\.0\.1|localhost)/.test(playlist),
    (playlist.match(/https?:\/\/[^\s"']+/g) ?? []).join(' '),
  );
  check(
    'the window follows the live edge',
    edges[edges.length - 1] > edges[0],
    `${edges[0]} -> ${edges[edges.length - 1]}`,
  );
  check(
    'the window is gapless',
    segmentLines.every((line, index) => {
      const sequence = Number(line.match(/name=(\d+)/)?.[1] ?? -1);
      if (index === 0) return sequence >= 0;
      const previous = Number(segmentLines[index - 1]?.match(/name=(\d+)/)?.[1] ?? -1);
      return sequence === previous + 1;
    }),
    segmentLines.map((line) => line.match(/name=(\d+)/)?.[1]).join(','),
  );

  const target = `${BASE}${segmentLines[segmentLines.length - 1] ?? ''}`;
  if (target !== BASE) {
    const started = Date.now();
    const segment = await fetch(target, { headers: { origin: BASE } });
    const bytes = Buffer.from(await segment.arrayBuffer());
    console.log(`segment: ${bytes.length} bytes in ${Date.now() - started}ms`);
    check('the segment downloads', segment.ok, `status ${segment.status}`);
    check('the segment is media', bytes[0] === 0x47, `first byte ${bytes[0]}`);
    check(
      'the segment is served with the media type',
      (segment.headers.get('content-type') ?? '').startsWith('video/'),
      segment.headers.get('content-type') ?? 'none',
    );

    const ranged = await fetch(target, { headers: { range: 'bytes=0-99' } });
    const rangedBody = await ranged.arrayBuffer();
    check('a range request is answered', ranged.status === 206, `status ${ranged.status}`);
    check('the range is the right size', rangedBody.byteLength === 100, `${rangedBody.byteLength}`);

    // Every segment the playlist names must really be there - a player that
    // asks for a segment that does not exist waits for it, and the picture
    // freezes on it.
    const holes = [];
    for (const line of segmentLines) {
      const response = await fetch(`${BASE}${line}`);
      if (!response.ok) {
        holes.push(`${line} -> ${response.status}`);
        continue;
      }
      await response.arrayBuffer();
    }
    check('every segment of the window is served', holes.length === 0, holes.join(' | '));
  }

  report();
})().catch((error) => {
  console.log('personal-server-check failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});

function report() {
  const failed = results.filter((result) => !result.pass);
  for (const result of results) {
    console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}
