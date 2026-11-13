// How many feeds a match has.
//
// The board shows the number of feeds of every match that is on, and the
// number is found by asking the providers what they publish for that match.
// A list of feeds is read without measuring anything: no page is opened, no
// segment is fetched, nothing is played. That is what makes it cheap enough
// to do for every match on the board.
//
// The work happens in the background, one match at a time, so the board is
// never waiting for it: the board answers with the numbers it has, and the
// rest fill in as they are found.
//
// A match the user has opened is measured instead: the app fetches the media
// of that match anyway, and what it measured is the truth - so the board
// shows the measured number for it.

import { strictMode } from '@/lib/server/mode';
import { matchContext } from '@/lib/server/sources/resolve';
import { providerMatchesForMatch } from '@/lib/server/sources/providers';
import { teamsOfTitle } from '@/lib/server/sources/providers/names';
import type { ProviderMatch } from '@/lib/server/sources/providers';

export interface FeedCount {
  /** How many feeds there are. */
  readonly count: number;
  /** True when one of them is served in 720p or better. */
  readonly hd: boolean;
  /** When the number was taken. */
  readonly at: number;
  /** True when the number was measured rather than counted from a list. */
  readonly measured: boolean;
  /** False when the app could not look - it is on its own. */
  readonly known: boolean;
}

/** How long a number is used before it is looked up again. */
const COUNT_TTL_MS = 5 * 60_000;
/** How long the app waits between two matches it counts. */
const JOB_PAUSE_MS = 400;
/** How many matches may wait to be counted. */
const MAX_QUEUE = 64;
/** How many matches may be counted at the same time. */
const MAX_WORKERS = 3;
/** How long a count may take before the board stops waiting on it. */
const COUNT_DEADLINE_MS = 12_000;
/** How long the board waits before asking again for a number it does not have. */
const RETRY_AFTER_MS = 45_000;

const STORE_KEY = '__arena_feed_counts__';

interface Store {
  readonly counts: Map<string, FeedCount>;
  readonly queue: string[];
  readonly working: Set<string>;
  running: boolean;
}

function store(): Store {
  const global = globalThis as unknown as Record<string, unknown>;
  const existing = global[STORE_KEY];
  if (existing) return existing as Store;
  const created: Store = { counts: new Map(), queue: [], working: new Set(), running: false };
  global[STORE_KEY] = created;
  return created;
}

/**
 * Is a feed served in 720p or better?
 *
 * The providers name the quality in words ("HD", "SD") and in numbers
 * ("1080p", "540p"), so both are read.
 */
export function isHdQuality(quality: string): boolean {
  const text = quality.trim().toLowerCase();
  if (!text) return false;
  if (text === 'hd' || text === 'fhd' || text === 'uhd' || text === '4k') return true;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) && value >= 720;
}

/** What the app knows about the feeds of a match right now. */
export function feedCountOf(streamKey: string): FeedCount | undefined {
  const entry = store().counts.get(streamKey);
  if (!entry) return undefined;
  if (Date.now() - entry.at > COUNT_TTL_MS) {
    store().counts.delete(streamKey);
    return undefined;
  }
  if (process.env.ARENA_MEDIA_DEBUG === '1') {
    console.log(
      `[counts] read ${streamKey}: ${entry.count} feeds (known=${entry.known}, measured=${entry.measured}, age=${Date.now() - entry.at}ms)`,
    );
  }
  return entry;
}

/**
 * Writes down what the app measured.
 *
 * A measured number is the truth: the app fetched the media of that match
 * and counted the feeds that played. It is not overwritten by a number that
 * was only counted from a provider's list.
 *
 * One exception: a measurement that found nothing does not erase a number
 * the providers published. The providers still publish those feeds - the app
 * could not play them from this machine - and the board should not tell the
 * user that the match has none.
 */
export function noteFeedCount(streamKey: string, count: number, hd: boolean): void {
  const s = store();
  const existing = s.counts.get(streamKey);
  if (existing && existing.measured && Date.now() - existing.at < COUNT_TTL_MS) return;
  if (
    count === 0 &&
    existing &&
    existing.known &&
    existing.count > 0 &&
    Date.now() - existing.at < COUNT_TTL_MS
  ) {
    return;
  }
  s.counts.set(streamKey, { count, hd, at: Date.now(), measured: true, known: true });
}

/**
 * Asks for the number of feeds of a match.
 *
 * The number is found in the background: the board does not wait for it, and
 * the match is only counted once.
 */
export function requestFeedCount(streamKey: string): void {
  if (!streamKey) return;
  const s = store();
  const existing = s.counts.get(streamKey);
  if (existing) {
    const age = Date.now() - existing.at;
    // A number that is known is used for a while; a number the app could not
    // find is asked for again, but not on every poll of the board.
    if (existing.known && age < COUNT_TTL_MS) return;
    if (!existing.known && age < RETRY_AFTER_MS) return;
  }
  if (s.working.has(streamKey)) return;
  if (s.queue.includes(streamKey)) return;
  s.queue.push(streamKey);
  while (s.queue.length > MAX_QUEUE) s.queue.shift();
  void pump();
}

