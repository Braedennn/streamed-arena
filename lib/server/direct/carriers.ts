// The carriers the app reads for itself.
//
// The app does not need a mirror to know who is carrying a game: ESPN's
// scoreboard says so ("CBSSN", "ESPN", "Fox", ...). This module is the road
// from that name to the carrier's own feed.
//
// Every carrier works the same way: the app reads the carrier's own pages -
// the pages a visitor would read - and takes the feed out of them. There is
// no key, no account and no third-party API in the middle: the carrier's page
// is the source, the same way a television schedule is.
//
// What comes out of a page is a *candidate*: a manifest, or a page that
// carries one. The candidate is not trusted - the probe in probe.ts plays it
// before the app offers it, and a candidate that does not answer never
// reaches the player.
//
// Some carriers put their live games behind a subscription. Those are listed
// in WALLED_NETWORKS: the app does not pretend it can reach them, and says
// so instead.

import type { EspnBoardGame } from '@/lib/server/board';

/** A feed the carrier's pages point at. */
export interface DirectCandidate {
  /** The manifest, when the page states it. */
  readonly manifestUrl?: string;
  /** A page that carries the manifest, when the page does not state it. */
  readonly pageUrl?: string;
  /** The referers to try, best first. */
  readonly referers: readonly string[];
  readonly carrierId: string;
  readonly carrierLabel: string;
  /** What the carrier calls this feed. */
  readonly title: string;
  /** The teams of the game, as the carrier names them. */
  readonly home?: string;
  readonly away?: string;
  /** When the game starts, in milliseconds. */
  readonly startsAt?: number;
  /** The quality, when the carrier states one. */
  readonly quality?: string;
}

/** One carrier the app knows how to read. */
export interface Carrier {
  readonly id: string;
  readonly label: string;
  /** The names ESPN gives the network. */
  readonly networks: readonly string[];
  /** The pages the app reads for a game. */
  readonly pages: (game: EspnBoardGame) => readonly string[];
  /** What the app takes out of a page. */
  readonly extract: (text: string, page: string) => readonly DirectCandidate[];
}

/**
 * The networks whose live games sit behind a subscription.
 *
 * The app cannot reach them, and says so - it does not pretend, and it does
 * not fall back to a mirror behind the user's back. Those matches are the
 * user's own source to play, or they are not played.
 */
export const WALLED_NETWORKS: Readonly<Record<string, string>> = {
  'espn+': 'ESPN+',
  'paramount+': 'Paramount+',
  peacock: 'Peacock',
  dazn: 'DAZN',
  tudn: 'TUDN',
  'univision Deportes': 'Univision Deportes',
  'telemundo deportes': 'Telemundo Deportes',
  univision: 'Univision',
  telemundo: 'Telemundo',
  'sky sports': 'Sky Sports',
  sky: 'Sky',
  fubo: 'Fubo',
  'bally sports': 'Bally Sports',
  'prime video': 'Prime Video',
  'apple tv': 'Apple TV',
  hulu: 'Hulu',
  'directv stream': 'DirecTV Stream',
  sling: 'Sling',
  vix: 'ViX',
  'mlb tv': 'MLB.TV',
  'nfl+': 'NFL+',
};

