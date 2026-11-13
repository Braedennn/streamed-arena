// The provider APIs, and what they know.
//
// Every provider is asked for the board, and the board is matched against the
// match the user opened. The match is found on the names of the teams: the
// providers and the scoreboards write the same match differently and in a
// different order, but they name the same two teams.
//
// The feeds of the match are then taken from every provider that has it. A
// provider that has nothing is not an error - the app simply asks the next
// one.

import { ppvApi } from './ppv';
import { strmfreeApi } from './strmfree';
import { daddyliveApi } from './daddylive';
import { embedReferers, isEmbedPage, resolveEmbed } from './embed';
import { strictMode } from '@/lib/server/mode';
import { isChannelRow } from './channels';
import { sameEvent, teamsOfTitle } from './names';
import type { ProviderApi, ProviderEvent, ProviderFeed } from './types';

/** The provider APIs the app knows. */
export const PROVIDER_APIS: readonly ProviderApi[] = [daddyliveApi, strmfreeApi, ppvApi];

/** A provider's event, with the provider it came from. */
export interface ProviderMatch {
  readonly api: ProviderApi;
  readonly event: ProviderEvent;
}

/** A feed of a match, with the provider it came from. */
export interface ProviderFeedCandidate {
  readonly providerId: string;
  readonly providerLabel: string;
  readonly event: ProviderEvent;
  readonly feed: ProviderFeed;
}

/** One match of a provider's board, in the shape the app's board uses. */
export interface ProviderBoardStream {
  /** The provider the row came from ("ppv", "strmfree", "daddylive"). */
  readonly providerId: string;
  readonly stream_key: string;
  readonly name: string;
  readonly category: string;
  readonly league: string;
  /** Unix seconds. */
  readonly match_timestamp: number;
  readonly viewers: number;
  readonly team1: { readonly name: string } | null;
  readonly team2: { readonly name: string } | null;
  readonly live: boolean;
}

/** The board of every provider, as the app's board reads it. */
export async function providerBoardStreams(): Promise<ProviderBoardStream[]> {
  const boards = await Promise.all(
    PROVIDER_APIS.map(async (api) => {
      try {
        return await api.events();
      } catch {
        return [] as ProviderEvent[];
      }
    }),
  );

  const streams: ProviderBoardStream[] = [];
  for (const [index, api] of PROVIDER_APIS.entries()) {
    for (const event of boards[index] ?? []) {
      // A channel is not a match. The providers publish the channels of a
      // network beside the games, and the app does not show them: the board
      // is a list of games, and a channel that runs all day is not one.
      if (isChannelRow({ league: event.league })) continue;
      const teams = event.teams.length === 2 && event.teams[0] && event.teams[1]
        ? event.teams
        : teamsOfTitle(event.title);
      streams.push({
        providerId: api.id,
        stream_key: event.id,
        name: event.title,
        category: event.sport,
        league: event.league,
        match_timestamp: event.startsAt,
        viewers: 0,
        team1: teams[0] ? { name: teams[0] } : null,
        team2: teams[1] ? { name: teams[1] } : null,
        live: event.live,
      });
    }
  }
  return streams;
}

/** The event a provider publishes under one id, when it is one of them. */
export async function providerMatchById(id: string): Promise<ProviderMatch | null> {
  if (!id) return null;
  const boards = await Promise.all(
    PROVIDER_APIS.map(async (api) => {
      try {
        return await api.events();
      } catch {
        return [] as ProviderEvent[];
      }
    }),
  );

  for (const [index, api] of PROVIDER_APIS.entries()) {
    for (const event of boards[index] ?? []) {
      if (event.id === id) return { api, event };
    }
  }
  return null;
}

