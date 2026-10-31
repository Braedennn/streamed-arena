// Checks the media path end to end against a running app server.
//
// The player no longer asks the app's server for the video: it pulls the
// segments straight from the provider. This makes sure that still holds.
//
//   - the playlist carries no per-segment discontinuity any more
//   - the main site and the mirror point at the provider directly
//   - the CDN still travels through the app's server
//   - a segment fetched the way a browser fetches it really is media
//
// Run with: node scripts/media-check.mjs [stream-key]
//   BASE   the app server (default http://127.0.0.1:3899)

const BASE = process.env.BASE || 'http://127.0.0.1:3899';
const KEY = process.argv[2] || 'skyf1';

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

(async () => {
  const pool = await (await fetch(`${BASE}/api/servers?key=${encodeURIComponent(KEY)}`)).json();
  const servers = pool.servers ?? [];
  check('the pool has servers', servers.length > 0, JSON.stringify(servers.map((s) => s.id)));

  const byBackend = new Map(servers.map((server) => [server.backend, server]));

  for (const backend of ['cdn', 'origin', 'mirror']) {
    const server = byBackend.get(backend);
    if (!server) {
      check(`${backend}: the pool offers it`, false, 'missing from the pool');
      continue;
    }

    const response = await fetch(`${BASE}${server.proxyUrl}`);
    const playlist = await response.text();
    check(`${backend}: the playlist arrives`, response.ok, `status ${response.status}`);
    check(
      `${backend}: no segment is marked as a discontinuity`,
      !playlist.includes('#EXT-X-DISCONTINUITY'),
      `${(playlist.match(/#EXT-X-DISCONTINUITY/g) ?? []).length} tags`,
    );

    const segments = segmentsOf(playlist);
    check(`${backend}: the playlist has segments`, segments.length > 0, `${segments.length}`);

    const direct = segments.filter((line) => /^https:\/\//.test(line));
    const relayed = segments.filter((line) => line.startsWith('/api/hls/segment'));
    check(
      `${backend}: every segment is either direct or relayed`,
      direct.length + relayed.length === segments.length,
      `${direct.length} direct, ${relayed.length} relayed`,
    );
    check(
      `${backend}: the media is pulled straight from the provider`,
      direct.length === segments.length,
      `${direct.length}/${segments.length}`,
    );
    check(
      `${backend}: every direct host is a provider door`,
      direct.every((line) => {
        const host = new URL(line).hostname;
        return host === 'strmfree.st' || host === 'streamfree.top';
      }),
      [...new Set(direct.map((line) => new URL(line).hostname))].join(','),
    );

    // Fetch a segment the way the browser would: an Origin header, no
    // Referer (a page on 127.0.0.1 cannot claim to be the provider).
    const target = direct[0] ?? relayed[0];
    if (!target) continue;
    const url = target.startsWith('http') ? target : `${BASE}${target}`;
    const origin = new URL(BASE).origin;
    try {
      const segment = await fetch(url, { headers: { accept: '*/*', origin } });
      const bytes = Buffer.from(await segment.arrayBuffer());
      const cors = segment.headers.get('access-control-allow-origin');
      check(`${backend}: the segment downloads`, segment.ok, `status ${segment.status}`);
      check(`${backend}: the segment is media`, bytes[0] === 0x47, `first byte ${bytes[0]}`);
      if (direct.length) {
        check(
          `${backend}: the provider allows the browser's origin`,
          cors === origin || cors === '*',
          `allow-origin ${cors ?? 'ABSENT'}`,
        );
      }
    } catch (error) {
      check(`${backend}: the segment downloads`, false, error.message);
    }
  }

  const failed = results.filter((result) => !result.pass);
  for (const result of results) {
    console.log(`${result.pass ? 'ok  ' : 'FAIL'} ${result.name}${result.pass ? '' : ` — ${result.detail}`}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((error) => {
  console.log('media-check failed:', error && error.stack ? error.stack : error);
  process.exit(1);
});
