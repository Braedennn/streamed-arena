// The schedule of the mirror, read by the app itself.
//
// DaddyLive publishes every event of the day on its own pages - "all soccer
// events", "college football", "NBA" and so on - together with the channels
// that carry each one. Those pages are plain documents: no frames, no scripts
// and no cloud door in front of them. The app reads them the way a visitor
// would, and keeps the last good answer for a short while.
//
// The pages name hours by the site's own clock; the app does not need those
// hours to be exact. A match is found by the names of its teams - the time
// only orders what is on.

import { providerText } from '@/lib/server/sources/providers/http';

const SITE = 'https://thedaddy.li';

/** One category of the mirror's schedule, as the site links it. */
export interface MirrorCategory {
  /** The category name, as a visitor reads it ("NBA 🏀"). */
  readonly name: string;
  /** The query the site's own link carries, kept as it was written. */
  readonly query: string;
}

/** The user-facing browser the scraper reads the pages as. */
export const READER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

/** The categories the app keeps its eye on, by the shape of their names. */
const CATEGORY_PATTERNS: readonly RegExp[] = [
  /^All Soccer Events/,
  /College Football/,
  /Am\. Football/,
  /^NBA /,
  /College Basketball/,
  /NHL Ice Hockey/,
  /MMA/,
  /^Boxing/,
];

/** One channel of a mirror event. */
export interface MirrorChannel {
  /** The watch page id ("/watch.php?id=<id>"). */
  readonly id: string;
  /** The channel's name ("TNT Sports 1 UK"). */
  readonly name: string;
}

/** One event of the mirror's board. */
export interface MirrorEvent {
  /** A stable id, built from the channels of the event. */
  readonly id: string;
  /** The names of the two teams, as the mirror spells them. */
  readonly teams: readonly string[];
  /** How the mirror writes the whole line ("australia - a-league"). */
  readonly league: string;
  /** The category the event was found under ("NBA 🏀"). */
  readonly category: string;
  /** The channels that carry the event. */
  readonly channels: readonly MirrorChannel[];
  /** The hour the mirror says, as a unix minute of the day (when given). */
  readonly minuteOfDay: number | null;
}

const SCHEDULE_TTL_MS = 90_000;
const CATEGORY_TTL_MS = 10 * 60_000;

const scheduleCache = new Map<string, { at: number; events: MirrorEvent[] }>();
let categoriesAt = 0;
let categoryList: readonly MirrorCategory[] = [];

/** The read of a page, as a visitor's browser sends it. */
function readPage(url: string, timeoutMs: number): Promise<string | null> {
  return providerText(url, {
    timeoutMs,
    headers: {
      'user-agent': READER_UA,
      'accept-language': 'en-US,en;q=0.9',
      // The pages shrink tenfold on the way, and only a reader that asks
      // like a browser receives the signs as they were written.
      'accept-encoding': 'gzip',
    },
  });
}

/**
 * The categories of today's schedule.
 *
 * The site's list changes with the season and the day, so the names are
 * re-read now and then and matched against the shapes the app cares about.
 * The query a link carries is kept exactly as the site wrote it - the names
 * carry flags and signs that must not pass through a decode and an encode
 * again on the way back.
 */
