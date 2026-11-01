// Feeds the app refuses to stream.
//
// The provider does not say which broadcaster a feed comes from. It names no
// broadcaster at all: not in the board, not in the sources API, not in
// `/get-stream-key/`, not on the embed pages. The only names it hands out are
// the match, its league, the title on the embed page and the technical server
// the media is pulled from.
//
// So a feed can only be recognised by those names - which is what this file
// does. Two lists:
//
//   BLOCKED_BROADCASTERS - the broadcaster's own name, wherever the provider
//     happens to print it. When the provider labels a feed "Skycast", that
//     feed disappears from the app on its own.
//
//   BLOCKED_LEAGUES - the competitions whose feeds come from that broadcaster
//     and from nowhere else. A league is matched as a whole, so a competition
//     called "Sky Bet" is not caught by the name "Sky".
//
// The broadcaster that matters today is ESPN's SkyCast: the college football
// alternate that carries the picture and the crowd but no announcers. A game
// watched on it feels broken - nobody is talking, and it is not obvious
// whether the feed is even working.
//
// The provider never labels a feed as SkyCast, so this file alone cannot catch
// it. The list of games ESPN offers as SkyCast is read from ESPN's own watch
// schedule - see lib/server/espn-watch.ts - and the two are used together.

/** Broadcaster names that must never end up in the app. */
export const BLOCKED_BROADCASTERS: readonly string[] = ['skycast'];

/**
 * Leagues whose only feed is a blocked broadcaster's.
 *
 * A league is matched case-insensitively against the provider's league name
 * and against its category.
 */
export const BLOCKED_LEAGUES: readonly string[] = [];

/** Every string the provider gave us about one match. */
export interface BroadcastFacts {
  readonly name?: string | null;
  readonly category?: string | null;
  readonly league?: string | null;
  readonly streamKey?: string | null;
  /** The title on the provider's own embed page. */
  readonly embedName?: string | null;
  /** The provider's name for the server the media is pulled from. */
  readonly serverName?: string | null;
  readonly serverDomain?: string | null;
}

function mentions(text: string | null | undefined, needle: string): boolean {
  if (!text) return false;
  return text.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Does any of the provider's names for this match name a blocked broadcaster?
 */
export function isBlockedBroadcaster(facts: BroadcastFacts): boolean {
  const texts = [
    facts.name,
    facts.category,
    facts.league,
    facts.streamKey,
    facts.embedName,
    facts.serverName,
    facts.serverDomain,
  ];
  return BLOCKED_BROADCASTERS.some((broadcaster) => texts.some((text) => mentions(text, broadcaster)));
}

/**
 * Is this match in a competition whose only feed is a blocked broadcaster's?
 *
 * A competition is matched case-insensitively against the provider's league
 * name and against its category.
 */
export function isBlockedLeague(facts: BroadcastFacts): boolean {
  const league = facts.league?.trim().toLowerCase() ?? '';
  const category = facts.category?.trim().toLowerCase() ?? '';
  return BLOCKED_LEAGUES.some((blocked) => {
    const name = blocked.trim().toLowerCase();
    return name === league || name === category;
  });
}

/**
 * Should this match be left out of the app entirely?
 *
 * Both rules have to agree with each other: a blocked broadcaster is never
 * shown, and neither is a competition that only a blocked broadcaster serves.
 */
export function isBlockedFeed(facts: BroadcastFacts): boolean {
  return isBlockedBroadcaster(facts) || isBlockedLeague(facts);
}
