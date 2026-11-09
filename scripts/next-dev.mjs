// Runs the development server on the node that is built into electron.
//
// One of the providers' doors reads the TLS client and refuses the clients it
// does not know - and the node that is built into electron is one it knows:
// its TLS is the same one the browser uses, while the node that comes with
// the system is refused at the door.
//
// The app runs its server on that node already (see electron/main.cjs). This
// is the same thing for development, so what works in development is what
// works in the app.
//
//   npm run dev            the development server
//   npm run dev -- -p 4000 another port

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const next = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');

let electron;
try {
  electron = require('electron');
} catch {
  electron = '';
}
if (typeof electron !== 'string' || !electron) {
  console.error('[dev] electron is not installed - run npm install first.');
  process.exit(1);
}

const child = spawn(electron, [next, ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
