// Signs the compiled installer for the auto-updater.
//
// Every release must carry `Streamed.Arena.Setup.exe.sig` — an Ed25519 signature
// over `<v-tag>:<sha256 of the Setup.exe>`. Desktop clients (v1.4.0+) refuse any
// release whose signature does not verify against the public key committed in
// electron/release-key.json, so a compromised GitHub account alone cannot push
// code to existing installs: the attacker can publish whatever they like, but
// they cannot forge the signature.
//
// The private key lives OUTSIDE the repo, at
// %USERPROFILE%\.streamed-arena\release-signing.pem — generated on first run.
// Losing it strands every released client on manual updates, so back it up.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const setupPath = join(root, 'release', 'Streamed Arena Setup.exe');
// Dotted on purpose: this is the exact asset name after GitHub's space->dot
// rewrite, so clients can find it deterministically.
const sigPath = join(root, 'release', 'Streamed.Arena.Setup.exe.sig');
const keyDir = join(homedir(), '.streamed-arena');
const keyPath = join(keyDir, 'release-signing.pem');
const pubkeyPath = join(root, 'electron', 'release-key.json');

if (!existsSync(setupPath)) {
  throw new Error('release/Streamed Arena Setup.exe missing — run `npm run installer` first');
}
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const tag = `v${version}`;

let privatePem;
if (existsSync(keyPath)) {
  privatePem = readFileSync(keyPath, 'utf8');
} else {
  console.log('[*] No signing key found — generating a new Ed25519 keypair...');
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(keyPath, privatePem, { mode: 0o600 });
  const spki = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  if (!existsSync(pubkeyPath)) {
    writeFileSync(pubkeyPath, JSON.stringify({ algorithm: 'ed25519', publicKey: spki, createdAt: new Date().toISOString() }, null, 2) + '\n');
    console.log('[*] Wrote electron/release-key.json — COMMIT it so every client can verify signatures.');
  }
  console.log('');
  console.log('  PRIVATE KEY CREATED AT:');
  console.log(`    ${keyPath}`);
  console.log('  BACK IT UP somewhere safe (password manager, encrypted drive).');
  console.log('  Losing it means released clients can never auto-update again;');
  console.log('  leaking it means attackers can sign releases. Guard it.');
  console.log('');
}

const privateKey = createPrivateKey(privatePem);
const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64');

// The committed public key must match the signing key — a mismatch would sign
// a release no client will accept, so fail loudly instead of shipping it.
const committed = existsSync(pubkeyPath) ? JSON.parse(readFileSync(pubkeyPath, 'utf8')) : null;
if (!committed?.publicKey) {
  throw new Error('electron/release-key.json is missing or has no publicKey — restore it from git or delete the private key to regenerate both');
}
if (committed.publicKey !== spki) {
  throw new Error('electron/release-key.json does not match the private key — refusing to sign a release no client would accept');
}

const sha256 = createHash('sha256').update(readFileSync(setupPath)).digest('hex');
const signature = sign(null, Buffer.from(`${tag}:${sha256}`), privateKey);
writeFileSync(sigPath, signature.toString('base64') + '\n');

console.log(`DONE: ${sigPath}`);
console.log(`    Attach BOTH files to the ${tag} release:`);
console.log('      release/Streamed Arena Setup.exe');
console.log('      release/Streamed.Arena.Setup.exe.sig');
