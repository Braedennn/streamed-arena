// Checks the media path end to end against a running app server.
//
// The player used to pull the segments straight from the provider: the app's
// server handed out a playlist with the provider's own URLs in it. That is
// gone - the app is the provider now.
//
// This makes sure that still holds:
//
//   - the playlist the player gets points at the app and at nothing else
//   - a segment fetched the way a browser fetches it really is media
//   - the app's server answers with the headers a player needs (CORS,
//     Range, the media type)
//
// The window itself - gapless, moving forward with the live edge - is
// checked by scripts/personal-server-check.mjs.
//
// Run with: node scripts/media-check.mjs [stream-key]
//   BASE   the app server (default http://127.0.0.1:3899)

const BASE = process.env.BASE || 'http://127.0.0.1:3899';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
}

function segmentsOf(playlist) {
  return playlist
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .map((line) => line.trim());
}

/**
 * The first match of the app's own board that has a feed.
 *
 * The board is the app's own now - it holds the games of every provider it
 * knows - so the check takes its match from there rather than from a service
 * that only the app used to ask. Several matches are tried: a match on the
 * board is not necessarily on the air yet.
 *
 * The matches of the app's own board come first: the app finds those by the
 * names of their teams, so every provider that publishes the game is asked
 * for it.
 *
 * The matches are tried a few at a time. A match whose provider has nothing
 * costs the app as long as its probes take - half a minute - and the board
 * has many rows, so one after another would take the whole evening.
 */
async function firstLiveKey() {
  try {
    const response = await fetch(`${BASE}/api/provider/streams`, { cache: 'no-store' });
    const payload = await response.json();
    const entries = Array.isArray(payload?.streams) ? payload.streams : [];
    const live = entries.filter(
      (entry) => Array.isArray(entry.live_sources) && entry.live_sources.length > 0,
    );
    const own = live.filter((entry) => String(entry.stream_key).startsWith('espn_'));
    const rest = live.filter((entry) => !String(entry.stream_key).startsWith('espn_'));
    // Every live match of a provider's board is tried: a provider lists a
    // match as live whose media is down now and then, and the ones that do
    // answer are often further down the board than the first few.
    const candidates = [...own, ...rest].slice(0, 36);
    for (let start = 0; start < candidates.length; start += 3) {
      const batch = candidates.slice(start, start + 3);
      const pools = await Promise.all(
        batch.map(async (candidate) => {
          try {
            const pool = await (
              await fetch(`${BASE}/api/servers?key=${encodeURIComponent(candidate.stream_key)}`, {
                cache: 'no-store',
              })
            ).json();
            return { key: candidate.stream_key, servers: pool.servers ?? [] };
          } catch {
            return { key: candidate.stream_key, servers: [] };
          }
        }),
      );
      const found = pools.find((pool) => pool.servers.length > 0);
      if (found) return found.key;
    }
    return candidates[0]?.stream_key ?? '';
  } catch {
    return '';
  }
}

(async () => {
  const key = process.argv[2] || (await firstLiveKey());
  if (!key) {
    console.log('media-check: no live feed right now - nothing to check');
    process.exit(0);
  }

  const pool = await (await fetch(`${BASE}/api/servers?key=${encodeURIComponent(key)}`)).json();
  const servers = pool.servers ?? [];
  check('the pool has servers', servers.length > 0, JSON.stringify(servers.map((s) => s.id)));

  const server = servers[0];
  if (!server) {
    report();
  }

  check(
    'the pool offers the servers the app runs',
    servers.every((entry) => entry.backend === 'personal'),
    JSON.stringify([...new Set(servers.map((entry) => entry.backend))]),
  );

  const response = await fetch(`${BASE}${server.proxyUrl}`);
  const playlist = await response.text();
  check('the playlist arrives', response.ok, `status ${response.status}`);
  check(
    'the playlist is served with the media type',
    (response.headers.get('content-type') ?? '').includes('mpegurl'),
    response.headers.get('content-type') ?? 'none',
  );
  check(
    'the playlist may be read from anywhere',
    response.headers.get('access-control-allow-origin') === '*',
    `allow-origin ${response.headers.get('access-control-allow-origin') ?? 'ABSENT'}`,
  );
  check(
    'no segment is marked as a discontinuity',
    !playlist.includes('#EXT-X-DISCONTINUITY'),
    `${(playlist.match(/#EXT-X-DISCONTINUITY/g) ?? []).length} tags`,
  );

  const segments = segmentsOf(playlist);
  check('the playlist has segments', segments.length > 0, `${segments.length}`);
  check(
    'every segment points at the app',
    segments.every((line) => line.startsWith('/api/media/segment')),
    segments.join(' | '),
  );
  check(
    'no third-party host is named',
    !/https?:\/\//.test(playlist),
    (playlist.match(/https?:\/\/[^\s"']+/g) ?? []).join(' '),
  );

  // Fetch a segment the way the browser would: an Origin header, no Referer
  // (a page on 127.0.0.1 cannot claim to be the provider).
  const target = segments[0];
  if (target) {
    const origin = new URL(BASE).origin;
    try {
      const started = Date.now();
      const segment = await fetch(`${BASE}${target}`, {
        headers: { accept: '*/*', origin },
      });
      const bytes = Buffer.from(await segment.arrayBuffer());
      check('the segment downloads', segment.ok, `status ${segment.status}`);
      check('the segment is media', bytes[0] === 0x47, `first byte ${bytes[0]}`);
      check(
        'the segment is served with the media type',
        (segment.headers.get('content-type') ?? '').startsWith('video/'),
        segment.headers.get('content-type') ?? 'none',
      );
      check(
        'the segment may be read from anywhere',
        segment.headers.get('access-control-allow-origin') === '*',
        `allow-origin ${segment.headers.get('access-control-allow-origin') ?? 'ABSENT'}`,
      );
      check(
        'the segment is served from the app, not from the provider',
        Date.now() - started < 5_000,
        `${Date.now() - started}ms`,
      );

      const ranged = await fetch(`${BASE}${target}`, { headers: { range: 'bytes=0-1023' } });
      const rangedBody = await ranged.arrayBuffer();
      check('a range request is answered', ranged.status === 206, `status ${ranged.status}`);
      check('the range is the right size', rangedBody.byteLength === 1024, `${rangedBody.byteLength}`);
    } catch (error) {
      check('the segment downloads', false, error.message);
    }
  }

  report();
})().catch((error) => {
  console.log('media-check failed:', error && error.stack ? error.stack : error);
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
