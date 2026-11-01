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
  readonly poster?: string | null;
  readonly popular?: boolean;
  /** Match-level viewer count — every quality variant shares one counter. */
  readonly viewers?: number;
  readonly teams?: {
    readonly home?: Team | null;
    readonly away?: Team | null;
  } | null;
  readonly sources: readonly MatchSource[];
}

export interface StreamDto {
  readonly id: string;
  readonly streamNo: number;
  readonly language: string;
  readonly hd: boolean;
  readonly embedUrl: string;
  readonly source: string;
  readonly viewers?: number;
}

export type MatchStatus = 'live' | 'in-play' | 'upcoming' | 'ended';

export interface Fixture extends ApiMatch {
  readonly status: MatchStatus;
  readonly home: Team | null;
  readonly away: Team | null;
}

export interface ResolvedStream extends StreamDto {
  readonly key: string;
}

export interface StreamGroup {
  readonly source: string;
  readonly streams: readonly StreamDto[];
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
  /** Same-origin proxy URL the renderer can play. */
  readonly proxyUrl: string;
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
