// StreamFree - the provider the app has always read.
//
//   GET https://strmfree.st/api/v1/streams   the board
//   GET https://strmfree.st/embed/<sport>/<key>   the tokens of a match
//
// The board is the provider's API; the tokens live on the page of the match,
// and the playlist is that token in the address. The details live with the
// provider's own module (lib/server/streamfree.ts), which already knows how
// the doors, the tokens and the advertisement door work - this adapter only
// translates them into the shape every provider speaks.

import { providerBoardEntries, providerFeeds } from '@/lib/server/streamfree';
import { teamsOfTitle } from './names';
import type { ProviderApi, ProviderEvent, ProviderFeed } from './types';

/** The provider's sports, in the app's own words. */
const CATEGORY_MAP: Record<string, string> = {
  mma: 'combat',
  'motor-sports': 'racing',
};

function appCategory(sport: string): string {
  const text = sport.trim().toLowerCase();
  if (!text) return 'other';
  return CATEGORY_MAP[text] ?? text;
}

export const strmfreeApi: ProviderApi = {
  id: 'strmfree',
  label: 'StreamFree',

  async events(): Promise<ProviderEvent[]> {
    const entries = await providerBoardEntries();
    const events: ProviderEvent[] = [];
    for (const entry of entries) {
      const title = entry.name.trim();
      if (!entry.streamKey || !title) continue;
      const teams: [string, string] = entry.team1 && entry.team2
        ? [entry.team1, entry.team2]
        : teamsOfTitle(title);
      events.push({
        id: entry.streamKey,
        title,
        sport: appCategory(entry.category),
        league: entry.league,
        network: '',
        startsAt: entry.matchTimestamp,
        endsAt: 0,
        live: entry.live || entry.viewers > 0,
        teams,
      });
    }
    return events;
  },

  async feeds(event: ProviderEvent): Promise<ProviderFeed[]> {
    const views = await providerFeeds(event.id);
    return views.map((view) => ({
      eventId: event.id,
      quality: view.quality,
      title: event.title,
      manifestUrl: view.manifestUrl,
      playerUrl: null,
      referers: view.referers,
    }));
  },
};
