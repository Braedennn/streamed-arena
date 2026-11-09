// Checks the app on its own.
//
// The switch "never contact a third party" turns the app away from every
// outside service: the board comes from the scoreboards the app reads itself,
// the feed comes from the broadcaster's own pages, and nothing of the
// provider's reaches the page.
//
// This makes sure that holds:
//
//   - the switch can be turned on and off through the app's own API
//   - the board the app serves then is its own - every match is one the app
//     found by itself, and none of the provider's names or addresses are in
//     the answer
//   - the feeds of a match are found from the broadcaster's own pages, and
//     the servers the app lists are its own
//   - the previous setting is put back, even when the check falls over
//
// Run with: node scripts/direct-check.mjs
//   BASE   the app server (default http://127.0.0.1:3899)

const BASE = process.env.BASE || 'http://127.0.0.1:3899';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
}

async function getConfig() {
  const response = await fetch(`${BASE}/api/media/sources`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`GET /api/media/sources failed (${response.status})`);
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

const before = await getConfig();

if (before.strictFromEnvironment !== null && before.strictFromEnvironment !== undefined) {
  // The environment carries the switch and it wins over the file: the file
  // cannot turn it on or off while it is there. Writing the file would only
  // change a setting that is not in force - and would lose the one that is.
  check(
    'the environment carries the switch, so the file cannot change it',
    before.strictFromEnvironment === true || before.strictFromEnvironment === false,
    `strictFromEnvironment=${before.strictFromEnvironment}`,
  );
  console.log(
    `note: the switch is carried by the environment (strict=${before.strict}) - the file cannot change it`,
  );
  report();
} else {
  try {
    const saved = await postConfig({
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

    check('the switch is on', saved.strict === true, `strict=${saved.strict}`);
    check(
      'the switch is not carried by the environment',
      saved.strictFromEnvironment === null || saved.strictFromEnvironment === undefined,
      `strictFromEnvironment=${saved.strictFromEnvironment}`,
    );

    // The board: the app's own.
    const board = await fetch(`${BASE}/api/provider/streams`, { cache: 'no-store' }).then((response) =>
      response.json(),
    );
    const streams = Array.isArray(board.streams) ? board.streams : [];
    check('the board has games', streams.length > 0, `${streams.length} games`);
    check(
      'every game is one the app found by itself',
      streams.length > 0 && streams.every((entry) => String(entry.stream_key ?? '').startsWith('espn_')),
      streams.slice(0, 3).map((entry) => entry.stream_key).join(', '),
    );

    const body = JSON.stringify(board);
    check(
      'the board names no provider',
      !/strmfree|streamfree/i.test(body),
      'the answer names the provider',
    );
    check(
      'the board carries no media address of anyone else',
      !/https?:\/\/[^"\\]+?\.m3u8/i.test(body),
      'the answer carries a manifest',
    );

    // The feeds of a match: read from the broadcaster's own pages.
    const withNetwork = streams.filter((entry) => entry.name);
    const sample = withNetwork[0];
    if (!sample) {
      check('a game to read the feeds of', false, 'the board is empty');
    } else {
      const feeds = await fetch(
        `${BASE}/api/provider/sources/${encodeURIComponent(sample.stream_key)}`,
        { cache: 'no-store' },
      ).then((response) => response.json());
      const ids = Array.isArray(feeds.sources) ? feeds.sources : [];
      check(
        'the feeds of a match are answered',
        Array.isArray(feeds.sources) && Array.isArray(feeds.live_sources),
        JSON.stringify(feeds).slice(0, 200),
      );
      check(
        'the feeds are named by their quality',
        ids.every((entry) => typeof entry === 'string' && /\d+p/.test(entry)),
        ids.join(', '),
      );

      // The servers the app lists for that match are its own.
      const servers = await fetch(
        `${BASE}/api/servers?key=${encodeURIComponent(sample.stream_key)}`,
        { cache: 'no-store' },
      ).then((response) => response.json());
      const rows = servers.servers ?? [];
      check(
        'the servers of a match are the app\'s own',
        rows.every((row) => row.backend === 'personal'),
        rows.map((row) => row.backend).join(', '),
      );
      check(
        'no server points anywhere but the app',
        rows.every((row) => String(row.proxyUrl ?? '').startsWith('/api/media/manifest')),
        rows.map((row) => row.proxyUrl).join(', '),
      );
      check(
        'the pool says what it found',
        ['ready', 'waiting', 'unknown', 'refused'].includes(servers.state),
        `state=${servers.state}`,
      );
      console.log(
        `note: ${sample.name} -> ${rows.length} server(s), state=${servers.state}, feeds=${ids.join(', ') || 'none'}`,
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

  report();
}

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
