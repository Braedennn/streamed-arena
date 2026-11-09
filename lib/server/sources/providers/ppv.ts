// PPV.st - a provider API with a board of what is on.
//
//   GET https://api.ppv.st/api/streams             the board
//   GET https://api.ppv.st/api/streams/{uri_name}  one event and its feeds
//
// The board names every event of the day: the competition, the network that
// carries it ("Paramount+", "Sky Sport 8", "Fandango"), and the quality of
// the feed. That last part is what the app cares about: the games behind a
// subscription are the ones the app is here for.
//
// The per-event answer names the feeds. A feed is either a playlist the app
// can fetch itself, or the provider's own player - and when it is the player,
// the app shows that rather than pretending it has nothing.

import { ProviderCache, providerJson } from './http';
import { teamsOfTitle } from './names';
import type { ProviderApi, ProviderEvent, ProviderFeed } from './types';

const API = 'https://api.ppv.st';

interface PpvSource {
  readonly name?: string;
  readonly type?: string;
  readonly data?: string;
  readonly default?: boolean;
}

interface PpvStream {
  readonly id?: number;
  readonly name?: string;
  readonly tag?: string;
  readonly source_tag?: string;
  readonly source_tag_raw?: string;
  readonly uri_name?: string;
  readonly uri?: string;
  readonly starts_at?: number;
  readonly ends_at?: number;
  readonly always_live?: number | boolean;
  readonly iframe?: string;
  readonly m3u8?: string;
  readonly viewers?: number | string;
  readonly substreams?: readonly PpvStream[];
  readonly sources?: readonly PpvSource[];
}

interface PpvCategory {
  readonly category?: string;
  readonly id?: number;
  readonly always_live?: number | boolean;
  readonly streams?: readonly PpvStream[];
}

interface PpvBoard {
  readonly success?: boolean;
  readonly streams?: readonly PpvCategory[];
}

interface PpvEvent {
  readonly success?: boolean;
  readonly data?: PpvStream;
}

const boardCache = new ProviderCache<PpvBoard>(45_000);

/**
 * The provider's sports, in the app's own words.
 *
 * The provider says "Football" for the game that is football everywhere else
 * and "American Football" for the other one - so the names are translated
 * here, once, and the rest of the app only ever knows the app's names.
 */
const CATEGORY_MAP: Record<string, string> = {
  'American Football': 'football',
  Football: 'soccer',
  Basketball: 'basketball',
  'Combat Sports': 'combat',
  'Ice Hockey': 'hockey',
  Motorsports: 'racing',
  Rugby: 'rugby',
  Cricket: 'cricket',
  Golf: 'golf',
  Wrestling: 'wrestling',
  'Australian Football': 'aussie-rules',
  '24/7 Streams': 'tv',
};

/** The app's name for the provider's sport. */
export function appCategory(sport: string): string {
  const text = sport.trim();
  if (!text) return 'other';
  return CATEGORY_MAP[text] ?? text.toLowerCase().replace(/[\s-]+/g, '-');
}

/** The board of the provider, as it answers it. */
async function board(): Promise<PpvBoard | null> {
  return boardCache.read('board', async () => {
    const payload = await providerJson<PpvBoard>(`${API}/api/streams`, { timeoutMs: 10_000 });
    return payload && Array.isArray(payload.streams) ? payload : null;
  });
}

/**
 * The quality a feed is served in.
 *
 * The provider names the quality in words ("HD", "SD", "FHD") and sometimes
 * in the address itself ("..._540p"). The address is the truer of the two.
 */
export function qualityOf(tag: string, uri: string): string {
  const explicit = uri.match(/(\d{3,4}p)/i)?.[1]?.toLowerCase();
  if (explicit) return explicit;
  const text = tag.toLowerCase();
  if (text.includes('fhd') || text.includes('uhd') || text.includes('4k')) return '2160p';
  if (text.includes('hd')) return '1080p';
  if (text.includes('sd')) return '540p';
  return '';
}

function isLive(stream: PpvStream, now: number): boolean {
  if (stream.always_live === 1 || stream.always_live === true) return true;
  const starts = Number(stream.starts_at ?? 0);
  const ends = Number(stream.ends_at ?? 0);
  if (!starts) return false;
  if (starts > now) return false;
  if (ends && ends < now) return false;
  return true;
}

export const ppvApi: ProviderApi = {
  id: 'ppv',
  // The name the player sees. It is a name, not an address: the badge in the
  // switcher says where a feed comes from, and a domain would read as one.
  label: 'PPV',

  async events(): Promise<ProviderEvent[]> {
    const payload = await board();
    if (!payload?.streams) return [];
    const now = Math.floor(Date.now() / 1000);
    const events: ProviderEvent[] = [];

    for (const category of payload.streams) {
      for (const stream of category.streams ?? []) {
        const id = stream.uri_name ?? (stream.id ? String(stream.id) : '');
        const title = (stream.name ?? '').trim();
        if (!id || !title) continue;
        const network = (stream.source_tag_raw ?? stream.source_tag ?? '').trim();
        events.push({
          id,
          title,
          sport: appCategory(category.category ?? ''),
          league: (stream.tag ?? '').trim(),
          network,
          startsAt: Number(stream.starts_at ?? 0),
          endsAt: Number(stream.ends_at ?? 0),
          live: isLive(stream, now),
          teams: teamsOfTitle(title),
        });
      }
    }

    return events;
  },

  async feeds(event: ProviderEvent): Promise<ProviderFeed[]> {
    const payload = await providerJson<PpvEvent>(
      `${API}/api/streams/${encodeURIComponent(event.id)}`,
      { timeoutMs: 10_000 },
    );
    const data = payload?.data;
    if (!data) return [];

    const feeds: ProviderFeed[] = [];

    // A playlist the provider hands out itself: the app fetches it and hosts
    // it like any other feed.
    const playlist = (data.m3u8 ?? '').trim();
    if (playlist.startsWith('http')) {
      feeds.push({
        eventId: event.id,
        quality: qualityOf(data.source_tag ?? '', ''),
        title: `${event.title}${data.source_tag ? ` · ${data.source_tag}` : ''}`,
        manifestUrl: playlist,
        playerUrl: null,
        referers: [''],
      });
    }

    // The provider's own player.
    for (const source of data.sources ?? []) {
      const url = (source.data ?? '').trim();
      if (!url.startsWith('http')) continue;
      feeds.push({
        eventId: event.id,
        quality: qualityOf(data.source_tag ?? '', ''),
        title: `${event.title}${data.source_tag ? ` · ${data.source_tag}` : ''}`,
        manifestUrl: null,
        playerUrl: url,
        referers: [''],
      });
    }

    // The same event at other qualities: the provider publishes a lower
    // quality of the same match as a substream of the first one.
    for (const sub of data.substreams ?? []) {
      const quality = qualityOf(sub.source_tag ?? '', sub.uri ?? '');
      for (const source of sub.sources ?? []) {
        const url = (source.data ?? '').trim();
        if (!url.startsWith('http')) continue;
        feeds.push({
          eventId: event.id,
          quality,
          title: `${event.title}${sub.source_tag ? ` · ${sub.source_tag}` : ''}`,
          manifestUrl: null,
          playerUrl: url,
          referers: [''],
        });
      }
    }

    return feeds;
  },
};
