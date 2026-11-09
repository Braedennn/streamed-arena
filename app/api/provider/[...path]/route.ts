// The provider's public API, read by the app's own server.
//
// The page used to call the provider's API itself: the fixture list, the
// categories, the per-match sources. The app is the provider now, and the
// page is part of the app — so the page asks this app, and this app asks the
// provider with its own connection pool, its own deadlines and its own cache.
//
// Nothing about the media changes here: the streams still come from the
// app's own server. This is the fixture list — the matches on the board.
//
// What crosses back is scrubbed: the provider's media doors (the embed
// pages) are rewritten to local placeholders before the answer is handed to
// the page. The page only ever counts feeds and reads their quality, so it
// has no use for the provider's addresses — and it should not have them.
//
// When the app is on its own (the "never contact a third party" setting), the
// provider is not asked at all: the board comes from the scoreboards the app
// reads itself, and the feeds come from the broadcaster's own pages.
//
// GET /api/provider/<path>

import { upstreamText } from '@/lib/server/upstream';
import { strictMode } from '@/lib/server/mode';
import { boardCategories, boardWindow, espnBoard, type EspnBoardGame } from '@/lib/server/board';
import { sameTeam } from '@/lib/espn';
import { sourceUrls } from '@/lib/sources';
import { splitTitle } from '@/lib/utils';
import { resolveMatchSources, type ResolvedSource } from '@/lib/server/sources/resolve';
import { providerBoardStreams, type ProviderBoardStream } from '@/lib/server/sources/providers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TIMEOUT_MS = 10_000;
const PROVIDER_API = 'https://strmfree.st/api/v1';

/** The paths the app is allowed to ask for. A provider's own id may carry a colon. */
const ALLOWED = /^(streams|categories|sources\/[a-zA-Z0-9._:\-/]{1,160})$/;

/** How long an answer is reused. The board changes slowly; the client polls. */
const CACHE_TTL_MS = 4_000;
const CACHE = new Map<string, { at: number; body: string }>();

/** The provider's own hosts — nothing of theirs crosses back to the page. */
const PROVIDER_HOSTS = /^(?:[a-z0-9-]+\.)*(?:strmfree\.st|streamfree\.top)$/i;

/**
 * Rewrites the provider's media doors to local placeholders.
 *
 * The page reads the shape of a feed — how many there are, what quality,
 * whether one is on air — and never the address behind it. The address is
 * the app's business: it is where the app fetches the media from, and the app
 * hides it from the player.
 *
 * The provider's picture goes with it: the page does not show it, so it is
 * not sent. The team badges (ESPN's own images) are ordinary pictures and
 * stay where they are — they are not a server the player talks to.
 */
