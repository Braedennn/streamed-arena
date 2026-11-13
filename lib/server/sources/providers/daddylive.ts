// The mirror as the app sees it: one event, read by the app itself.
//
// This is the app's own scraper working through the provider board's front
// door. Nothing between the app and the video is asked to know anything -
// the schedule is read off the mirror's pages, the delivery of a channel is
// read off its embed page, and the playlist is fetched the way the embed's
// own player fetches it. The feed that comes out is then measured by the
// same probe every other candidate faces.
//
// A channel of the mirror is named again the same way on every read, which
// is what keeps a feed alive between refreshes: the id travels with the
// event, and the token is minted again whenever the event's feeds are asked
// for, so a feed that lives a while is fed by tokens that are still young.

import { mirrorEventChannels, mirrorEvents, type MirrorEvent } from '@/lib/server/mirror/schedule';
import { mirrorManifestUrl } from '@/lib/server/mirror/edge';
import { teamsOfTitle } from './names';
import type { ProviderApi, ProviderEvent, ProviderFeed } from './types';

/**
 * How the mirror's own categories become the app's sports.
 *
 * The schedule carries the sport in the category's name; only the ones the
 * user follows are fetched, and each lands in one of the app's own words.
 */
function sportOf(category: string): string {
  if (/Basketball/i.test(category) || /^NBA/i.test(category)) return 'Basketball';
  if (/Ice Hockey/i.test(category) || /^NHL/i.test(category)) return 'Ice Hockey';
  if (/Football/i.test(category)) return 'Football';
  if (/Soccer/i.test(category)) return 'Soccer';
  if (/MMA|Boxing|UFC|Combat/i.test(category)) return 'Combat';
  return 'other';
}

/**
 * The start of an event, in the mirror's own clock.
 *
 * The site writes the games of the US day in its own clock (UK GMT), so an
 * evening of games crosses midnight there: a game that starts at 20:00 in
 * the US is written as 01:00, and that 01:00 belongs to the next day of
 * the site. Placing that hour on today would put the game a day early -
 * and two rows for one game on the board.
 *
 * So the hour is placed on the day it is closest to now. The match itself
 * is found by the names of the teams.
 */
function hourToStamp(minute: number | null, live: boolean): number {
  const now = new Date();
  if (minute === null) return Math.floor(now.getTime() / 1000);
  const base = new Date(now);
  base.setUTCHours(Math.floor(minute / 60), minute % 60, 0, 0);
  const nextDay = new Date(base.getTime() + 24 * 60 * 60 * 1000);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const first = Math.floor(base.getTime() / 1000);
  const second = Math.floor(nextDay.getTime() / 1000);
  return Math.abs(first - nowSeconds) <= Math.abs(second - nowSeconds) ? first : second;
}

function eventOf(entry: MirrorEvent, nowSeconds: number): ProviderEvent {
  const teams = [entry.teams[0], entry.teams[1]] as [string, string];
  const start = hourToStamp(entry.minuteOfDay, false);
  const delta = Math.abs(nowSeconds - start);
  // An event whose hour sits near the clock's hour is the one that is on;
  // the mirror's clock is not the app's, so the window is wide on purpose.
  const live = entry.minuteOfDay === null || delta < 2.5 * 3600 || delta > 21.5 * 3600;
  return {
    id: entry.id,
    title: entry.league ? `${entry.league} — ${teams.join(' vs ')}` : teams.join(' vs '),
    sport: sportOf(entry.category),
    league: entry.league,
    network: entry.channels.map((channel) => channel.name).join(' · '),
    startsAt: start,
    endsAt: start + 2.5 * 3600,
    live,
    teams,
  };
}

export const daddyliveApi: ProviderApi = {
  id: 'daddylive',
  label: 'DaddyLive',

  async events(): Promise<ProviderEvent[]> {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const entries = await mirrorEvents();
    return entries.map((entry) => eventOf(entry, nowSeconds));
  },

  async feeds(event: ProviderEvent): Promise<ProviderFeed[]> {
    const channels = mirrorEventChannels(event.id);
    if (!channels || channels.length === 0) return [];

    // Every channel of the event is one way into the same picture. The app
    // takes them all: a channel that is switched off is refused by the
    // probe, and one that answers wins.
    const feeds = await Promise.all(channels.slice(0, 12).map(async (channel) => ({
      eventId: event.id,
      quality: 'HD',
      title: channel.name,
      manifestUrl: await mirrorManifestUrl(channel.id).catch(() => null),
      playerUrl: null,
      referers: ['https://dembed.st/'] as const,
    })));
    return feeds.filter((feed) => Boolean(feed.manifestUrl));
  },
};
