// ESPN's watch schedule - the list of what is on ESPN right now.
//
// This is where the word "SkyCast" comes from. ESPN publishes a college
// football alternate under that name: the same picture and the same crowd,
// but no announcers. A match watched on it feels broken - nobody is talking,
// and it is not obvious whether the feed is even working.
//
// The provider itself names no broadcaster anywhere: not in its board, not in
// its sources API, not in `/get-stream-key/`, not on its embed pages. ESPN's
// watch schedule is the one place the name exists, next to the game it
// carries:
//
//   [espn_unlimited_events] SkyCast - #1 Miami vs. North Carolina (SkyCast)
//   [espn_on_abc_events]   #1 Miami vs. North Carolina
//   [espn1]                 Mississippi State vs. #11 Texas
//   [espn_unlimited_events] SkyCast - Mississippi St vs. #11 Texas (SkyCast)
//
// What the provider actually serves
// ---------------------------------
//
// SkyCast is an *alternate*, and the provider takes the primary feed. That
// was checked, not assumed:
//
//   - Miami vs. North Carolina, which ESPN offers as SkyCast on ESPN
//     Unlimited: the provider's picture carries the "ESPN on abc" bug, and
//     the audio has the commentators - the speech band holds 23% of the
//     energy, the same as an ordinary broadcast (App State 23%, Clemson 17%).
//   - Mississippi State vs. Texas, also offered as SkyCast: the provider's
//     picture carries the plain "ESPN" bug.
//
// So the provider does not carry the announcer-less feed for a game ESPN
// offers as SkyCast - it carries the regular broadcast of that game.
//
// The rule below therefore only refuses a game that ESPN lists as SkyCast
// *and* under no other name: with no regular listing there is nothing else
// the provider could be serving, and the feed can only be the SkyCast one.
//
// The provider's own names are checked as well (see lib/broadcasters.ts): if
// the provider ever labels a feed "Skycast", that feed is refused outright,
// whatever ESPN says.

import { upstreamText } from '@/lib/server/upstream';

/** The pages that carry the schedule: what is coming, what is on, what was. */
const WATCH_PAGES = [
  'https://www.espn.com/watch/schedule/_/type/upcoming',
  'https://www.espn.com/watch/schedule/_/type/live',
  'https://www.espn.com/watch/schedule/_/type/replay',
];

const WATCH_TIMEOUT_MS = 8_000;

/**
 * How long the schedule is kept.
 *
 * The list only changes when ESPN changes it - a few times a day - so a long
 * life is right. It is also a big page, and it is fetched from the app's own
 * server rather than from the renderer.
 */
const WATCH_TTL_MS = 10 * 60_000;

/** One line of the schedule. */
export interface WatchListing {
  /** What ESPN calls it, e.g. "SkyCast - #1 Miami vs. North Carolina". */
  readonly name: string;
  /** The channel logo it is shown with, e.g. "espn_unlimited_events". */
  readonly channel: string;
}

let watchCache: { at: number; games: string[] } | null = null;
let watchPending: Promise<string[]> | null = null;

function decodeEntities(text: string): string {
  // Numeric entities are decoded by their code; the named ones become a
  // space - a team name never depends on one.
  return text.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_entity, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : ' ';
    }
    return ' ';
  });
}

/**
 * The listings on a watch schedule page.
 *
 * The page is server-rendered: every listing is a row with the name in one
 * cell and the channel's logo in the next.
 */
export function parseWatchListings(html: string): WatchListing[] {
  const rows = html.matchAll(
    /<td class="Table__TD--name[^"]*"[^>]*><a[^>]*>([^<]+)<\/a><\/td><td class="Table__TD--logo[^"]*"[^>]*><img src="[^"]*" alt="([^"]*)"/g,
  );
  const listings: WatchListing[] = [];
  for (const row of rows) {
    const name = decodeEntities(row[1] ?? '').trim();
    if (!name) continue;
    listings.push({ name, channel: row[2] ?? '' });
  }
  return listings;
}

/**
 * The games ESPN offers as SkyCast, as matchup titles.
 *
 * "SkyCast - #1 Miami vs. North Carolina (SkyCast)" becomes
 * "#1 Miami vs. North Carolina".
 */
export function skycastMatchups(listings: readonly WatchListing[]): string[] {
  const matchups: string[] = [];
  for (const listing of listings) {
    if (!/skycast/i.test(listing.name)) continue;
    const title = listing.name
      .replace(/^skycast\s*[-–—]\s*/i, '')
      .replace(/\s*\(skycast\)\s*$/i, '')
      .trim();
    if (title) matchups.push(title);
  }
  return [...new Set(matchups)];
}

/* ------------------------------------------------------------------ */
/* Matching a provider feed against the SkyCast list                   */
/* ------------------------------------------------------------------ */

/**
 * Words that are shared by half the clubs on any scoreboard. A match on one
 * of these alone means nothing - and "state" is one of them, or "Ohio State"
 * and "Penn State" would look like the same team.
 */
const GENERIC_TOKENS = new Set([
  'fc', 'cf', 'sc', 'ac', 'afc', 'cd', 'fk', 'sk', 'club', 'de', 'la', 'the',
  'real', 'atletico', 'athletic', 'sporting', 'st', 'state', 'saint',
  'university', 'college', 'team', 'school',
]);

function teamTokens(name: string): Set<string> {
  const tokens = new Set<string>();
  for (const token of name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)) {
    if (!token || token.length < 3) continue;
    if (GENERIC_TOKENS.has(token)) continue;
    // Ranks ("#11") and years are not names.
    if (/^\d+$/.test(token)) continue;
    tokens.add(token);
  }
  return tokens;
}