function scrub(value: unknown): unknown {
  if (typeof value === 'string') {
    if (!/^https?:\/\//i.test(value)) return value;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return value;
    }
    if (!PROVIDER_HOSTS.test(url.hostname)) return value;
    if (!url.pathname.includes('/embed/')) return value;
    // The tail carries what the page actually reads: the quality and the
    // source number ("...1080p2"). The host is dropped.
    const tail = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    return `/provider-media/${tail}`;
  }
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      // The provider's own picture is not shown by the app - it is not sent.
      if (key === 'thumbnail_url') {
        out[key] = null;
        continue;
      }
      out[key] = scrub(entry);
    }
    return out;
  }
  return value;
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path?: string[] }> },
) {
  const { path: parts } = await context.params;
  const path = (parts ?? []).join('/');
  if (!ALLOWED.test(path)) {
    return Response.json({ error: 'unsupported provider path' }, { status: 400 });
  }
  // The query string is part of the question (the board is filtered by
  // category), so it travels on.
  const search = new URL(request.url).search;

  // The app on its own: the provider is not contacted at all. The board is
  // the app's own, and the feeds come from the broadcaster's own pages.
  if (await strictMode()) {
    return ownAnswer(path, search);
  }

  const cached = CACHE.get(path + search);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return json(cached.body);
  }

  // The board: every provider API the app knows, and the app's own board.
  //
  // The board is built here rather than copied from one provider: the
  // providers know leagues the scoreboards do not carry (and the other way
  // round), and a board that empties because one provider is down is worse
  // than a board with one service fewer.
  if (path === 'streams') {
    const category = new URLSearchParams(search).get('category');
    const merged = await mergeBoards(category);
    if (merged) {
      const body = JSON.stringify(scrub(merged));
      CACHE.set(path + search, { at: Date.now(), body });
      return json(body);
    }
  }

  // The categories: the app's own, and the ones the providers publish.
  if (path === 'categories') {
    const published = await providerCategories();
    const categories = [...new Set([...boardCategories(), ...published])];
    const body = JSON.stringify({ categories });
    CACHE.set(path + search, { at: Date.now(), body });
    return json(body);
  }

  try {
    const response = await upstreamText(`${PROVIDER_API}/${path}${search}`, {
      headers: { accept: 'application/json' },
      timeoutMs: TIMEOUT_MS,
    });
    const answered = response.status >= 200 && response.status < 300;
    let payload: unknown = null;
    if (answered) {
      try {
        payload = JSON.parse(response.body);
      } catch {
        payload = null;
      }
    }

    // The feeds of a match: the provider's own list and the feeds the app
    // found itself, so the page counts every feed there is.
    //
    // The provider is not the last word here: it has never heard of the games
    // the app found by itself, so its answer for those is nothing at all -
    // and the app's own feeds are the answer then. A match nobody can serve
    // has no feeds, and that is an answer too.
    if (path.startsWith('sources/')) {
      const key = path.slice('sources/'.length);
      const own = await ownSources(key);
      const providerPayload = (payload ?? {}) as { sources?: unknown; live_sources?: unknown };
      const names = ownQualities(key, providerPayload.sources, providerPayload.live_sources, own);
      const body = JSON.stringify({
        stream_key: key,
        sources: names.sources,
        live_sources: names.live,
      });
      CACHE.set(path + search, { at: Date.now(), body });
      return json(body);
    }

    if (!answered || payload === null) {
      // The provider did not answer. The app's own board still does - the
      // fixtures of the day do not depend on one service, and a board that
      // empties because a provider is down is worse than a board with one
      // service fewer.
      return Response.json({ error: `the provider responded ${response.status}` }, { status: 502 });
    }

    const body = JSON.stringify(scrub(payload));
    CACHE.set(path + search, { at: Date.now(), body });
    if (CACHE.size > 64) {
      const cutoff = Date.now() - CACHE_TTL_MS * 10;
      for (const [key, entry] of CACHE) {
        if (entry.at < cutoff) CACHE.delete(key);
      }
    }
    return json(body);
  } catch {
    // The provider could not be reached at all. The app's own board answers
    // instead, so the day is still on the screen.
    if (path === 'streams') {
      const own = await ownAnswer(path, search);
      if (own.status === 200) return own;
    }
    return Response.json({ error: 'the provider could not be reached' }, { status: 504 });
  }
}

