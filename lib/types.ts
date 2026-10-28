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
