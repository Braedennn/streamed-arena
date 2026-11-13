// The board the app builds itself.
//
// The app can read the day's fixtures from ESPN's own scoreboards - no mirror
// in the loop at all - and ESPN also names the network that carries each
// game. That name is what the direct-source resolver needs: it is the road
// from "this game is on" to "this is who is carrying it".
//
// The board is a list of matches with their teams, their kick-off and their
// carrier. It is what the app shows when the user says: no third party, ever.
//
// The match id carries everything the server needs to find the game again:
//   espn_<sport>_<league>_<eventId>
// It survives the channel id sanitizer (letters, digits, dots, dashes and
// underscores are kept), so the app can rebuild the match from the id alone -
// no memory of the previous board required.

import { upstreamText } from '@/lib/server/upstream';
import { espnDateParam } from '@/lib/espn';
import { SPORT_LEAGUES, leaguesForSport } from '@/lib/board-leagues';
import type { ApiMatch } from '@/lib/types';

export interface EspnBoardTeam {
  readonly name: string;
  readonly logo: string | null;
}

export interface EspnBoardGame {
  /** The app's own id: espn_<sport>_<league>_<eventId>. */
  readonly id: string;
  readonly espnEventId: string;
  readonly sport: string;
  readonly league: string;
  readonly title: string;
  /** The app's category (soccer, basketball, ...). */
  readonly category: string;
  /** Kick-off, in milliseconds. */
  readonly date: number;
  /** ESPN's own state: pre, in, post. */
  readonly state: 'pre' | 'in' | 'post' | string;
  /** The networks that carry it, as ESPN names them. */
  readonly networks: readonly string[];
  readonly home: EspnBoardTeam | null;
  readonly away: EspnBoardTeam | null;
  /** The score, when the game is running or over. */
  readonly homeScore?: string;
  readonly awayScore?: string;
}

const TIMEOUT_MS = 8_000;

interface RawCompetitor {
  readonly homeAway?: string;
  readonly score?: string;
  readonly team?: { displayName?: string; logo?: string };
}

interface RawGeoBroadcast {
  readonly market?: { readonly type?: string };
  readonly media?: { readonly shortName?: string };
}

interface RawEvent {
  readonly id?: string;
  readonly date?: string;
  readonly name?: string;
  readonly shortName?: string;
  readonly status?: { readonly type?: { readonly state?: string } };
  readonly competitions?: {
    readonly competitors?: readonly RawCompetitor[];
    readonly broadcasts?: { readonly names?: readonly string[] }[];
    readonly geoBroadcasts?: readonly RawGeoBroadcast[];
  }[];
}

function teamOf(
  competitors: readonly RawCompetitor[],
  side: 'home' | 'away',
): RawCompetitor | undefined {
  return (
    competitors.find((entry) => entry.homeAway === side) ??
    (side === 'home' ? competitors[0] : competitors[1])
  );
}

function teamInfo(competitor: RawCompetitor | undefined): EspnBoardTeam | null {
  const name = competitor?.team?.displayName?.trim();
  if (!name) return null;
  return { name, logo: competitor?.team?.logo ?? null };
}