function json(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/* ------------------------------------------------------------------ */
/* The two boards, put together                                        */
/* ------------------------------------------------------------------ */

/** One match of the provider's board, as the provider prints it. */
interface ProviderStream {
  readonly stream_key?: string;
  readonly name?: string;
  readonly category?: string;
  readonly league?: string;
  /** Unix seconds. */
  readonly match_timestamp?: number;
  readonly viewers?: number;
  readonly thumbnail_url?: string | null;
  readonly team1?: { readonly name?: string; readonly logo?: string | null } | null;
  readonly team2?: { readonly name?: string; readonly logo?: string | null } | null;
  readonly sources?: unknown;
  readonly live_sources?: unknown;
}

function isProviderStream(value: unknown): value is ProviderStream {
  return Boolean(value && typeof value === 'object');
}

/** The matches of a board, whatever shape the board arrives in. */
function streamsOf(payload: unknown): ProviderStream[] | null {
  if (Array.isArray(payload)) {
    const streams = payload.filter(isProviderStream);
    return streams.length > 0 ? streams : null;
  }
  if (payload && typeof payload === 'object') {
    const streams = (payload as { streams?: unknown }).streams;
    if (Array.isArray(streams)) {
      const list = streams.filter(isProviderStream);
      return list.length > 0 ? list : null;
    }
  }
  return null;
}

/** The teams of a match of the provider's board. */
function teamsOfStream(stream: ProviderStream): [string, string] {
  const first = stream.team1?.name ?? '';
  const second = stream.team2?.name ?? '';
  if (first && second) return [first, second];
  // The provider names the teams in the title when it does not structure them.
  const { home, away } = splitTitle(stream.name ?? '');
  return [home, away === 'TBD' ? '' : away];
}

/** The teams of a game of the app's own board. */
function teamsOfGame(game: EspnBoardGame): [string, string] {
  return [game.home?.name ?? '', game.away?.name ?? ''];
}

/**
 * Are these two the same match?
 *
 * The provider and the scoreboard do not agree on which side is the home team
 * for a good many games, so both orders are tried.
 */
function sameMatch(first: [string, string], second: [string, string]): boolean {
  const [a, b] = first;
  const [c, d] = second;
  if (!a || !b || !c || !d) return false;
  const straight = sameTeam(a, c) && sameTeam(b, d);
  const crossed = sameTeam(a, d) && sameTeam(b, c);
  return straight || crossed;
}

/** The name a game is shown under. */
function gameName(game: EspnBoardGame): string {
  const home = game.home?.name ?? '';
  const away = game.away?.name ?? '';
  if (home && away) return `${home} vs ${away}`;
  return game.title;
}

/** A game of the app's own board, in the shape the page reads. */
function ownStream(game: EspnBoardGame): ProviderStream {
  return {
    stream_key: game.id,
    name: gameName(game),
    category: game.category,
    league: game.league,
    // The page works in milliseconds; the wire shape is in seconds.
    match_timestamp: Math.floor(game.date / 1000),
    viewers: 0,
    // The picture's address stays in the app's server: the page only needs
    // to know that there is one.
    thumbnail_url: null,
    team1: game.home ? { name: game.home.name, logo: game.home.logo } : null,
    team2: game.away ? { name: game.away.name, logo: game.away.logo } : null,
    // The feeds of a match are found when the match is opened - the app
    // does not walk every game of the day to find out what it could play.
    sources: [],
    // A game that is on is live: that is what the live board is made of.
    live_sources: game.state === 'in' ? ['live'] : [],
  };
}

/**
 * One match of a provider's board, in the shape the page reads.
 *
 * The feeds of a provider's match are found when the match is opened - the
 * app does not walk every game of the day to find out what it could play.
 */
function providerStreamOf(stream: ProviderBoardStream): ProviderStream {
  return {
    stream_key: stream.stream_key,
    name: stream.name,
    category: stream.category,
    league: stream.league,
    match_timestamp: stream.match_timestamp,
    viewers: stream.viewers,
    thumbnail_url: null,
    team1: stream.team1,
    team2: stream.team2,
    sources: [],
    // A match that is on is live: that is what the live board is made of.
    live_sources: stream.live ? ['live'] : [],
  };
}

/** The categories the providers publish. */
async function providerCategories(): Promise<string[]> {
  try {
    const streams = await providerBoardStreams();
    return [...new Set(streams.map((stream) => stream.category).filter(Boolean))];
  } catch {
    return [];
  }
}

/**
 * The board of every provider and the board of the app, together.
 *
 * The providers know leagues the scoreboards do not carry, and the scoreboards
 * know games the providers have not published yet. A match that is on both
 * boards is one match: the provider's own line is kept, because the
 * provider's key is what its media is published under - the app finds the
 * same game on the scoreboards by the names of the teams.
 *
 * The category is the one the page asked for: the app's own games are read
 * for that category, and the providers' matches are filtered the same way.
 */
async function mergeBoards(
  category?: string | null,
): Promise<{ count: number; streams: ProviderStream[] } | null> {
  let providerStreams: ProviderStream[] = [];
  try {
    providerStreams = (await providerBoardStreams()).map(providerStreamOf);
  } catch {
    providerStreams = [];
  }

  if (category) {
    const wanted = category.trim().toLowerCase();
    providerStreams = providerStreams.filter(
      (stream) => (stream.category ?? '').trim().toLowerCase() === wanted,
    );
  }

  let games: EspnBoardGame[] = [];
  try {
    games = boardWindow(await espnBoard(category ? [category] : undefined));
  } catch {
    games = [];
  }

  // The games of the app's own board that a provider already lists.
  const claimed = new Set<string>();
  for (const stream of providerStreams) {
    const teams = teamsOfStream(stream);
    for (const game of games) {
      if (!sameMatch(teams, teamsOfGame(game))) continue;
      claimed.add(game.id);
      break;
    }
  }

  const streams: ProviderStream[] = [...providerStreams];
  for (const game of games) {
    if (claimed.has(game.id)) continue;
    streams.push(ownStream(game));
  }

  return { count: streams.length, streams };
}

/* ------------------------------------------------------------------ */
/* The feeds the app found itself                                      */
/* ------------------------------------------------------------------ */

/**
 * The feeds of a match the app found itself.
 *
 * These are the broadcaster's own pages and the free channels of the network
 * that carries the game. Every one of them was measured before it got here,
 * so everything in this list actually plays.
 */
async function ownSources(key: string): Promise<ResolvedSource[]> {
  try {
    const resolution = await resolveMatchSources(key);
    return [...resolution.sources];
  } catch {
    return [];
  }
}

/**
 * The name the provider gives one of its feeds.
 *
 * The provider names a feed by the quality it is served in, and numbers it
 * when there is more than one feed at that quality ("1080p", "1080p2"). The
 * page counts the feeds and asks whether one of them is in HD - that is all
 * it needs to know about them.
 */
function feedName(url: string, streamKey: string): string {
  const segment = url.split('/').pop() ?? '';
  if (streamKey && segment.startsWith(streamKey)) {
    const tail = segment.slice(streamKey.length);
    if (tail) return tail;
  }
  const match = segment.match(/(\d{3,4}p\d*)$/i);
  return match?.[1]?.toLowerCase() ?? '';
}

/**
 * The feeds of a match, by the names the page knows them by.
 *
 * The provider's own feeds come first, then the ones the app found: both
 * lists are named the same way, so the page can count them together and read
 * the quality of each. The app's own feeds are live by the time they get
 * here - they were measured, and only a feed with media is offered.
 */
function ownQualities(
  streamKey: string,
  providerSources: unknown,
  providerLiveSources: unknown,
  own: readonly ResolvedSource[],
): { sources: string[]; live: string[] } {
  const sources: string[] = [];
  const live: string[] = [];
  const used = new Set<string>();

  const add = (name: string, isLive: boolean): void => {
    if (!name) return;
    if (!used.has(name)) {
      used.add(name);
      sources.push(name);
    }
    if (isLive && !live.includes(name)) live.push(name);
  };

  for (const url of sourceUrls(providerSources)) {
    add(feedName(url, streamKey), false);
  }
  for (const url of sourceUrls(providerLiveSources)) {
    add(feedName(url, streamKey), true);
  }

  for (const source of own) {
    const quality = source.quality || 'auto';
    let name = quality;
    let number = 1;
    while (used.has(name)) {
      number += 1;
      name = `${quality}${number}`;
    }
    used.add(name);
    sources.push(name);
    live.push(name);
  }

  return { sources, live };
}

/* ------------------------------------------------------------------ */
/* The app's own board                                                 */
/* ------------------------------------------------------------------ */

/**
 * The answer the app gives when it is on its own.
 *
 * The shape is the one the page already reads - the page does not have to
 * know where the list came from. What is inside is the app's own: the games
 * come from the scoreboards the app reads itself, and the feeds of a match
 * come from the broadcaster's own pages.
 */
async function ownAnswer(path: string, search: string): Promise<Response> {
  if (path === 'categories') {
    return json(JSON.stringify({ categories: boardCategories() }));
  }

  if (path === 'streams') {
    const category = new URLSearchParams(search).get('category');
    const games = boardWindow(await espnBoard(category ? [category] : undefined));
    const streams = games.map((game) => ownStream(game));
    return json(JSON.stringify({ count: streams.length, streams }));
  }

  if (path.startsWith('sources/')) {
    const key = path.slice('sources/'.length);
    const own = await ownSources(key);
    // The feeds are named by their quality, the same way the app names the
    // feeds of a match anywhere else: "1080p", "720p", ...
    const ids: string[] = [];
    const counts = new Map<string, number>();
    for (const source of own) {
      const seen = counts.get(source.quality) ?? 0;
      counts.set(source.quality, seen + 1);
      ids.push(seen === 0 ? source.quality : `${source.quality}${seen + 1}`);
    }
    return json(JSON.stringify({ stream_key: key, sources: ids, live_sources: ids }));
  }

  return Response.json({ error: 'unsupported provider path' }, { status: 400 });
}
