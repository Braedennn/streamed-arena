import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { keepPreviousData, useQueries, useQuery } from '@tanstack/react-query';
import { matchesApi, sportsApi, streamsApi, streamsForSources } from '@/lib/api';
import {
  espnDateParam,
  espnScoreboard,
  espnSummary,
  fixtureTeamNames,
  leaguesForSport,
  matchEvent,
  type GameStats,
  type Scoreboard,
} from '@/lib/espn';
import { countdownParts, deriveStatus, streamKey, type CountdownParts } from '@/lib/utils';
import { favoriteRank, pinFavoritesFirst, useFavorites } from '@/lib/favorites';
import type { ApiMatch, Fixture, MatchSource, Sport, StreamDto, StreamGroup } from '@/lib/types';

export const LIVE_POLL_MS = 15_000;
export const FIXTURE_POLL_MS = 30_000;

export const queryKeys = {
  sports: ['sports'] as const,
  live: ['matches', 'live'] as const,
  all: ['matches', 'all'] as const,
  today: ['matches', 'today'] as const,
  streams: (source: string, id: string) => ['streams', source, id] as const,
};

const tickValues = new Map<number, number>();
const tickListeners = new Map<number, Set<() => void>>();
const tickTimers = new Map<number, ReturnType<typeof setInterval>>();

function readTick(intervalMs: number): number {
  const cached = tickValues.get(intervalMs);
  if (cached !== undefined) return cached;
  const value = Date.now();
  tickValues.set(intervalMs, value);
  return value;
}

function subscribeTick(intervalMs: number, listener: () => void): () => void {
  let listeners = tickListeners.get(intervalMs);
  if (!listeners) {
    listeners = new Set();
    tickListeners.set(intervalMs, listeners);
    tickTimers.set(
      intervalMs,
      setInterval(() => {
        tickValues.set(intervalMs, Date.now());
        tickListeners.get(intervalMs)?.forEach((entry) => entry());
      }, intervalMs),
    );
  }
  listeners.add(listener);

  return () => {
    const current = tickListeners.get(intervalMs);
    if (!current) return;
    current.delete(listener);
    if (current.size > 0) return;
    const timer = tickTimers.get(intervalMs);
    if (timer) clearInterval(timer);
    tickTimers.delete(intervalMs);
    tickListeners.delete(intervalMs);
  };
}

