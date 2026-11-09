// A feed the app could host, and where it was found.
//
// The app does not depend on one service any more. Every service it knows is
// asked for the feeds of a match, and every answer is measured the same way -
// so the best feed wins, not the service that happened to answer first.
//
// A candidate is a promise, not a fact: the playlist may be dead, may be a
// recording, may be a picture instead of a video. The probe in
// lib/server/direct/probe.ts plays it before the app offers it, and a
// candidate that does not answer never reaches the player.

/** Where a feed was found. */
export interface SourceCandidate {
  /** The service the feed was found in ("iptv-org", "pluto", "api:ppv"). */
  readonly providerId: string;
  /** The name of the service, for the page. */
  readonly providerLabel: string;
  /** The name of the channel or feed, as the service calls it. */
  readonly title: string;
  /** The playlist the app would pull. */
  readonly manifestUrl: string;
  /**
   * What the feed is known by, when its address is not that.
   *
   * The address of a feed that came from a page carries a token, and the token
   * changes when the page is opened again. A feed that changed its name then
   * would restart the player watching it, so the page's address is the name
   * of the feed instead.
   */
  readonly identity?: string;
  /** The referers to try, best first. */
  readonly referers: readonly string[];
  /** The quality the feed claims ("1080p"); empty when it says nothing. */
  readonly quality: string;
  /** The network the feed belongs to ("ESPN"); empty when it names none. */
  readonly network: string;
  /**
   * The provider's own event this feed belongs to.
   *
   * The provider publishes its feeds under an id of its own, and the id is
   * what the feed is looked up by again when its token has expired.
   */
  readonly eventId?: string;
  /**
   * The provider's own player, when it hands out nothing else.
   *
   * Some providers only publish their player - the feed is inside it, behind
   * its own page. The app shows that player rather than pretending it has no
   * feed; there is nothing to host in that case, so there is nothing to fetch
   * either.
   */
  readonly playerUrl?: string;
}