/** The friendly name of a network, when the app knows it. */
export function walledNetwork(network: string): string | null {
  return WALLED_NETWORKS[network.trim().toLowerCase()] ?? null;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/** A browser's user agent - some carriers answer a browser and not a bot. */
export const CARRIER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Any manifest a page mentions. */
export function manifestsIn(text: string): string[] {
  const found = text.match(/https?:[^"'\\\s<>]+?\.m3u8[^"'\\\s<>]*/g) ?? [];
  const clean = found
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('http'));
  return [...new Set(clean)];
}

/** A slug a carrier's URL can be built from. */
export function slugOf(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/** The pages a carrier's own site has for a game, by sport. */
function sportPath(game: EspnBoardGame): string {
  switch (game.league) {
    case 'college-football':
      return 'college-football';
    case 'mens-college-basketball':
    case 'womens-college-basketball':
      return 'college-basketball';
    case 'nba':
      return 'nba';
    case 'wnba':
      return 'wnba';
    case 'nfl':
      return 'nfl';
    case 'mlb':
    case 'college-baseball':
      return 'mlb';
    case 'nhl':
      return 'nhl';
    case 'f1':
      return 'f1';
    case 'nascar':
      return 'nascar';
    default:
      return game.sport;
  }
}

/* ------------------------------------------------------------------ */
/* CBS Sports                                                          */
/* ------------------------------------------------------------------ */

interface CbsVideo {
  readonly id?: string;
  readonly title?: string;
  readonly displayTitle?: string;
  readonly type?: string;
  readonly network?: string;
  readonly networkFullName?: string;
  readonly playback?: string;
  readonly authentication?: readonly string[];
  readonly url?: string;
  readonly slug?: string;
  readonly category?: string;
  readonly startDate?: number;
  readonly is_live?: boolean;
  readonly is_active?: boolean;
  readonly game?: {
    readonly homeTeam?: { readonly mediumName?: string };
    readonly awayTeam?: { readonly mediumName?: string };
    readonly scheduledTimeEpoch?: number;
  } | null;
}

function cbsCandidates(text: string, page: string): DirectCandidate[] {
  const candidates: DirectCandidate[] = [];
  const seen = new Set<string>();

  const add = (candidate: DirectCandidate) => {
    const key = candidate.manifestUrl ?? candidate.pageUrl ?? '';
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  };

  // The page's own data: every video it offers, with the game it belongs to.
  const data = text.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (data?.[1]) {
    try {
      const parsed = JSON.parse(data[1]) as {
        props?: { pageProps?: { pageRowsData?: { videos?: CbsVideo[] }[] } };
      };
      const videos = (parsed.props?.pageProps?.pageRowsData ?? []).flatMap(
        (row) => row.videos ?? [],
      );
      for (const video of videos) {
        const label = video.networkFullName || video.network || 'CBS Sports';
        const home = video.game?.homeTeam?.mediumName;
        const away = video.game?.awayTeam?.mediumName;
        const startsAt = video.game?.scheduledTimeEpoch
          ? video.game.scheduledTimeEpoch * 1000
          : video.startDate
            ? video.startDate * 1000
            : undefined;

        if (video.url) {
          add({
            manifestUrl: video.url,
            referers: ['https://www.cbssports.com/', ''],
            carrierId: 'cbs',
            carrierLabel: 'CBS Sports',
            title: video.title || video.displayTitle || label,
            home,
            away,
            startsAt,
          });
          continue;
        }

        // A live game whose feed the page does not state: the carrier's own
        // watch page for that video carries it.
        if (video.type === 'live' && video.slug && video.category) {
          add({
            pageUrl: `https://www.cbssports.com/watch/${video.category}/${video.slug}`,
            referers: ['https://www.cbssports.com/', ''],
            carrierId: 'cbs',
            carrierLabel: 'CBS Sports',
            title: video.title || video.displayTitle || label,
            home,
            away,
            startsAt,
          });
        }
      }
    } catch {
      // A page whose data does not parse simply has no candidates.
    }
  }

  // The structured data of the same page: video objects with their feed.
  for (const block of text.matchAll(
    /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g,
  )) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1] ?? '');
    } catch {
      continue;
    }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    for (const item of items) {
      const record = item as {
        '@type'?: string;
        contentUrl?: string;
        name?: string;
        description?: string;
      };
      if (record['@type'] !== 'VideoObject' || !record.contentUrl) continue;
      add({
        manifestUrl: record.contentUrl,
        referers: ['https://www.cbssports.com/', ''],
        carrierId: 'cbs',
        carrierLabel: 'CBS Sports',
        title: record.name ?? 'CBS Sports',
      });
    }
  }

  return candidates;
}