/** Everything the providers know, matched against a match of the app's board. */
export async function providerMatchesFor(
  title: string,
  teams: readonly [string, string],
): Promise<ProviderMatch[]> {
  const boards = await Promise.all(
    PROVIDER_APIS.map(async (api) => {
      try {
        return await api.events();
      } catch {
        return [] as ProviderEvent[];
      }
    }),
  );

  const wanted: [string, string] = teams[0] && teams[1] ? [teams[0], teams[1]] : teamsOfTitle(title);
  const matches: ProviderMatch[] = [];

  for (const [index, api] of PROVIDER_APIS.entries()) {
    for (const event of boards[index] ?? []) {
      const eventTeams = event.teams.length === 2 && event.teams[0] && event.teams[1]
        ? event.teams
        : teamsOfTitle(event.title);
      if (sameEvent(wanted, eventTeams)) {
        matches.push({ api, event });
        break;
      }
    }
  }

  return matches;
}

/**
 * The providers that know a match.
 *
 * The match may be published by one of the provider APIs under its own id, or
 * by the app's own provider. Either way it is the same match, and the feeds
 * are looked up for the match - not for the board the row came from.
 *
 * A row is a name, not a contract: the provider whose board published the row
 * may have shut its door today while another provider carries the same game.
 * So the provider the row belongs to is asked first - it knows the match by
 * its own id, which is the most certain way to find it - and every other
 * provider that knows the same two teams is asked as well. The feeds are
 * measured afterwards, and the one that plays wins.
 */
