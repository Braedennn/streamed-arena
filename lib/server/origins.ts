// Registry of upstream origins the resolver has approved.
//
// The segment proxy relays bytes from hosts it knows: the provider's own
// domains, plus — for matches the provider hosts somewhere else — the single
// external origin the resolver discovered for that match. A caller cannot
// smuggle an arbitrary URL through `?u=`, so the proxy cannot be turned into
// a request for an internal address.

const APPROVED = new Map<string, number>();
const TTL_MS = 15 * 60_000;
const MAX_ENTRIES = 64;

function safeOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  return url.origin;
}

export function approveOrigin(raw: string): void {
  const origin = safeOrigin(raw);
  if (!origin) return;
  APPROVED.set(origin, Date.now() + TTL_MS);
  if (APPROVED.size <= MAX_ENTRIES) return;
  const oldest = [...APPROVED.entries()].sort((a, b) => a[1] - b[1]);
  for (const [entry] of oldest.slice(0, APPROVED.size - MAX_ENTRIES)) {
    APPROVED.delete(entry);
  }
}

export function isApprovedOrigin(raw: string): boolean {
  const origin = safeOrigin(raw);
  if (!origin) return false;
  const expires = APPROVED.get(origin);
  if (!expires) return false;
  if (Date.now() > expires) {
    APPROVED.delete(origin);
    return false;
  }
  return true;
}
