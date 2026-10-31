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
 * A health-checked direct stream server.
 *
 * StreamFree's API only advertises two embed pages per match, but the embeds
 * themselves expose a delivery matrix (qualities x source slots x media
 * backends). The app resolves that matrix server-side, probes every candidate
 * and keeps only the ones that answer — so a "server" listed here is alive,
 * measured and known to be close to the live edge.
 */
export interface ServerCandidate {
  readonly id: string;
  /** Source slot as published by the API ("1" / "2"). */
  readonly slot: string;
  readonly slotLabel: string;
  readonly quality: string;
  /** 'host' = the match is hosted on a third-party site the provider points at. */
  readonly backend: 'cdn' | 'mirror' | 'origin' | 'host';
  readonly backendLabel: string;
  /** Same-origin proxy URL the renderer can play. */
  readonly proxyUrl: string;
  readonly latencyMs: number;
  /** Seconds between the newest segment and now — the real live-edge lag. */
  readonly edgeAgeSeconds: number;
  readonly mediaSequence: number;
  readonly score: number;
  readonly label: string;
  /** True when this entry is the last known good pool, kept through an outage. */
  readonly stale?: boolean;
}
