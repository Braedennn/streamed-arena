export interface Sport {
  readonly id: string;
  readonly name: string;
}

export interface Team {
  readonly name: string;
  readonly badge: string;
}

export interface MatchSource {
  readonly source: string;
  readonly id: string;
}

export interface ApiMatch {
  readonly id: string;
  readonly title: string;
  readonly category: string;
  readonly date: number;
  /**
   * Whether the fixture has a picture.
   *
   * The address of that picture is not sent to the page: the app's own server
   * knows where it is, and the page only asks whether there is one.
   */
  readonly hasPoster?: boolean;
  readonly popular?: boolean;
  /** Match-level viewer count — every quality variant shares one counter. */
  readonly viewers?: number;
  readonly teams?: {
    readonly home?: Team | null;
    readonly away?: Team | null;
  } | null;
  readonly sources: readonly MatchSource[];
}

/**
 * What the app knows about one feed of a match.
 *
 * The page counts feeds and asks whether one of them is in HD - nothing
 * more. The addresses behind a feed are the app's business: the app's own
 * server fetches the media and publishes a playlist of its own, and the
 * provider's doors never reach the page.
 */
export interface StreamDto {
  /** A stable name for the variant ("1080p", "540p2", ...). */
  readonly id: string;
  /** True for 720p and better. */
  readonly hd: boolean;
  /** The match's viewer count - shared by every variant. */
  readonly viewers?: number;
}

export type MatchStatus = 'live' | 'in-play' | 'upcoming' | 'ended';

export interface Fixture extends ApiMatch {
  readonly status: MatchStatus;
  readonly home: Team | null;
  readonly away: Team | null;
}

/**
 * A server the app can play from.
 *
 * The app hosts these itself: a "personal server" is one feed the app's own
 * server is serving - it fetches the media, keeps it and publishes a
 * playlist of its own. The player only ever talks to the app.
 */
export interface ServerCandidate {
  readonly id: string;
  /** Source slot as published by the API ("1" / "2"). */
  readonly slot: string;
  readonly slotLabel: string;
  readonly quality: string;
  /** 'personal' = hosted by the app itself. */
  readonly backend: 'cdn' | 'mirror' | 'origin' | 'host' | 'personal';
  readonly backendLabel: string;
  /**
   * The service the feed came from ("Pluto TV", "Free TV index", "CBS
   * Sports") - the app is the host, but it says where the bytes come from.
   */
  readonly source?: string;
  /** Same-origin proxy URL the renderer can play. */
  readonly proxyUrl: string;
  /**
   * The provider's own player, when the provider hands out nothing else.
   *
   * Some providers publish the match inside their own page rather than as a
   * playlist. The app shows that page when the player picks such a feed -
   * there is nothing for the app to host in that case.
   */
  readonly playerUrl?: string;
  readonly latencyMs: number;
  /** Seconds between the newest segment and now — the real live-edge lag. */
  readonly edgeAgeSeconds: number;
  readonly mediaSequence: number;
  readonly score: number;
  readonly label: string;
  /**
   * Where the server lives - "127.0.0.1:3899" in the desktop app.
   *
   * A personal server runs on the machine the app runs on, so the address is
   * shown: the list says where the stream is being served from, not just that
   * it is being served.
   */
  readonly localHost?: string;
  /** True when this entry is the last known good pool, kept through an outage. */
  readonly stale?: boolean;
  /** Whether the personal server is warming up, serving, or in trouble. */
  readonly state?: 'warming' | 'ready' | 'error';
}
