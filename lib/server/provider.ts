// The provider's own doors, and the referer each of them expects.
//
// The same match is served from several front doors: the main site
// (strmfree.st), its mirror (streamfree.top) and a CDN (cdn1.strmfree.st).
// Every door checks the Referer and answers 403 to anything else — the media
// paths included. A mirror that is asked with the wrong referer looks exactly
// like a dead mirror, so the referer belongs with the host.

export const STREAMFREE_HOST = 'https://strmfree.st';
/** The provider's second front door — the same media, a different host. */
export const MIRROR_HOST = 'https://streamfree.top';

export const STREAMFREE_REFERER = 'https://strmfree.st/';
export const MIRROR_REFERER = 'https://streamfree.top/';

/** Hosts the app is allowed to relay media from. */
export const PROVIDER_HOSTS = /^(?:[a-z0-9-]+\.)*(?:strmfree\.st|streamfree\.top)$/i;

function isProviderHost(hostname: string): boolean {
  return PROVIDER_HOSTS.test(hostname);
}

/**
 * The referers to try for a host, best first.
 *
 * A provider door wants its own referer; the mirror wants the mirror's. A
 * third-party host usually wants none at all, so the plain request is tried
 * first there and the provider's referer is the fallback.
 */
export function providerReferers(hostname: string): string[] {
  if (/(^|\.)streamfree\.top$/i.test(hostname)) {
    return [MIRROR_REFERER, STREAMFREE_REFERER];
  }
  if (isProviderHost(hostname)) return [STREAMFREE_REFERER];
  return ['', STREAMFREE_REFERER];
}