async function categories(): Promise<readonly MirrorCategory[]> {
  if (Date.now() - categoriesAt < CATEGORY_TTL_MS) return categoryList;
  const home = await readPage(`${SITE}/`, 12_000);
  if (!home) {
    // An old list is better than an empty one.
    categoriesAt = Date.now() - (CATEGORY_TTL_MS - 30_000);
    return categoryList;
  }
  const found = new Map<string, string>();
  for (const m of home.matchAll(/index\.php\?cat=([^"']+)"/g)) {
    const query = m[1] ?? '';
    if (!query) continue;
    let name = query;
    try {
      name = decodeURIComponent(query).replace(/\+/g, ' ').trim();
    } catch {
      name = query.replace(/\+/g, ' ').trim();
    }
    if (CATEGORY_PATTERNS.some((pattern) => pattern.test(name))) found.set(query, name);
  }
  categoriesAt = Date.now();
  // A discovery miss keeps the old list; an empty one starts with the
  // category that is always there.
  if (found.size > 0) {
    categoryList = [...found].map(([query, name]) => ({ query, name }));
  } else if (categoryList.length === 0) {
    categoryList = [{ name: 'All Soccer Events ⚽', query: 'All+Soccer+Events+%E2%9A%BD' }];
  }
  return categoryList;
}

/** Strips the emoji, the flag signs and the doubled spaces a name carries. */
function cleanName(raw: string): string {
  return raw
    // A flag is a pair of regional indicator signs.
    .replace(/[\u{1F1E6}-\u{1F1FF}]{2}/gu, '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/&#(?:0?39|0?020|#x27);?/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The two teams of a mirror line, without the league and the time.
 *
 * The line reads "⚽ australia - a-league : auckland vs wellington phoenix 04:00";
 * the league is everything before the last " : ", the time is the tail.
 */
function lineParts(raw: string): { league: string; teams: string; minute: number | null } {
  const text = cleanName(raw);
  const colon = text.lastIndexOf(' : ');
  const league = colon >= 0 ? text.slice(0, colon).trim() : '';
  let tail = colon >= 0 ? text.slice(colon + 3).trim() : text;
  const time = tail.match(/(\d{1,2}):(\d{2})\s*$/);
  let minute: number | null = null;
  if (time) {
    minute = Number(time[1]) * 60 + Number(time[2]);
    tail = tail.slice(0, time.index).trim();
  }
  return { league, teams: tail, minute };
}

/**
 * One schedule page, read and remembered.
 *
 * A category's events arrive as server-rendered blocks: a line for the event
 * and, under it, every channel that carries it.
 */
export async function mirrorEventsByCategory(category: MirrorCategory): Promise<readonly MirrorEvent[]> {
  const cached = scheduleCache.get(category.query);
  if (cached && Date.now() - cached.at < SCHEDULE_TTL_MS) return cached.events;

  const events: MirrorEvent[] = [];
  const page = await readPage(`${SITE}/index.php?cat=${category.query}`, 15_000);

  if (page) {
    const blocks = [...page.matchAll(/<div class="schedule__event">([\s\S]*?)<\/div>\s*<\/div>/g)];
    for (const block of blocks) {
      const body = block[1] ?? '';
      const title = body.match(/data-title="([^"]*)"/)?.[1];
      if (!title) continue;
      const channels = [...body.matchAll(/watch\.php\?id=(\d+)[^>]*?title="([^"]*)"/g)]
        .map((m) => ({ id: m[1] ?? '', name: cleanName(m[2] ?? '') }))
        .filter((channel) => channel.name.length > 0 && channel.id.length > 0);
      if (channels.length === 0) continue;
      const parts = lineParts(title);
      const teams = parts.teams.split(/\s+vs\.?\s+/i).filter(Boolean);
      if (teams.length !== 2) continue;
      events.push({
        // The ids of the channels name the event again and again: the same
        // event on the next read of the schedule gives the same id, which
        // is what the feed refresh looks for. The id stays inside the key
        // alphabet every route accepts - no colons, no flags.
        id: `daddylive-${[...channels].map((channel) => channel.id).sort().join('-')}`,
        league: parts.league,
        teams,
        category: category.name,
        channels,
        minuteOfDay: parts.minute,
      });
    }
  }

  if (events.length > 0) {
    scheduleCache.set(category.query, { at: Date.now(), events });
  } else if (cached) {
    // The site's pages go empty now and again; the old schedule still says
    // whose game it was.
    scheduleCache.set(category.query, { at: Date.now() - (SCHEDULE_TTL_MS - 20_000), events: cached.events });
    return cached.events;
  }
  return events;
}

/** The events of every category the app follows. */
export async function mirrorEvents(): Promise<readonly MirrorEvent[]> {
  const list = await categories();
  if (list.length === 0) return [];
  const pages = await Promise.all(list.map((category) => mirrorEventsByCategory(category).catch(() => [] as MirrorEvent[])));
  const seen = new Set<string>();
  const all: MirrorEvent[] = [];
  for (const page of pages.flat()) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    all.push(page);
  }
  return all;
}

/** The channels of an event, by the event's own id. */
export function mirrorEventChannels(eventId: string): readonly MirrorChannel[] | null {
  for (const entry of scheduleCache.values()) {
    const event = entry.events.find((candidate) => candidate.id === eventId);
    if (event) return event.channels;
  }
  return null;
}
