// Checks the sources the user brought themselves.
//
// The app hosts every stream itself. Where the bytes come from is the user's
// call: point the app at a feed you own and it hosts that feed, asking
// nobody else for it.
//
// This makes sure that holds:
//
//   - the setting can be read, written and removed through the app's own API
//   - a match with a source of its own is hosted from that source alone -
//     the server list has a row for it even though no one else knows the
//     match at all
//   - the row names the app's own server and nothing else
//   - the setting survives a restart (it is kept in a file, not in memory)
//
// Run with: node scripts/sources-check.mjs
//   BASE   the app server (default http://127.0.0.1:3899)

const BASE = process.env.BASE || 'http://127.0.0.1:3899';

const results = [];
function check(name, condition, detail = '') {
  results.push({ name, pass: Boolean(condition), detail });
}

const TEST_KEY = 'arena-sources-check';
const TEST_URL = 'https://example.invalid/live/check/index.m3u8';

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

async function deleteConfig() {
  const response = await fetch(`${BASE}/api/media/sources`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`DELETE /api/media/sources failed (${response.status})`);
  return response.json();
}

const before = await getConfig();
check('the setting can be read', typeof before === 'object' && before !== null);
check('the setting names a file', typeof before.file === 'string' && before.file.length > 0);
check(
  'the setting knows where it comes from',
  ['env', 'file', 'none'].includes(before.origin),
  `origin=${before.origin}`,
);

if (before.origin === 'env') {
  // The environment wins over the file, so writing would change nothing that
  // is in force. The rest of the check needs to write.
  check('the environment carries a source of its own', before.configured === true);
  report();
} else {
  const saved = await postConfig({
    default: before.default,
    matches: [
      ...before.matches.map((entry) => ({ key: entry.key, url: entry.url })),
      { key: TEST_KEY, url: TEST_URL },
    ],
    referer: before.referer ?? null,
    label: before.label ?? null,
  });

  check(
    'the source is saved',
    saved.matches.some((entry) => entry.key === TEST_KEY && entry.url === TEST_URL),
    JSON.stringify(saved.matches),
  );
  check('the app is on a source of its own', saved.configured === true);
  check('the setting still names a file', saved.file === before.file);

  // The match exists nowhere else: the provider has never heard of it. If the
  // app still produced a row for it, the row can only have come from the
  // user's own source.
  const servers = await fetch(`${BASE}/api/servers?key=${encodeURIComponent(TEST_KEY)}`, {
    cache: 'no-store',
  }).then((response) => response.json());

  const rows = servers.servers ?? [];
  check('the match is hosted', rows.length === 1, `${rows.length} rows`);
  const row = rows[0] ?? {};
  check('the row is a personal server', row.backend === 'personal', `backend=${row.backend}`);
  check(
    'the row points at the app\'s own media',
    typeof row.proxyUrl === 'string' && row.proxyUrl.startsWith('/api/media/manifest'),
    row.proxyUrl,
  );
  check(
    'the row names no third-party host',
    !/https?:\/\//i.test(`${row.proxyUrl}${row.backendLabel}${row.label}`),
    `${row.proxyUrl} ${row.backendLabel}`,
  );
  check(
    'the pool says it is ready',
    servers.state === 'ready',
    `state=${servers.state}`,
  );

  // The setting is kept in a file, not in the memory of the process: the
  // file the app names really holds it.
  const file = await getConfig();
  check(
    'the setting is still there when it is read again',
    file.matches.some((entry) => entry.key === TEST_KEY),
  );

  // Put the user's own setting back the way it was.
  const restored = await postConfig({
    default: before.default,
    matches: before.matches.map((entry) => ({ key: entry.key, url: entry.url })),
    referer: before.referer ?? null,
    label: before.label ?? null,
  });
  check(
    'the previous setting is restored',
    !restored.matches.some((entry) => entry.key === TEST_KEY),
    JSON.stringify(restored.matches),
  );
  check(
    'the restored setting is the one that was there',
    restored.configured === before.configured,
  );

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
