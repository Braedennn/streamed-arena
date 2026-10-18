// Windows Authenticode signing — the SmartScreen trust layer.
//
// The Ed25519 release signature (sign-release.mjs) proves to installed clients
// that a release came from the signing key; Authenticode proves to WINDOWS
// (SmartScreen, antivirus, the UAC publisher line) that the binaries come from
// "TotallyNoire". These are different claims and both must hold.
//
// A CA-issued certificate is required for real trust — a self-signed cert or
// a publisher string alone will NOT clear SmartScreen. Options, roughly:
//   EV certificate          instant SmartScreen reputation (~$$, org validation)
//   OV certificate          reputation builds as downloads accumulate
//   Azure Trusted Signing   Microsoft-managed cert (org validation, monthly)
//   Certum open-source      cheap CA path for OSS publishers (reputation builds)
//
// Certificate configuration (first match wins):
//   ARENA_CODESIGN_PFX           path to a .pfx file (password below)
//   ARENA_CODESIGN_PFX_PASSWORD  that .pfx's password
//   ARENA_CODESIGN_THUMBPRINT    exact certificate from Cert:\CurrentUser\My
//   ARENA_CODESIGN_SUBJECT       subject lookup, e.g. "TotallyNoire"
//
// Signs the packaged app exe and the Setup.exe with a CA timestamp. MUST run
// BEFORE sign-release: Authenticode rewrites the binary, and the Ed25519
// signature is computed over the final bytes that ship.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// pwsh 7 ships the Authenticode cmdlets everywhere; legacy Windows PowerShell
// needs its Microsoft.PowerShell.Security module to load, which some systems
// (and locked-down servers) refuse. Prefer pwsh, fall back gracefully.
function resolveShell() {
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    return 'pwsh';
  } catch {
    return 'powershell';
  }
}
const SHELL = resolveShell();

const TARGETS = [
  join(root, 'release', 'Streamed Arena-win32-x64', 'Streamed Arena.exe'),
  join(root, 'release', 'Streamed Arena Setup.exe'),
];

const pfx = process.env.ARENA_CODESIGN_PFX;
const pfxPassword = process.env.ARENA_CODESIGN_PFX_PASSWORD ?? '';
const thumbprint = process.env.ARENA_CODESIGN_THUMBPRINT;
const subject = process.env.ARENA_CODESIGN_SUBJECT;
const timestampServer = process.env.ARENA_CODESIGN_TIMESTAMP ?? 'http://timestamp.digicert.com';

// PowerShell single-quotes are doubled to escape — nothing else goes in raw.
const psSafe = (value) => String(value).replace(/'/g, "''");

// The Cert:\ drive needs the certificate provider, which plain
// `powershell -Command` sessions may not have loaded; the raw X509Store API
// needs no provider and works everywhere.
const openStore = [
  "$ErrorActionPreference = 'Stop'",
  "$store = [System.Security.Cryptography.X509Certificates.X509Store]::new('My', 'CurrentUser')",
  '$store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadOnly)',
].join('; ');

let certExpression = null;
if (pfx) {
  if (!existsSync(pfx)) throw new Error(`ARENA_CODESIGN_PFX not found: ${pfx}`);
  certExpression =
    `[System.Security.Cryptography.X509Certificates.X509Certificate2]::new('${psSafe(pfx)}', '${psSafe(pfxPassword)}')`;
} else if (thumbprint) {
  certExpression =
    `($store.Certificates.Find([System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint, '${psSafe(thumbprint)}', $false) | Select-Object -First 1)`;
} else if (subject) {
  certExpression =
    `($store.Certificates | Where-Object { $_.Subject -like '*CN=${psSafe(subject)}*' } | Select-Object -First 1)`;
}

if (!certExpression) {
  console.log('[sign-binary] SKIPPED — no certificate configured.');
  console.log('  Set ARENA_CODESIGN_PFX + ARENA_CODESIGN_PFX_PASSWORD, or');
  console.log('  ARENA_CODESIGN_THUMBPRINT, or ARENA_CODESIGN_SUBJECT.');
  console.log('  Unsigned builds still work but Windows will warn "unknown publisher".');
  process.exit(0);
}

for (const target of TARGETS) {
  if (!existsSync(target)) throw new Error(`missing build artifact: ${target}`);
  const script = [
    openStore,
    `$cert = ${certExpression}`,
    "if (-not $cert) { throw 'certificate not found' }",
    `$result = Set-AuthenticodeSignature -FilePath '${psSafe(target)}' -Certificate $cert -TimeStampServer '${psSafe(timestampServer)}'`,
    // NotSigned/HashMismatch are hard failures; anything else (e.g. an
    // untrusted self-signed chain) still proves the plumbing works, and the
    // verification dump below shows exactly what Windows sees.
    "if ($result.Status -eq 'NotSigned' -or $result.Status -eq 'HashMismatch') { throw 'signing failed: ' + $result.Status }",
    `$check = Get-AuthenticodeSignature -FilePath '${psSafe(target)}'`,
    `'signed ${basename(target)}: status=' + $check.Status + ' signer=' + $check.SignerCertificate.Subject`,
  ].join('; ');
  execFileSync(SHELL, ['-NoProfile', '-Command', script], { stdio: 'inherit' });
}

console.log(`DONE: Authenticode signing complete via ${SHELL}.`);
console.log('  Next: sign-release computes the Ed25519 signature over these final bytes.');