export function useNow(intervalMs = 1000): number {
  const subscribe = useCallback((listener: () => void) => subscribeTick(intervalMs, listener), [intervalMs]);
  const snapshot = useCallback(() => readTick(intervalMs), [intervalMs]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

// Countdowns more than an hour out only show hours + minutes, so they ride the
// shared 30 s clock; the 1 s clock is only subscribed inside the final hour.
// Keeps a schedule page with hundreds of cards from re-rendering every second.
export function useCountdown(target: number | null | undefined): CountdownParts {
  const coarse = useNow(30_000);
  const precise = target != null && target - coarse < 3_600_000 && target - coarse > -30_000;
  const fine = useNow(precise ? 1000 : 30_000);
  const now = precise ? fine : coarse;
  return useMemo(() => countdownParts(target ?? now, now), [target, now]);
}

export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

export function useSportsQuery() {
  return useQuery({
    queryKey: queryKeys.sports,
    queryFn: sportsApi.all,
    staleTime: 1000 * 60 * 30,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

export function useLiveMatchesQuery() {
  return useQuery({
    queryKey: queryKeys.live,
    queryFn: matchesApi.live,
    refetchInterval: LIVE_POLL_MS,
    staleTime: 5_000,
    placeholderData: keepPreviousData,
    retry: 2,
  });
}

export function useAllMatchesQuery() {
  return useQuery({
    queryKey: queryKeys.all,
    queryFn: matchesApi.all,
    refetchInterval: FIXTURE_POLL_MS,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    retry: 2,
  });
}

function toFixture(match: ApiMatch, isLive: boolean, now: number): Fixture {
  return {
    ...match,
    status: deriveStatus(match.date, isLive, now),
    home: match.teams?.home ?? null,
    away: match.teams?.away ?? null,
  };
}

export interface FixturesState {
  readonly liveFixtures: readonly Fixture[];
  readonly inPlayFixtures: readonly Fixture[];
  readonly upcomingFixtures: readonly Fixture[];
  readonly allFixtures: readonly Fixture[];
  readonly featured: Fixture | null;
  readonly nextKickoff: Fixture | null;
  readonly liveIds: ReadonlySet<string>;
  readonly isLoading: boolean;
  /** Both feeds have answered at least once — safe to treat a missing id as gone. */
  readonly isReady: boolean;
  readonly isFetching: boolean;
  readonly isError: boolean;
  readonly refetch: () => void;
}

export function useFixtures(): FixturesState {
  const liveQuery = useLiveMatchesQuery();
  const allQuery = useAllMatchesQuery();
  const now = useNow(30_000);
  const { favorites } = useFavorites();

  const liveIds = useMemo(
    () => new Set((liveQuery.data ?? []).map((match) => match.id)),
    [liveQuery.data],
  );

  const liveFixtures = useMemo(
    () =>
      pinFavoritesFirst(
        (liveQuery.data ?? []).map((match) => toFixture(match, true, now)),
        favorites,
      ),
    [liveQuery.data, now, favorites],
  );

  const allFixtures = useMemo(() => {
    const seen = new Set<string>();
    const merged: Fixture[] = [];
    for (const match of liveQuery.data ?? []) {
      seen.add(match.id);
      merged.push(toFixture(match, true, now));
    }
    for (const match of allQuery.data ?? []) {
      if (seen.has(match.id)) continue;
      seen.add(match.id);
      merged.push(toFixture(match, false, now));
    }
    return merged;
  }, [liveQuery.data, allQuery.data, now]);

  // Favorited teams pin to the top of every board while their fixture is on
  // or starting soon; ended favorites keep their usual place. The base sort
  // stays intact inside each rank.
  const upcomingFixtures = useMemo(
    () =>
      allFixtures
        .filter((fixture) => fixture.status === 'upcoming')
        .sort((a, b) => favoriteRank(a, favorites) - favoriteRank(b, favorites) || a.date - b.date),
    [allFixtures, favorites],
  );

  const inPlayFixtures = useMemo(
    () =>
      allFixtures
        .filter(
          (fixture) =>
            fixture.status === 'in-play' && !liveIds.has(fixture.id),
        )
        .sort((a, b) => favoriteRank(a, favorites) - favoriteRank(b, favorites) || b.date - a.date),
    [allFixtures, favorites, liveIds],
  );

  const featured = useMemo(() => {
    const pool = liveFixtures.length > 0 ? liveFixtures : upcomingFixtures;
    if (pool.length === 0) return null;
    // A favorite's on/soon fixture claims the hero spotlight.
    const favoritePick = pool.find((fixture) => favoriteRank(fixture, favorites) === 0);
    const withPoster = pool.filter((fixture) => Boolean(fixture.poster));
    const source = favoritePick ? [favoritePick] : withPoster.length > 0 ? withPoster : pool;
    return [...source].sort((a, b) => Number(b.popular ?? false) - Number(a.popular ?? false))[0] ?? null;
  }, [liveFixtures, upcomingFixtures, favorites]);

  const nextKickoff = useMemo(
    () => upcomingFixtures.find((fixture) => fixture.status === 'upcoming') ?? null,
    [upcomingFixtures],
  );

  return {
    liveFixtures,
    inPlayFixtures,
    upcomingFixtures,
    allFixtures,
    featured,
    nextKickoff,
    liveIds,
    isLoading: liveQuery.isLoading && allQuery.isLoading,
    isFetching: liveQuery.isFetching || allQuery.isFetching,
    isReady: liveQuery.isSuccess && allQuery.isSuccess,
    isError: Boolean(liveQuery.isError && allQuery.isError),
    refetch: () => {
      void liveQuery.refetch();
      void allQuery.refetch();
    },
  };
}

export function useSourceStreams(source: string | null, id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.streams(source ?? 'none', id ?? 'none'),
    queryFn: () => streamsApi.forSource(source ?? '', id ?? ''),
    enabled: enabled && Boolean(source && id),
    staleTime: 20_000,
    refetchInterval: 60_000,
    retry: 1,
  });
}

export function useMatchStreams(sources: readonly MatchSource[], enabled: boolean) {
  const signature = sources.map((entry) => `${entry.source}:${entry.id}`).join('|');

  return useQuery({
    queryKey: ['streams', 'match', signature],
    queryFn: () => streamsForSources(sources),
    enabled: enabled && sources.length > 0,
    staleTime: 30_000,
    retry: 1,
    // Streams usually only appear around kick-off: keep polling while there is
    // nothing to play so a waiting watch page picks them up on its own.
    refetchInterval: (query) => ((query.state.data?.length ?? 0) > 0 ? false : 30_000),
  });
}

export function useStreamPreviews(matches: readonly ApiMatch[], limit = 8) {
  const targets = useMemo(() => matches.slice(0, limit), [matches, limit]);
  const signature = targets.map((match) => match.id).join('|');

  return useQueries({
    queries: targets.map((match) => ({
      queryKey: ['streams', 'preview', match.id],
      queryFn: () => streamsForSources(match.sources.slice(0, 2)),
      staleTime: 90_000,
      refetchInterval: 180_000,
      retry: 0,
      enabled: match.sources.length > 0,
    })),
    combine: (results) => {
      const byMatch = new Map<string, StreamDto[]>();
      results.forEach((result, index) => {
        const match = targets[index];
        if (!match) return;
        if (result.data) byMatch.set(match.id, result.data);
      });
      return { byMatch, signature, pending: results.some((result) => result.isPending) };
    },
  });
}

export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}

export function useStreamSelection(streams: readonly StreamDto[], resetKey?: string) {
  const groups = useMemo<StreamGroup[]>(() => {
    const map = new Map<string, StreamDto[]>();
    for (const stream of streams) {
      const bucket = map.get(stream.source);
      if (bucket) bucket.push(stream);
      else map.set(stream.source, [stream]);
    }
    return Array.from(map.entries()).map(([name, list]) => ({
      source: name,
      streams: list.sort((a, b) => a.streamNo - b.streamNo),
    }));
  }, [streams]);

  const [source, setSource] = useState<string | null>(null);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    if (resetKey === undefined) return;
    setSource(null);
    setSelectedKey(null);
  }, [resetKey]);

  useEffect(() => {
    if (streams.length === 0) return;
    const first = streams[0];
    if (!first) return;

    setSource((previous) => previous ?? first.source);
    setSelectedKey((previous) => {
      if (
        previous &&
        streams.some((stream) => streamKey(stream.source, stream.streamNo, stream.id) === previous)
      ) {
        return previous;
      }
      const target = groups.find((group) => group.source === source)?.streams[0] ?? first;
      return streamKey(target.source, target.streamNo, target.id);
    });
  }, [streams, groups, source]);

  const selectSource = useCallback(
    (nextSource: string) => {
      const group = groups.find((entry) => entry.source === nextSource);
      const target = group?.streams[0];
      setSource(nextSource);
      setSelectedKey(target ? streamKey(target.source, target.streamNo, target.id) : null);
    },
    [groups],
  );

  const selectStream = useCallback(
    (nextKey: string) => {
      const stream = streams.find(
        (entry) => streamKey(entry.source, entry.streamNo, entry.id) === nextKey,
      );
      if (!stream) return;
      setSource(stream.source);
      setSelectedKey(nextKey);
    },
    [streams],
  );

  return { groups, source, selectedKey, selectSource, selectStream };
}

