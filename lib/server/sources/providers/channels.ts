// The channels of a network, published beside the matches.
//
// The providers put television channels next to the games: NFL Network, Sky
// Sports Tennis, Willow, a news loop that runs all day. They are not matches.
// A board is a list of games, and a channel that runs for ever is not the
// game the user came for - it is the thing the user complained about when a
// news channel came up where a match should have been.
//
// So the channels are dropped where the providers' boards are read, and the
// app never offers one: not on the board, not on a watch page, and not as a
// door of a match.

/**
 * The words a provider uses for a channel that runs all day.
 *
 * The provider says it in the row itself ("24/7 channel"), so the app reads
 * the row the way the provider writes it.
 */
export function isChannelWord(text: string): boolean {
  return /24\s*[\/x-]\s*7|24\s*hours|all\s*day|\bchannel\b/i.test(text);
}

/**
 * Is this row of a provider's board a channel rather than a match?
 *
 * The row's own words decide it: a league the provider marks as a channel is
 * a channel, whatever the row is called.
 */
export function isChannelRow(row: { league?: string; name?: string }): boolean {
  if (isChannelWord(row.league ?? '')) return true;
  return false;
}