const cbs: Carrier = {
  id: 'cbs',
  label: 'CBS Sports',
  networks: [
    'CBS',
    'CBS Sports',
    'CBS Sports Network',
    'CBSSN',
    'CBS Sports HQ',
    'CBS Sports Golazo Network',
    'CBS Sports Golazo',
    'UFA',
  ],
  pages: (game) => {
    const path = sportPath(game);
    const pages = [`https://www.cbssports.com/watch/${path}`];
    // Champions League and other European football is on CBS's own channel.
    if (game.sport === 'soccer') {
      pages.push('https://www.cbssports.com/watch/soccer');
      pages.push('https://www.cbssports.com/watch/uefa-champions-league-channel');
    }
    return pages;
  },
  extract: cbsCandidates,
};

/* ------------------------------------------------------------------ */
/* Fox Sports                                                          */
/* ------------------------------------------------------------------ */

const fox: Carrier = {
  id: 'fox',
  label: 'Fox Sports',
  networks: ['Fox', 'Fox Sports', 'Fox Sports 1', 'Fox Sports 2', 'FS1', 'FS2', 'FOX Sports'],
  pages: (game) => {
    const away = game.away?.name ?? '';
    const home = game.home?.name ?? '';
    const slug = away && home ? `${slugOf(away)}-at-${slugOf(home)}` : slugOf(game.title);
    return [`https://www.foxsports.com/${sportPath(game)}/${slug}-${game.espnEventId}/`];
  },
  extract: (text, page) =>
    manifestsIn(text).map((manifestUrl) => ({
      manifestUrl,
      referers: ['https://www.foxsports.com/', ''],
      carrierId: 'fox',
      carrierLabel: 'Fox Sports',
      title: 'Fox Sports',
    })),
};

/* ------------------------------------------------------------------ */
/* ESPN                                                                 */
/* ------------------------------------------------------------------ */

const espn: Carrier = {
  id: 'espn',
  label: 'ESPN',
  networks: ['ESPN', 'ESPN2', 'ESPN3', 'ESPNE', 'ESPN Deportes', 'ABC', 'ESPN App'],
  pages: (game) => [
    `https://www.espn.com/${game.sport}/game/_/gameId/${game.espnEventId}/`,
    'https://www.espn.com/watch/',
  ],
  extract: (text, page) =>
    manifestsIn(text).map((manifestUrl) => ({
      manifestUrl,
      referers: ['https://www.espn.com/', ''],
      carrierId: 'espn',
      carrierLabel: 'ESPN',
      title: 'ESPN',
    })),
};

/* ------------------------------------------------------------------ */
/* NBC Sports and USA Network                                          */
/* ------------------------------------------------------------------ */

const nbc: Carrier = {
  id: 'nbc',
  label: 'NBC Sports',
  networks: ['NBC', 'NBCSN', 'NBC Sports', 'NBC Sports Network', 'USA Network', 'USA Net', 'CNBC'],
  pages: (game) => {
    const away = game.away?.name ?? '';
    const home = game.home?.name ?? '';
    const slug = away && home ? `${slugOf(away)}-at-${slugOf(home)}` : slugOf(game.title);
    return [`https://www.nbcsports.com/${sportPath(game)}/${slug}-${game.espnEventId}`];
  },
  extract: (text) =>
    manifestsIn(text).map((manifestUrl) => ({
      manifestUrl,
      referers: ['https://www.nbcsports.com/', ''],
      carrierId: 'nbc',
      carrierLabel: 'NBC Sports',
      title: 'NBC Sports',
    })),
};

/* ------------------------------------------------------------------ */
/* The registry                                                        */
/* ------------------------------------------------------------------ */

const CARRIERS: readonly Carrier[] = [cbs, fox, espn, nbc];

/** Every carrier the app knows. */
export function allCarriers(): readonly Carrier[] {
  return CARRIERS;
}

/** The carriers that carry a game on the networks it names. */
export function carriersFor(networks: readonly string[]): Carrier[] {
  const wanted = new Set(networks.map((entry) => entry.trim().toLowerCase()));
  const found: Carrier[] = [];
  for (const carrier of CARRIERS) {
    if (carrier.networks.some((network) => wanted.has(network.toLowerCase()))) {
      found.push(carrier);
    }
  }
  return found;
}