export const GAME_STATS_REFRESH_MS = 15_000;

export interface GameStatsState {
  readonly supported: boolean;
  readonly matched: boolean;
  readonly isLoading: boolean;
  readonly stats: GameStats | null;
}

export function useGameStats(fixture: Fixture | null): GameStatsState {
  const leagues = useMemo(
    () => (fixture ? leaguesForSport(fixture.category) : []),
    [fixture],
  );
  const supported = leagues.length > 0;

  const boardDate = useMemo(
    () => (fixture ? espnDateParam(fixture.date) : undefined),
    [fixture],
  );

  const scoreboards = useQueries({
    queries: leagues.map(({ sport, league }) => ({
      queryKey: ['espn', 'scoreboard', sport, league, boardDate ?? ''],
      queryFn: () => espnScoreboard(sport, league, boardDate),
      staleTime: 30_000,
      refetchInterval: 60_000,
      retry: 0,
    })),
    combine: (results) => ({
      pending: results.some((result) => result.isPending),
      boards: results.map((result, index) => ({
        sport: leagues[index]?.sport ?? '',
        league: leagues[index]?.league ?? '',
        events: result.data ?? [],
      })) as Scoreboard[],
    }),
  });

  const match = useMemo(() => {
    if (!fixture || scoreboards.boards.length === 0) return null;
    const { home, away } = fixtureTeamNames(fixture);
    if (!home || !away) return null;
    return matchEvent(home, away, scoreboards.boards);
  }, [fixture, scoreboards.boards]);

  const summaryQuery = useQuery({
    queryKey: ['espn', 'summary', match?.sport ?? '', match?.league ?? '', match?.eventId ?? ''],
    queryFn: () => espnSummary(match!.sport, match!.league, match!.eventId),
    enabled: Boolean(match),
    staleTime: 10_000,
    refetchInterval: GAME_STATS_REFRESH_MS,
    retry: 0,
  });

  const boardsStillLoading =
    supported &&
    match === null &&
    scoreboards.pending &&
    scoreboards.boards.every((board) => board.events.length === 0);

  return {
    supported,
    matched: Boolean(match),
    // isLoading, not isPending: a disabled query (no ESPN match) stays
    // "pending" forever, which pinned the panel on its skeleton.
    isLoading: summaryQuery.isLoading || boardsStillLoading,
    stats: summaryQuery.data ?? null,
  };
}