/** The networks that carry a game, as ESPN names them. */
export function networksOf(event: RawEvent): string[] {
  const names = new Set<string>();
  for (const broadcast of event.competitions?.[0]?.broadcasts ?? []) {
    for (const name of broadcast.names ?? []) {
      if (name) names.add(name);
    }
  }
  for (const geo of event.competitions?.[0]?.geoBroadcasts ?? []) {
    const name = geo?.media?.shortName?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

/** The id the app knows a game by. */
export function espnGameId(sport: string, league: string, eventId: string): string {
  return `espn_${sport}_${league}_${eventId}`;
}

/** Reads an id back into the game it names. */
export function parseEspnGameId(
  id: string,
): { sport: string; league: string; eventId: string } | null {
  if (!id.startsWith('espn_')) return null;
  // The id is espn_<sport>_<league>_<eventId>; the sport may itself carry an
  // underscore, so only the first part is the prefix.
  const parts = id.slice('espn_'.length).split('_');
  if (parts.length < 3) return null;
  const eventId = parts.pop() ?? '';
  const league = parts.pop() ?? '';
  const sport = parts.join('_');
  if (!sport || !league || !/^\d+$/.test(eventId)) return null;
  return { sport, league, eventId };
}

function titleOf(
  event: RawEvent,
  home: EspnBoardTeam | null,
  away: EspnBoardTeam | null,
): string {
  if (event.shortName) return event.shortName;
  if (home && away) return `${away.name} at ${home.name}`;
  return event.name ?? '';
}

/**
 * Reads a scoreboard and, when it is not enough, the day's scoreboard too.
 *
 * The scoreboard without a date is ESPN's own window: the games that are
 * coming up, up to a limit. For the American leagues that limit is one
 * slate - and the slate it answers with is the one that is over, because the
 * window is written in the league's own day and the games of the evening are
 * on the next one. So the app asked for the games of the day as well, and
 * put the two answers together.
 *
 * The day's scoreboard is only asked for when the window has nothing in the
 * future: a league whose window already reaches into the next week does not
 * need it, and that is most of them.
 */
async function readScoreboard(sport: string, league: string): Promise<RawEvent[]> {
  const events = await readScoreboardWindow(sport, league, '');
  if (events.length === 0) return events;

  // The newest game of the window: when it is still to come, the window
  // reaches far enough and there is nothing to add.
  const newest = events.reduce<number>((latest, event) => {
    const at = event.date ? Date.parse(event.date) : 0;
    return Number.isNaN(at) ? latest : Math.max(latest, at);
  }, 0);
  if (newest > Date.now() + 6 * 60 * 60 * 1000) return events;

  const today = await readScoreboardWindow(sport, league, espnDateParam(Date.now()));
  if (today.length === 0) return events;

  const seen = new Set(events.map((event) => event.id ?? ''));
  const merged = [...events];
  for (const event of today) {
    const id = event.id ?? '';
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    merged.push(event);
  }
  return merged;
}

/** One scoreboard answer. */
async function readScoreboardWindow(
  sport: string,
  league: string,
  dates: string,
): Promise<RawEvent[]> {
  const key = `${sport}/${league}/${dates}`;
  const cache = scoreboardCache();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < SCOREBOARD_CACHE_TTL_MS) {
    return [...cached.events];
  }

  const query = dates ? `?dates=${dates}` : '';
  try {
    const response = await upstreamText(
      `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/scoreboard${query}`,
      { headers: { accept: 'application/json' }, timeoutMs: TIMEOUT_MS },
    );
    if (response.status < 200 || response.status >= 300) {
      if (process.env.ARENA_MEDIA_DEBUG === '1') {
        console.log(
          `[board] ${sport}/${league}: the scoreboard answered ${response.status} - ${JSON.stringify(response.headers).slice(0, 300)}`,
        );
      }
      return [];
    }
    const payload = JSON.parse(response.body) as { events?: RawEvent[] } | RawEvent[];
    const events = Array.isArray(payload) ? payload : (payload.events ?? []);
    const list = Array.isArray(events) ? events : [];
    cache.set(key, { at: Date.now(), events: list });
    if (cache.size > 256) {
      const cutoff = Date.now() - SCOREBOARD_CACHE_TTL_MS * 4;
      for (const [entry, value] of cache) {
        if (value.at < cutoff) cache.delete(entry);
      }
    }
    return list;
  } catch (error) {
    if (process.env.ARENA_MEDIA_DEBUG === '1') {
      console.log(`[board] ${sport}/${league}: ${String(error).slice(0, 160)}`);
    }
    return [];
  }
}

/**
 * The scoreboards are kept for a short while.
 *
 * The board is read every half minute, and the games of a day do not change
 * that often. One reading serves every question - and a single game is read
 * the same way, so the app does not ask ESPN for the same league twice.
 */
const SCOREBOARD_CACHE_KEY = '__arena_espn_scoreboards__';
const SCOREBOARD_CACHE_TTL_MS = 45_000;

interface ScoreboardCacheEntry {
  readonly at: number;
  readonly events: readonly RawEvent[];
}

function scoreboardCache(): Map<string, ScoreboardCacheEntry> {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[SCOREBOARD_CACHE_KEY];
  if (existing instanceof Map) return existing as Map<string, ScoreboardCacheEntry>;
  const created = new Map<string, ScoreboardCacheEntry>();
  store[SCOREBOARD_CACHE_KEY] = created;
  return created;
}

/**
 * The day's games, as ESPN sees them.
 *
 * Every league the app knows is read in parallel and the results are put
 * together. A league that does not answer costs nothing else: the games of
 * the other leagues are still there.
 *
 * The reading is done a few at a time: sixty scoreboards at once is a lot to
 * ask of somebody else's server, and the answer that comes back is a refusal.
 */
const LEAGUE_CONCURRENCY = 6;

async function withLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await run(items[index] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function espnBoard(categories?: readonly string[]): Promise<EspnBoardGame[]> {
  const wanted = categories?.length ? categories : Object.keys(SPORT_LEAGUES);
  const key = [...wanted].sort().join(',');
  const cached = boardCache().get(key);
  if (cached && Date.now() - cached.at < BOARD_CACHE_TTL_MS) return [...cached.games];

  const jobs: { sport: string; league: string; category: string }[] = [];
  for (const category of wanted) {
    for (const entry of leaguesForSport(category)) {
      jobs.push({ sport: entry.sport, league: entry.league, category });
    }
  }

  const boards = await withLimit(jobs, LEAGUE_CONCURRENCY, async (job) => ({
    job,
    events: await readScoreboard(job.sport, job.league),
  }));

  const games: EspnBoardGame[] = [];
  const seen = new Set<string>();

  for (const { job, events } of boards) {
    for (const event of events) {
      if (!event.id) continue;
      const id = espnGameId(job.sport, job.league, event.id);
      if (seen.has(id)) continue;
      seen.add(id);

      const competitors = event.competitions?.[0]?.competitors ?? [];
      const home = teamInfo(teamOf(competitors, 'home'));
      const away = teamInfo(teamOf(competitors, 'away'));
      const date = event.date ? Date.parse(event.date) : Date.now();

      games.push({
        id,
        espnEventId: event.id,
        sport: job.sport,
        league: job.league,
        title: titleOf(event, home, away),
        category: job.category,
        date: Number.isNaN(date) ? Date.now() : date,
        state: event.status?.type?.state ?? 'pre',
        networks: networksOf(event),
        home,
        away,
        homeScore: teamOf(competitors, 'home')?.score,
        awayScore: teamOf(competitors, 'away')?.score,
      });
    }
  }

  // The soonest first: the board is read as "what is on, and what is next".
  games.sort((a, b) => a.date - b.date);
  boardCache().set(key, { at: Date.now(), games: [...games] });
  return games;
}

/**
 * The board is kept for a short while.
 *
 * The page asks for it every half minute, and the games of a day do not
 * change that often. Keeping it means one reading serves every question.
 */
const BOARD_CACHE_KEY = '__arena_espn_board__';
const BOARD_CACHE_TTL_MS = 30_000;

interface BoardCacheEntry {
  readonly at: number;
  readonly games: readonly EspnBoardGame[];
}

function boardCache(): Map<string, BoardCacheEntry> {
  const store = globalThis as unknown as Record<string, unknown>;
  const existing = store[BOARD_CACHE_KEY];
  if (existing instanceof Map) return existing as Map<string, BoardCacheEntry>;
  const created = new Map<string, BoardCacheEntry>();
  store[BOARD_CACHE_KEY] = created;
  return created;
}

/**
 * The games that are worth showing.
 *
 * A scoreboard answers with everything it knows, including games of last
 * year and the next one. The board is a schedule, not an archive: the games
 * that just finished stay for a few hours (the picture of them is still
 * worth watching), and the week ahead is there so the app can say what is
 * next.
 */
const BOARD_PAST_MS = 6 * 60 * 60 * 1000;
const BOARD_FUTURE_MS = 7 * 24 * 60 * 60 * 1000;

/** Keeps the games of the board: what is on, and what is next. */
export function boardWindow(games: readonly EspnBoardGame[], now = Date.now()): EspnBoardGame[] {
  const from = now - BOARD_PAST_MS;
  const to = now + BOARD_FUTURE_MS;
  return games.filter((game) => game.date >= from && game.date <= to);
}

/** Every category the app knows. */
export function boardCategories(): string[] {
  return Object.keys(SPORT_LEAGUES);
}

/**
 * One game, read on its own.
 *
 * The direct-source resolver knows a match by its id and needs nothing else:
 * the id names the league the game is in, and the league's scoreboard names
 * the game, its teams and the network that carries it.
 */
export async function espnGameById(
  sport: string,
  league: string,
  eventId: string,
): Promise<EspnBoardGame | null> {
  const events = await readScoreboard(sport, league);
  const event = events.find((entry) => entry.id === eventId);
  if (!event) return null;

  const competitors = event.competitions?.[0]?.competitors ?? [];
  const home = teamInfo(teamOf(competitors, 'home'));
  const away = teamInfo(teamOf(competitors, 'away'));
  const date = event.date ? Date.parse(event.date) : Date.now();

  return {
    id: espnGameId(sport, league, eventId),
    espnEventId: event.id ?? eventId,
    sport,
    league,
    title: titleOf(event, home, away),
    category: categoryOf(sport, league),
    date: Number.isNaN(date) ? Date.now() : date,
    state: event.status?.type?.state ?? 'pre',
    networks: networksOf(event),
    home,
    away,
    homeScore: teamOf(competitors, 'home')?.score,
    awayScore: teamOf(competitors, 'away')?.score,
  };
}

/** The app's category of a league. */
export function categoryOf(sport: string, league: string): string {
  for (const [category, entries] of Object.entries(SPORT_LEAGUES)) {
    if (entries.some((entry) => entry.sport === sport && entry.league === league)) return category;
  }
  return sport;
}

/* ------------------------------------------------------------------ */
/* The board as the page sees it                                       */
/* ------------------------------------------------------------------ */

/**
 * The app's own board, in the shape the page reads.
 *
 * The page has always read a list of matches from `/api/provider/streams`.
 * When the app is on its own board, that route answers with this instead -
 * the same shape, so nothing in the page has to know where the list came
 * from.
 */
export function boardMatches(games: readonly EspnBoardGame[]): ApiMatch[] {
  return games.map((game) => ({
    id: game.id,
    title: game.title,
    category: game.category,
    date: game.date,
    // The board has no picture of its own; the page only asks whether there
    // is one, and there is not.
    hasPoster: false,
    popular: false,
    teams: {
      home: game.home ? { name: game.home.name, badge: game.home.logo ?? '' } : null,
      away: game.away ? { name: game.away.name, badge: game.away.logo ?? '' } : null,
    },
    // The feeds of a match are found by the app itself, from the carrier.
    sources: [{ source: 'personal', id: game.id }],
  }));
}