/** Do two team names talk about the same team? */
function sameTeam(a: string, b: string): boolean {
  const tokensA = teamTokens(a);
  const tokensB = teamTokens(b);
  if (!tokensA.size || !tokensB.size) return false;
  for (const token of tokensA) {
    if (tokensB.has(token)) return true;
  }
  return false;
}

/** Split "Miami Hurricanes vs North Carolina Tar Heels" into its two sides. */
export function splitMatchup(title: string): [string, string] | null {
  const parts = title.split(/\s+vs\.?\s+/i);
  if (parts.length < 2) return null;
  const first = (parts[0] ?? '').trim();
  const second = (parts.slice(1).join(' vs ')).trim();
  if (!first || !second) return null;
  return [first, second];
}

/**
 * Is this match one ESPN offers as SkyCast?
 *
 * Both sides have to match - a game that shares one team with a SkyCast
 * listing is a different game.
 */
export function isSkycastMatchup(
  matchupTitle: string,
  skycastTitles: readonly string[],
): boolean {
  const sides = splitMatchup(matchupTitle);
  if (!sides) return false;
  for (const title of skycastTitles) {
    const skySides = splitMatchup(title);
    if (!skySides) continue;
    const direct = sameTeam(sides[0], skySides[0]) && sameTeam(sides[1], skySides[1]);
    const swapped = sameTeam(sides[0], skySides[1]) && sameTeam(sides[1], skySides[0]);
    if (direct || swapped) return true;
  }
  return false;
}

/**
 * The games ESPN offers as SkyCast and nothing else.
 *
 * A SkyCast listing next to a regular listing of the same game means the
 * game has a regular feed - and that is the one the provider takes (see the
 * note at the top of this file). Only a game that is listed as SkyCast and
 * under no other name can be the announcer-less feed, so only that one is
 * refused.
 */
export function skycastOnlyGames(listings: readonly WatchListing[]): string[] {
  const skycast = skycastMatchups(listings);
  if (!skycast.length) return [];
  const regular = listings
    .filter((listing) => !/skycast/i.test(listing.name))
    .map((listing) => listing.name);
  return skycast.filter((title) => !regular.some((other) => isSkycastMatchup(other, [title])));
}

/* ------------------------------------------------------------------ */
/* The list itself                                                     */
/* ------------------------------------------------------------------ */

/**
 * The games ESPN currently offers as SkyCast - and nothing else.
 *
 * The three pages are read together: a game moves from "upcoming" to "live"
 * and then to "replay" while the match is on, and the refusal must not lapse
 * in the middle of it. Together they cover the window the provider's board
 * lives in - a match is on the board for a day or two around its kick-off.
 */
export async function skycastGames(): Promise<string[]> {
  const cached = watchCache;
  if (cached && Date.now() - cached.at < WATCH_TTL_MS) return cached.games;
  if (watchPending) return watchPending;

  watchPending = (async () => {
    // The pages are read at the same time - one slow page must not hold up
    // the rest.
    const responses = await Promise.all(
      WATCH_PAGES.map(async (page) => {
        try {
          return await upstreamText(page, {
            headers: { accept: 'text/html' },
            timeoutMs: WATCH_TIMEOUT_MS,
          });
        } catch {
          // A page that could not be read is skipped: the others may still
          // have the list.
          return null;
        }
      }),
    );
    const listings: WatchListing[] = [];
    for (const response of responses) {
      if (!response || response.status < 200 || response.status >= 300) continue;
      listings.push(...parseWatchListings(response.body));
    }
    const games = skycastOnlyGames(listings);
    watchCache = { at: Date.now(), games };
    return games;
  })();

  try {
    return await watchPending;
  } finally {
    watchPending = null;
  }
}

/**
 * Is this feed a college football game?
 *
 * SkyCast is a college football alternate, so nothing else can be one. The
 * provider's league for those games is "NCAAF"; the category alone is not
 * enough, because NFL games sit in the same category.
 */
export function isCollegeFootball(category: string, league: string): boolean {
  const cat = category.trim().toLowerCase();
  const lg = league.trim().toLowerCase();
  if (cat !== 'football') return false;
  return lg === 'ncaaf' || lg.includes('ncaa') || lg.includes('college');
}

/**
 * Is this provider feed one of the SkyCast feeds?
 *
 * The provider's own names are checked first - if it ever prints the
 * broadcaster, that is the strongest answer - and ESPN's watch list is the
 * second opinion.
 */
export async function isSkycastFeed(name: string): Promise<boolean> {
  if (!name) return false;
  const games = await skycastGames();
  if (!games.length) return false;
  return isSkycastMatchup(name, games);
}
