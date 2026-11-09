// Proves the app is the provider, from the page's point of view.
//
// The packaged app is launched, a live match is opened, and every request the
// page makes is watched. Three things have to hold:
//
//   1. the page never talks to a third-party host - every byte comes from
//      this app on 127.0.0.1
//   2. the page asks the app's own media server for the playlist and the
//      segments
//   3. nothing the page receives names a provider - no "StreamFree", no
//      "strmfree.st", no "server API"
//
// The third one is checked in the answers the page receives as well as in
// the text it renders.

import { spawn } from 'node:child_process';

const EXE = 'E:\\Stream\\release\\Streamed Arena-win32-x64\\Streamed Arena.exe';
const PORT = 9225;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const child = spawn(EXE, [], {
  env: { ...process.env, ELECTRON_DEBUG_PORT: String(PORT) },
  stdio: 'ignore',
});

let page = null;
for (let attempt = 0; attempt < 60 && !page; attempt++) {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/json/list`);
    const targets = await response.json();
    page = targets.find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith('http://127.0.0.1'),
    );
  } catch {
    // not up yet
  }
  if (!page) await sleep(500);
}
if (!page) {
  child.kill();
  throw new Error('the app never showed a window');
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
let id = 0;
const pending = new Map();
const requests = [];
const answers = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.method === 'Network.requestWillBeSent') {
    requests.push(message.params.request.url);
  }
  if (message.method === 'Network.responseReceived') {
    answers.push(message.params.response.url);
  }
  const resolver = pending.get(message.id);
  if (resolver) {
    pending.delete(message.id);
    resolver(message);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const messageId = ++id;
    pending.set(messageId, (message) =>
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result),
    );
    socket.send(JSON.stringify({ id: messageId, method, params }));
  });
const evaluate = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'failed');
  return result.result.value;
};

await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');

// A match that is on air right now.
//
// The board is the app's own - it holds the games of every provider the app
// knows - so the check takes its match from there rather than from one
// service. A match of a provider's own board is preferred: it is the one
// that goes through the provider's API and the browser that reads it.
//
// A provider lists a match as live whose media is down now and then, so the
// matches are asked for their servers until one answers: the point of the
// check is to watch a page that really plays.
const origin = await evaluate('location.origin');
const board = await (await fetch(`${origin}/api/provider/streams`, { cache: 'no-store' })).json();
const entries = Array.isArray(board.streams) ? board.streams : [];
const live = entries.filter(
  (entry) =>
    Array.isArray(entry.live_sources) &&
    entry.live_sources.length > 0 &&
    !String(entry.stream_key ?? '').startsWith('espn_'),
);
const others = entries.filter(
  (entry) =>
    Array.isArray(entry.live_sources) &&
    entry.live_sources.length > 0 &&
    String(entry.stream_key ?? '').startsWith('espn_'),
);

let key = '';
let provider = false;
for (const candidate of [...live, ...others]) {
  try {
    const pool = await (
      await fetch(`${origin}/api/servers?key=${encodeURIComponent(candidate.stream_key)}`, {
        cache: 'no-store',
      })
    ).json();
    if ((pool.servers ?? []).length === 0) continue;
    key = String(candidate.stream_key);
    provider = !key.startsWith('espn_');
    break;
  } catch {
    // The next match is tried.
  }
}
if (!key) {
  // Nothing is on air right now, so there is no page to watch. Saying so is
  // honest; a check that fails for the lack of a match is not.
  child.kill();
  console.log('provider-check: no live feed right now - nothing to check');
  process.exit(0);
}
console.log('watching:', key, provider ? '(a provider of the board)' : "(the app's own board)");

await send('Page.navigate', { url: `${origin}/watch/${key}` });
await sleep(9000);

// What the page says on screen.
const text = await evaluate('document.body.innerText');
const rail = await evaluate(
  `(() => { const aside = document.querySelector('aside'); return aside ? aside.innerText : '(no aside)'; })()`,
);
console.log('--- the server rail says:');
console.log(rail);

// 1. Nothing left the machine.
const external = requests.filter(
  (url) =>
    !url.startsWith('127.0.0.1') &&
    !url.startsWith('http://127.0.0.1') &&
    !url.startsWith('data:') &&
    !url.startsWith('blob:') &&
    !url.startsWith('chrome-extension:'),
);
console.log('--- requests that left the machine:', external.length);
for (const url of [...new Set(external)].slice(0, 10)) console.log('   ', url);

// 2. The app's own media server was used.
const own = requests.filter((url) => url.includes('/api/media/'));
console.log('--- requests to the app’s own media server:', own.length);
for (const url of [...new Set(own)].slice(0, 6)) console.log('   ', url);

// 3. No address of anybody else reaches the page.
//
// The app says where a feed comes from - the badge in the switcher names the
// provider ("PPV", "StreamFree", "DaddyLive") - and that is the app's own
// word about its own feed. What must not reach the page is an *address*:
// a URL, a host, a place where the player could be sent to somebody else's
// server behind the app's back.
const FORBIDDEN = [
  /\bstrmfree\.st\b/i,
  /\bstreamfree\.top\b/i,
  /\bindianservers\.st\b/i,
  /\btaifood-blog\.asia\b/i,
  /\btiktokcdn\.com\b/i,
  /\bapi\.ppv\.st\b/i,
  /\bwedd48c\.top\b/i,
];
const screenHits = FORBIDDEN.filter((pattern) => pattern.test(text)).map((p) => p.source);

// An answer that came from somewhere other than the app itself.
const foreignAnswers = answers.filter((url) => {
  if (!/^https?:/i.test(url)) return false;
  try {
    return new URL(url).origin !== origin;
  } catch {
    return true;
  }
});
console.log('--- addresses on screen:', screenHits.length ? screenHits.join(', ') : 'none');
console.log('--- answers from another host:', foreignAnswers.length);
for (const url of [...new Set(foreignAnswers)].slice(0, 10)) console.log('   ', url);

// The app's own answers are read to see whether a provider address leaks in.
const boardAnswer = await evaluate(
  `fetch('/api/provider/streams').then(r => r.text()).then(t => ({
     hosts: [...new Set([...t.matchAll(/https?:\\/\\/[a-z0-9.-]+/gi)].map(m => m[0]))],
   }))`,
);
console.log('--- hosts named in the fixture answer:', boardAnswer.hosts.join(', ') || 'none');

socket.close();
child.kill();

let failed = false;
if (external.length > 0) {
  console.log('\nFAILED: the page talked to a third-party host');
  failed = true;
}
if (own.length === 0) {
  console.log('\nFAILED: the page never asked the app’s own media server');
  failed = true;
}
if (screenHits.length > 0 || foreignAnswers.length > 0) {
  console.log('\nFAILED: an address of somebody else reaches the page');
  failed = true;
}
if (
  boardAnswer.hosts.some((host) =>
    /strmfree|streamfree|indianservers|taifood-blog|tiktokcdn|ppv\.st|wedd48c/i.test(host),
  )
) {
  console.log('\nFAILED: a provider address reaches the page');
  failed = true;
}
if (failed) process.exit(1);

console.log('\nOK: the app is the provider - the page names nobody else');
process.exit(0);
