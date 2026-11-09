// The leagues the app knows, in one place.
//
// Two things need this list: the stats (a match is looked up in the scoreboard
// of its league) and the board the app builds by itself (the list of games the
// app shows when it is not asking anybody else for it). One list, so the two
// can never drift apart: a league the board shows but the stats do not know
// would be a match with a picture and no numbers.

export interface LeagueRef {
  readonly sport: string;
  readonly league: string;
}

const AMERICAN_FOOTBALL_LEAGUES: readonly LeagueRef[] = [
  { sport: 'football', league: 'nfl' },
  { sport: 'football', league: 'college-football' },
  { sport: 'football', league: 'cfl' },
  { sport: 'football', league: 'ufl' },
];

/** The category -> leagues map. */
export const SPORT_LEAGUES: Record<string, readonly LeagueRef[]> = {
  soccer: [
    // Domestic leagues
    { sport: 'soccer', league: 'eng.1' },
    { sport: 'soccer', league: 'eng.2' },
    { sport: 'soccer', league: 'eng.3' },
    { sport: 'soccer', league: 'eng.fa' },
    { sport: 'soccer', league: 'eng.league_cup' },
    { sport: 'soccer', league: 'esp.1' },
    { sport: 'soccer', league: 'esp.2' },
    { sport: 'soccer', league: 'ger.1' },
    { sport: 'soccer', league: 'ger.2' },
    { sport: 'soccer', league: 'ger.dfb_pokal' },
    { sport: 'soccer', league: 'ita.1' },
    { sport: 'soccer', league: 'ita.2' },
    { sport: 'soccer', league: 'fra.1' },
    { sport: 'soccer', league: 'fra.2' },
    { sport: 'soccer', league: 'usa.1' },
    { sport: 'soccer', league: 'usa.nwsl' },
    { sport: 'soccer', league: 'mex.1' },
    { sport: 'soccer', league: 'por.1' },
    { sport: 'soccer', league: 'ned.1' },
    { sport: 'soccer', league: 'tur.1' },
    { sport: 'soccer', league: 'sco.1' },
    { sport: 'soccer', league: 'aus.1' },
    { sport: 'soccer', league: 'bra.1' },
    { sport: 'soccer', league: 'arg.1' },
    // International competitions
    { sport: 'soccer', league: 'fifa.world' },
    { sport: 'soccer', league: 'fifa.worldq.uefa' },
    { sport: 'soccer', league: 'fifa.worldq.conmebol' },
    { sport: 'soccer', league: 'fifa.worldq.concacaf' },
    { sport: 'soccer', league: 'fifa.worldq.afc' },
    { sport: 'soccer', league: 'fifa.worldq.caf' },
    { sport: 'soccer', league: 'fifa.friendly' },
    { sport: 'soccer', league: 'uefa.champions' },
    { sport: 'soccer', league: 'uefa.champions_qual' },
    { sport: 'soccer', league: 'uefa.europa' },
    { sport: 'soccer', league: 'uefa.europa.conf' },
    { sport: 'soccer', league: 'uefa.nations' },
    { sport: 'soccer', league: 'uefa.euro' },
  ],
  // The app's categories: "soccer" for association football, "football" for
  // American football. Legacy ids from the old feed stay mapped.
  'american-football': AMERICAN_FOOTBALL_LEAGUES,
  football: AMERICAN_FOOTBALL_LEAGUES,
  combat: [{ sport: 'mma', league: 'ufc' }],
  fight: [{ sport: 'mma', league: 'ufc' }],
  basketball: [
    { sport: 'basketball', league: 'nba' },
    { sport: 'basketball', league: 'wnba' },
    { sport: 'basketball', league: 'mens-college-basketball' },
    { sport: 'basketball', league: 'womens-college-basketball' },
  ],
  hockey: [
    { sport: 'hockey', league: 'nhl' },
    { sport: 'hockey', league: 'mens-college-hockey' },
  ],
  baseball: [
    { sport: 'baseball', league: 'mlb' },
    { sport: 'baseball', league: 'college-baseball' },
  ],
  tennis: [
    { sport: 'tennis', league: 'atp' },
    { sport: 'tennis', league: 'wta' },
  ],
  racing: [
    { sport: 'racing', league: 'f1' },
    { sport: 'racing', league: 'irl' },
    { sport: 'racing', league: 'nascar' },
  ],
  'motor-sports': [
    { sport: 'racing', league: 'f1' },
    { sport: 'racing', league: 'irl' },
    { sport: 'racing', league: 'nascar' },
  ],
  rugby: [{ sport: 'rugby', league: '289234' }],
};

/** The leagues of one category. */
export function leaguesForSport(category: string): readonly LeagueRef[] {
  return SPORT_LEAGUES[category] ?? [];
}
