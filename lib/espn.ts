import type { Fixture } from '@/lib/types';
import { splitTitle } from '@/lib/utils';

// Live game stats via ESPN's public JSON API (no key required, CORS open).
// Streamed.pk fixtures are matched to ESPN games by team name.

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const TIMEOUT_MS = 8_000;

// Streamed.pk category -> ESPN scoreboard candidates. Soccer has no single
// league endpoint, so the major competitions are probed in parallel.
const SPORT_LEAGUES: Record<string, readonly { sport: string; league: string }[]> = {
  football: [
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
  'american-football': [
    { sport: 'football', league: 'nfl' },
    { sport: 'football', league: 'college-football' },
    { sport: 'football', league: 'cfl' },
    { sport: 'football', league: 'ufl' },
  ],
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
  fight: [{ sport: 'mma', league: 'ufc' }],
  tennis: [
    { sport: 'tennis', league: 'atp' },
    { sport: 'tennis', league: 'wta' },
  ],
  'motor-sports': [
    { sport: 'racing', league: 'f1' },
    { sport: 'racing', league: 'irl' },
    { sport: 'racing', league: 'nascar' },
  ],
  rugby: [{ sport: 'rugby', league: '289234' }],
};

export function leaguesForSport(category: string) {
  return SPORT_LEAGUES[category] ?? [];
}

interface EspnTeam {
  id?: string;
  displayName?: string;
  logo?: string;
}

interface EspnScoreboardEvent {
  id: string;
  competitions?: {
    competitors?: {
      homeAway?: string;
      team?: EspnTeam;
      score?: string;
    }[];
  }[];
}

export interface TeamStat {
  readonly name: string;
  readonly label: string;
  readonly displayValue: string;
}

export interface PlayerLeader {
  readonly statName: string;
  readonly statLabel: string;
  readonly athleteName: string;
  readonly displayValue: string;
  readonly headshot: string | null;
}

export interface GameSide {
  readonly name: string;
  readonly score: string;
  readonly logo: string | null;
  readonly stats: readonly TeamStat[];
  readonly leaders: readonly PlayerLeader[];
}

export interface GameStats {
  readonly league: string;
  readonly state: string;
  readonly statusDetail: string;
  readonly home: GameSide;
  readonly away: GameSide;
}

async function espnRequest<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`ESPN API responded ${response.status}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

// ESPN scopes its scoreboard to a day in US Eastern time, so queries are
// pinned to the fixture's local date — otherwise late-night games slip
// outside the API's default "today" window.
export function espnDateParam(timestamp: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date(timestamp))
    .replace(/-/g, '');
}

export function espnScoreboard(sport: string, league: string, dates?: string): Promise<EspnScoreboardEvent[]> {
  const query = dates ? `?dates=${dates}` : '';
  return espnRequest<{ events?: EspnScoreboardEvent[] }>(
    `${ESPN_BASE}/${sport}/${league}/scoreboard${query}`,
  ).then((data) => data.events ?? []);
}

function normalizeTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function teamNameScore(a: string, b: string): number {
  const na = normalizeTeamName(a);
  const nb = normalizeTeamName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 3;
  if (na.includes(nb) || nb.includes(na)) return 2;
  const tokensA = new Set(na.split(' '));
  const tokensB = new Set(nb.split(' '));
  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared += 1;
  }
  return shared > 0 ? 1 : 0;
}

export interface MatchedEvent {
  readonly sport: string;
  readonly league: string;
  readonly eventId: string;
}

export interface Scoreboard {
  readonly sport: string;
  readonly league: string;
  readonly events: readonly EspnScoreboardEvent[];
}

export function matchEvent(
  homeName: string,
  awayName: string,
  boards: readonly Scoreboard[],
): MatchedEvent | null {
  let best: { eventId: string; score: number; sport: string; league: string } | null = null;
  for (const board of boards) {
    for (const event of board.events) {
      const competition = event.competitions?.[0];
      if (!competition) continue;
      const competitors = competition.competitors ?? [];
      const home = competitors.find((entry) => entry.homeAway === 'home') ?? competitors[0];
      const away = competitors.find((entry) => entry.homeAway === 'away') ?? competitors[1];
      if (!home?.team?.displayName || !away?.team?.displayName) continue;
      const score =
        teamNameScore(homeName, home.team.displayName) +
        teamNameScore(awayName, away.team.displayName);
      if (score < 2) continue;
      if (best && best.score >= score) continue;
      best = { eventId: event.id, score, sport: board.sport, league: board.league };
    }
  }
  if (!best) return null;
  return { eventId: best.eventId, sport: best.sport, league: best.league };
}

interface EspnHeaderCompetitor {
  homeAway?: string;
  score?: string;
  team?: EspnTeam;
}

interface EspnSummary {
  header?: {
    competitions?: {
      status?: { type?: { state?: string; shortDetail?: string; detail?: string } };
      competitors?: EspnHeaderCompetitor[];
    }[];
  };
  boxscore?: {
    teams?: {
      team?: EspnTeam;
      statistics?: { name?: string; label?: string; abbreviation?: string; displayValue?: string }[];
    }[];
  };
  leaders?: {
    team?: EspnTeam;
    leaders?: {
      name?: string;
      displayName?: string;
      label?: string;
      displayValue?: string;
      athlete?: { displayName?: string; headshot?: { href?: string } };
      // Some sports (e.g. NFL) nest the athlete entries one level deeper,
      // grouped per stat category.
      leaders?: {
        displayValue?: string;
        athlete?: { displayName?: string; headshot?: { href?: string } };
      }[];
    }[];
  }[];
}

const STAT_ORDER = [
  'possessionPct',
  'totalShots',
  'shotsOnTarget',
  'wonCorners',
  'saves',
  'foulsCommitted',
  'yellowCards',
  'redCards',
  'offsides',
];

const HIGHER_IS_BETTER = new Set(['possessionPct', 'totalShots', 'shotsOnTarget', 'wonCorners', 'saves']);

function sortStats(stats: readonly TeamStat[]): TeamStat[] {
  return [...stats].sort((a, b) => {
    const indexA = STAT_ORDER.indexOf(a.name);
    const indexB = STAT_ORDER.indexOf(b.name);
    const rankA = indexA === -1 ? STAT_ORDER.length : indexA;
    const rankB = indexB === -1 ? STAT_ORDER.length : indexB;
    return rankA - rankB;
  });
}

function parseLeaders(leaders: EspnSummary['leaders'], teamId: string): PlayerLeader[] {
  for (const entry of leaders ?? []) {
    if (entry.team?.id !== teamId) continue;
    const out: PlayerLeader[] = [];
    for (const category of entry.leaders ?? []) {
      if (out.length >= 4) break;
      const nested = category.leaders?.[0];
      const athlete = category.athlete ?? nested?.athlete;
      if (!athlete?.displayName) continue;
      out.push({
        statName: category.name ?? '',
        statLabel: category.displayName ?? category.label ?? category.name ?? '',
        athleteName: athlete.displayName,
        displayValue: category.displayValue ?? nested?.displayValue ?? '',
        headshot: athlete.headshot?.href ?? null,
      });
    }
    return out;
  }
  return [];
}

export function parseGameStats(data: EspnSummary, league: string): GameStats | null {
  const competition = data.header?.competitions?.[0];
  const competitors = competition?.competitors ?? [];
  if (competitors.length < 2) return null;
  const homeComp = competitors.find((entry) => entry.homeAway === 'home') ?? competitors[0];
  const awayComp = competitors.find((entry) => entry.homeAway === 'away') ?? competitors[1];
  if (!homeComp?.team || !awayComp?.team) return null;

  const statsByTeam = new Map<string, TeamStat[]>();
  for (const entry of data.boxscore?.teams ?? []) {
    if (!entry.team?.id) continue;
    const stats = (entry.statistics ?? []).map((stat) => ({
      name: stat.name ?? '',
      label: stat.label ?? stat.abbreviation ?? stat.name ?? '',
      displayValue: stat.displayValue ?? '',
    }));
    statsByTeam.set(entry.team.id, sortStats(stats));
  }

  const toSide = (comp: EspnHeaderCompetitor): GameSide => ({
    name: comp.team?.displayName ?? '',
    score: comp.score ?? '',
    logo: comp.team?.logo ?? null,
    stats: statsByTeam.get(comp.team?.id ?? '') ?? [],
    leaders: parseLeaders(data.leaders, comp.team?.id ?? ''),
  });

  return {
    league,
    state: competition?.status?.type?.state ?? '',
    statusDetail: competition?.status?.type?.shortDetail ?? competition?.status?.type?.detail ?? '',
    home: toSide(homeComp),
    away: toSide(awayComp),
  };
}

export function espnSummary(sport: string, league: string, eventId: string): Promise<GameStats> {
  return espnRequest<EspnSummary>(
    `${ESPN_BASE}/${sport}/${league}/summary?event=${eventId}`,
  ).then((data) => {
    const stats = parseGameStats(data, league);
    if (!stats) throw new Error('No box score in ESPN summary');
    return stats;
  });
}

export function betterSide(stat: TeamStat, home: GameSide, away: GameSide): 'home' | 'away' | null {
  if (!HIGHER_IS_BETTER.has(stat.name)) return null;
  const homeValue = parseFloat(home.stats.find((entry) => entry.name === stat.name)?.displayValue ?? '');
  const awayValue = parseFloat(away.stats.find((entry) => entry.name === stat.name)?.displayValue ?? '');
  if (Number.isNaN(homeValue) || Number.isNaN(awayValue) || homeValue === awayValue) return null;
  return homeValue > awayValue ? 'home' : 'away';
}

export function fixtureTeamNames(fixture: Fixture): { home: string; away: string } {
  const fallback = splitTitle(fixture.title);
  return {
    home: fixture.home?.name ?? fallback.home,
    away: fixture.away?.name ?? fallback.away,
  };
}