export async function providerMatchesForMatch(
  streamKey: string,
  title: string,
  teams: readonly [string, string],
): Promise<ProviderMatch[]> {
  const matches: ProviderMatch[] = [];
  const seen = new Set<string>();

  // The row's own provider and the other providers are asked at the same
  // time: both of them read the boards of every provider, and the answer of
  // one is not needed to ask the other.
  const [own, others] = await Promise.all([
    providerMatchById(streamKey),
    providerMatchesFor(title, teams),
  ]);
  if (own) {
    matches.push(own);
    seen.add(`${own.api.id}|${own.event.id}`);
  }

  for (const match of others) {
    const key = `${match.api.id}|${match.event.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push(match);
  }

  return matches;
}

/**
 * The feeds the app can host itself.
 *
 * A provider that publishes only its own player gives the app a page and
 * nothing else. The app opens that page and takes the playlist out of it
 * (see lib/server/sources/providers/embed.ts), and the feed becomes one the
 * app hosts like any other: the media is fetched, kept on disk and published
 * by the app's own server.
 *
 * When the page cannot be opened, the feed stays what it was - the provider's
 * own player - because a match that plays is a match that plays.
 */
async function hostableFeeds(
  feeds: readonly ProviderFeed[],
  options: { fresh?: boolean } = {},
): Promise<ProviderFeed[]> {
  const pages = new Set<string>();
  for (const feed of feeds) {
    if (feed.manifestUrl || !feed.playerUrl) continue;
    if (isEmbedPage(feed.playerUrl)) pages.add(feed.playerUrl);
  }
  if (pages.size === 0) return [...feeds];

  // The app on its own asks nobody but the carrier - not even a page.
  if (await strictMode()) return [...feeds];

  const resolved = new Map<string, string>();
  await Promise.all(
    [...pages].map(async (page) => {
      const url = await resolveEmbed(page, { fresh: options.fresh });
      if (url) resolved.set(page, url);
    }),
  );
  if (resolved.size === 0) return [...feeds];

  return feeds.map((feed) => {
    if (feed.manifestUrl || !feed.playerUrl) return feed;
    const url = resolved.get(feed.playerUrl);
    if (!url) return feed;
    return {
      ...feed,
      manifestUrl: url,
      playerUrl: null,
      embedUrl: feed.playerUrl,
      referers: embedReferers(),
    };
  });
}

/** The feeds one provider has for a match. */
async function feedsOf(match: ProviderMatch): Promise<ProviderFeedCandidate[]> {
  let providerFeeds: ProviderFeed[] = [];
  try {
    providerFeeds = await hostableFeeds(await match.api.feeds(match.event));
  } catch (error) {
    providerFeeds = [];
    if (process.env.ARENA_MEDIA_DEBUG === '1') {
      console.log(
        `[sources] provider ${match.api.id} answered nothing: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  const feeds: ProviderFeedCandidate[] = [];
  for (const feed of providerFeeds) {
    feeds.push({
      providerId: match.api.id,
      providerLabel: match.api.label,
      event: match.event,
      feed,
    });
  }
  return feeds;
}

/**
 * The feeds of a match, from every provider that has it.
 *
 * The providers are asked at the same time. Each of them takes its own time
 * to answer - a page to open, a token to mint, a swarm to find - and the
 * match does not start playing until the slowest of them has answered. One
 * after another would make the wait the sum of all of them.
 *
 * The first provider that answers with a feed brings the match on, and the
 * others are handed over when they answer: a match that plays now is worth
 * more than a complete list of feeds a minute later.
 */
export async function providerFeedsFor(
  matches: readonly ProviderMatch[],
  onMore?: (feeds: readonly ProviderFeedCandidate[]) => void,
): Promise<ProviderFeedCandidate[]> {
  if (matches.length === 0) return [];

  let resolveFirst: (feeds: ProviderFeedCandidate[]) => void = () => undefined;
  const first = new Promise<ProviderFeedCandidate[]>((resolve) => {
    resolveFirst = resolve;
  });

  let waiting = matches.length;
  const all = Promise.all(
    matches.map(async (match) => {
      const feeds = await feedsOf(match);
      waiting -= 1;
      if (feeds.length > 0) resolveFirst(feeds);
      else if (waiting === 0) resolveFirst([]);
      return feeds;
    }),
  );

  const firstFeeds = await first;
  if (onMore) {
    void all
      .then((answers) => {
        const seen = new Set(firstFeeds.map((entry) => `${entry.providerId}|${entry.feed.manifestUrl ?? ''}|${entry.feed.playerUrl ?? ''}`));
        const more: ProviderFeedCandidate[] = [];
        for (const answer of answers) {
          for (const entry of answer) {
            const key = `${entry.providerId}|${entry.feed.manifestUrl ?? ''}|${entry.feed.playerUrl ?? ''}`;
            if (seen.has(key)) continue;
            seen.add(key);
            more.push(entry);
          }
        }
        if (more.length > 0) onMore(more);
      })
      .catch(() => undefined);
  }
  return firstFeeds;
}

export { sameEvent, teamsOfTitle };
export type { ProviderApi, ProviderEvent, ProviderFeed };

/**
 * A fresh address for a feed of a provider.
 *
 * The providers' addresses carry a token, and the token expires. When a feed
 * stops answering, the provider is asked for the match again and the feed is
 * taken from the new answer - the same way the app reads a new address from a
 * broadcaster instead of giving up on the game.
 *
 * A feed that came from a page is taken from that page: the page is the
 * feed's own identity, and the quality is only a name - two feeds of the
 * same match can carry the same one.
 */
export async function refreshProviderFeed(
  providerId: string,
  eventId: string,
  quality: string,
  embedUrl?: string,
): Promise<string | null> {
  const api = PROVIDER_APIS.find((entry) => entry.id === providerId);
  if (!api || !eventId) return null;

  let events: ProviderEvent[] = [];
  try {
    events = await api.events();
  } catch {
    return null;
  }
  const event = events.find((entry) => entry.id === eventId);
  if (!event) return null;

  let feeds: ProviderFeed[] = [];
  try {
    // A fresh address: the one that stopped answering is the one the app
    // has, so the page is asked again rather than asked about.
    //
    // Only the page of the feed that stopped answering is asked again: a
    // provider that publishes a match in several qualities publishes a page
    // for each of them, and the app has no reason to open the others.
    const published = await api.feeds(event);
    const wanted = embedUrl ? published.filter((feed) => feed.playerUrl === embedUrl) : [];
    feeds = await hostableFeeds(wanted.length > 0 ? wanted : published, { fresh: true });
  } catch {
    return null;
  }

  const withPlaylist = feeds.filter((feed) => Boolean(feed.manifestUrl));
  const fromPage = embedUrl
    ? withPlaylist.find((feed) => feed.embedUrl === embedUrl)
    : undefined;
  const feed =
    fromPage ??
    withPlaylist.find((entry) => entry.quality === quality) ??
    withPlaylist[0] ??
    null;
  return feed?.manifestUrl ?? null;
}
