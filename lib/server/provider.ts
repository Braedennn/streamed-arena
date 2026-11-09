// The provider's own doors, and the referer each of them expects.
//
// The same match is served from several front doors: the main site
// (strmfree.st), its mirror (streamfree.top) and a CDN (cdn1.strmfree.st).
// Every door checks the Referer and answers 403 to anything else — the media
// paths included. A mirror that is asked with the wrong referer looks exactly
// like a dead mirror, so the referer belongs with the host.
//
// The other door is the one the providers that publish only their own player
// lead to. Its page hands out a playlist on a host of its own, and that host
// wants the page's referer too - without it the answer is a flat "forbidden"
// that looks exactly like a dead feed.

export const STREAMFREE_HOST = 'https://strmfree.st';
/** The provider's second front door — the same media, a different host. */
export const MIRROR_HOST = 'https://streamfree.top';

export const STREAMFREE_REFERER = 'https://strmfree.st/';
export const MIRROR_REFERER = 'https://streamfree.top/';

/**
 * The door of the providers that publish their own player.
 *
 * The page is the provider's, and the playlist it asks for comes from a host
 * of its own - but the host still wants to be asked as if it were the page.
 */
export const TAIFOOD_HOST = 'https://taifood-blog.asia';
export const TAIFOOD_REFERER = 'https://taifood-blog.asia/';

/** The hosts that serve the playlists of that door. */
export const TAIFOOD_MEDIA_HOSTS = /(^|\.)indianservers\.st$/i;

/** Hosts the app is allowed to relay media from. */
export const PROVIDER_HOSTS =
  /^(?:[a-z0-9-]+\.)*(?:strmfree\.st|streamfree\.top|indianservers\.st)$/i;

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
  if (TAIFOOD_MEDIA_HOSTS.test(hostname)) return [TAIFOOD_REFERER];
  if (isProviderHost(hostname)) return [STREAMFREE_REFERER];
  return ['', STREAMFREE_REFERER];
}

/**
 * Where the browser can fetch a segment itself.
 *
 * The main site and the mirror answer any Referer - and they reflect the
 * browser's Origin header back with "Access-Control-Allow-Origin". The player
 * can therefore pull the segments straight from the provider, and the app's
 * server never has to relay a single byte of video.
 *
 * The CDN edge is the awkward one: it wants the provider's Referer, which a
 * browser cannot forge. But it serves the very same files as the main site -
 * the same path, the same bytes, the same timestamp - so the player can take
 * them from there instead. The app's server then only ever carries the
 * playlist.
 *
 * Returns null when the browser must not fetch the media itself.
 */
export function directMediaUrl(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (host === 'strmfree.st' || host === 'streamfree.top') return url.toString();
  if (host === 'cdn1.strmfree.st') {
    return new URL(`${url.pathname}${url.search}`, STREAMFREE_HOST).toString();
  }
  return null;
}