/** Counts the matches that are waiting, a few at a time. */
async function pump(): Promise<void> {
  const s = store();
  if (s.running) return;
  s.running = true;
  try {
    for (;;) {
      const key = s.queue.shift();
      if (!key) break;
      const work = countOne(key);
      s.working.add(key);
      void work
        .catch(() => undefined)
        .finally(() => {
          s.working.delete(key);
        });
      // The workers do the work; the pump only keeps a few of them busy and
      // takes the next match when there is room for it.
      while (s.working.size >= MAX_WORKERS) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await new Promise((resolve) => setTimeout(resolve, JOB_PAUSE_MS));
    }
  } finally {
    s.running = false;
  }
}

/**
 * Writes down a number that was counted.
 *
 * A number that was measured - the app fetched the media of that match and
 * counted the feeds that really played - is the truth about it, and a number
 * that was only read from a provider's list does not take its place.
 */
function writeCount(s: Store, streamKey: string, count: FeedCount): void {
  const existing = s.counts.get(streamKey);
  if (existing && existing.measured && Date.now() - existing.at < COUNT_TTL_MS) return;
  s.counts.set(streamKey, count);
}

/**
 * Counts one match and writes down what it found.
 *
 * The count has a deadline, because the board is waiting for the number: a
 * provider that takes its time must not hold the board up. The work is not
 * thrown away when the deadline passes - it is left to finish and write down
 * its answer, so a slow provider still gets its number onto the board a
 * moment later.
 */
async function countOne(streamKey: string): Promise<void> {
  const s = store();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), COUNT_DEADLINE_MS);
  });
  const work = lookForFeeds(streamKey);
  try {
    const outcome = await Promise.race([work, deadline]);
    if (outcome === 'deadline') {
      // The work goes on in the background and writes its answer down when it
      // has one.
      void work
        .then((count) => {
          if (count.known) writeCount(s, streamKey, count);
        })
        .catch(() => undefined);
      return;
    }
    writeCount(s, streamKey, outcome);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The feeds the providers publish for a match.
 *
 * Every provider that knows the match is asked what it publishes for it. The
 * answer is the provider's own list: no page is opened, no token is minted,
 * no segment is fetched. That is what makes it cheap enough to do for every
 * match on the board.
 */
async function lookForFeeds(streamKey: string): Promise<FeedCount> {
  try {
    // The app on its own asks nobody but the carrier, and the carrier's own
    // pages are read when the match is opened. There is nothing to count
    // here, and the board says "looking" rather than a number it cannot
    // stand behind.
    if (await strictMode()) {
      return { count: 0, hd: false, at: Date.now(), measured: false, known: false };
    }

    const { game, providerName } = await matchContext(streamKey, true);
    const teams: [string, string] = game
      ? [game.home?.name ?? '', game.away?.name ?? '']
      : teamsOfTitle(providerName);
    const matches = await providerMatchesForMatch(streamKey, providerName, teams);
    if (process.env.ARENA_MEDIA_DEBUG === '1') {
      console.log(
        `[counts] ${streamKey}: game=${game?.id ?? '(none)'} provider=${providerName || '(none)'} teams=${teams.join(' vs ')} matches=${matches
          .map((match) => `${match.api.id}:${match.event.id}`)
          .join(',')}`,
      );
    }

    const lists = await Promise.all(
      matches.map(async (match) => {
        try {
          return await publishedFeedsOf(match);
        } catch {
          // A provider that does not answer has no feeds to count.
          return [];
        }
      }),
    );

    if (process.env.ARENA_MEDIA_DEBUG === '1') {
      console.log(
        `[counts] ${streamKey}: listed ${lists.reduce((total, list) => total + list.length, 0)} feeds`,
      );
    }

    let count = 0;
    let hd = false;
    const seen = new Set<string>();
    for (const list of lists) {
      for (const feed of list) {
        const key = `${feed.providerId}|${feed.key}`;
        if (seen.has(key)) continue;
        seen.add(key);
        count += 1;
        if (isHdQuality(feed.quality)) hd = true;
      }
    }

    return { count, hd, at: Date.now(), measured: false, known: true };
  } catch (error) {
    // The app could not look. The board says "looking" and asks again later.
    if (process.env.ARENA_MEDIA_DEBUG === '1') {
      console.log(
        `[counts] ${streamKey}: the count failed - ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return { count: 0, hd: false, at: Date.now(), measured: false, known: false };
  }
}

/** What one provider publishes for a match, with the provider's own name. */
async function publishedFeedsOf(
  match: ProviderMatch,
): Promise<readonly { providerId: string; key: string; quality: string }[]> {
  const published = match.api.publishedFeeds
    ? await match.api.publishedFeeds(match.event)
    : await match.api.feeds(match.event).then((feeds) =>
        feeds.map((feed) => ({
          key: feed.manifestUrl ?? feed.playerUrl ?? '',
          quality: feed.quality,
        })),
      );
  return published
    .filter((feed) => Boolean(feed.key))
    .map((feed) => ({ providerId: match.api.id, key: feed.key, quality: feed.quality }));
}
