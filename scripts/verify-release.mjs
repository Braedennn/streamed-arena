// Verifies a release signature.
//
// The signature is an Ed25519 signature over `<tag>:<sha256 of the Setup.exe>`,
// and the public key is the one committed in electron/release-key.json. A
// release is only good when its signature verifies against that key - and
// only good when it does NOT verify for any other tag or any other file.
//
//   node scripts/verify-release.mjs <setup.exe> <sig> <tag>
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const setupPath = process.argv[2] ?? join(root, 'release', 'Streamed Arena Setup.exe');
const sigPath = process.argv[3] ?? join(root, 'release', 'Streamed.Arena.Setup.exe.sig');
const tag = process.argv[4] ?? `v${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}`;

const committed = JSON.parse(readFileSync(join(root, 'electron', 'release-key.json'), 'utf8'));
const publicKey = createPublicKey({
  key: Buffer.from(committed.publicKey, 'base64'),
  format: 'der',
  type: 'spki',
});

const bytes = readFileSync(setupPath);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const signature = Buffer.from(readFileSync(sigPath, 'utf8').trim(), 'base64');

function checkFor(candidateTag, candidateHash, expected) {
  const ok = verify(null, Buffer.from(`${candidateTag}:${candidateHash}`), publicKey, signature);
  const label = ok === expected ? 'ok  ' : 'FAIL';
  console.log(`${label} ${candidateTag}:${candidateHash.slice(0, 12)}… verifies: ${ok} (expected ${expected})`);
  return ok === expected;
}

let good = true;
good = checkFor(tag, sha256, true) && good;
good = checkFor('v1.6.9', sha256, false) && good;
good = checkFor('v9.9.9', sha256, false) && good;
good = checkFor(tag, '0'.repeat(64), false) && good;

console.log(`\nsetup: ${setupPath}`);
console.log(`size:  ${bytes.length} bytes`);
console.log(`sha256: ${sha256}`);
console.log(`tag:   ${tag}`);
console.log(good ? '\nPASS - the release signature is good' : '\nFAIL - the release signature is bad');
process.exit(good ? 0 : 1);
