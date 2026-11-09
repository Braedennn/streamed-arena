// The names on a provider's board.
//
// A provider names a match the way its own site does: "A vs. B", "A at B",
// "A v B". The app has to read those names and compare them with the names on
// its own board, so the comparison is made on the teams and never on the whole
// title - two providers spell the same match differently and write it in a
// different order.

import { sameTeam } from '@/lib/espn';

/** The ways a title separates the two sides, longest first. */
const SEPARATORS = [' vs. ', ' vs ', ' v. ', ' v ', ' at ', ' – ', ' - '];

/**
 * The two teams of a title.
 *
 * The second side is empty when the title names only one team - which is what
 * a title like "NFL Network" looks like.
 */
export function teamsOfTitle(title: string): [string, string] {
  const text = title.trim();
  for (const separator of SEPARATORS) {
    const index = text.indexOf(separator);
    if (index > 0) {
      const first = text.slice(0, index).trim();
      const second = text.slice(index + separator.length).trim();
      if (first && second) return [first, second];
    }
  }
  return [text, ''];
}

/**
 * Are these two the same match?
 *
 * The providers and the scoreboards do not agree on which side is the home
 * team for a good many games, so both orders are tried.
 */
export function sameEvent(first: readonly [string, string], second: readonly [string, string]): boolean {
  const [a, b] = first;
  const [c, d] = second;
  if (!a || !b || !c || !d) return false;
  const straight = sameTeam(a, c) && sameTeam(b, d);
  const crossed = sameTeam(a, d) && sameTeam(b, c);
  return straight || crossed;
}
