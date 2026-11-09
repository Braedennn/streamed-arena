// The app's side of the embed resolver.
//
// Some providers publish their own player and nothing else: the match is
// inside their page, and the playlist that page plays is put together at
// runtime. The app cannot read that address out of the page - the token comes
// back encrypted - so it asks the resolver, which opens the page in a hidden
// browser and catches the playlist as the page asks for it.
//
// What comes back is an address with a token in it. The app does not hand
// that address to the player - it fetches the playlist itself, keeps the
// media on disk and publishes its own playlist, so the provider is never in
// the player's way.

import { TAIFOOD_HOST, TAIFOOD_REFERER } from '@/lib/server/provider';
import { forgetAddress, resolverResolve } from '@/lib/server/resolver';

/** The referers a playlist of that door wants. */
export function embedReferers(): readonly string[] {
  return [TAIFOOD_REFERER];
}

/**
 * Is this a page the app can open?
 *
 * The resolver opens pages in a browser, so it only opens the pages of the
 * door it knows. Everything else is refused before it leaves the app.
 */
export function isEmbedPage(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.origin === TAIFOOD_HOST && url.pathname.startsWith('/embed/');
  } catch {
    return false;
  }
}

/**
 * The playlist behind a provider's page.
 *
 * Returns null when the page cannot be resolved - the app then offers the
 * provider's own player instead, which plays the match as well.
 *
 * `fresh` asks the page again even when an address is known. That is what
 * happens when a feed stops answering: the address that stopped answering is
 * the one the app has, so handing it back again would be no help at all.
 */
export async function resolveEmbed(pageUrl: string, options: { fresh?: boolean } = {}): Promise<string | null> {
  if (!isEmbedPage(pageUrl)) return null;
  return resolverResolve(pageUrl, { fresh: options.fresh });
}

/** Forgets a resolved address, so the next question asks the page again. */
export function forgetEmbed(pageUrl: string): void {
  forgetAddress(pageUrl);
}
