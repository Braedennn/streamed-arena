// The provider APIs the app knows.
//
// A provider API is a service that publishes live sports feeds over an API of
// its own - the same kind of service the app has always read, but reached the
// way its own documentation says: a list of what is on, and the feeds of one
// event.
//
// Every provider is asked the same two questions, and every answer is
// measured the same way, so the sharpest feed wins - not the service that
// happened to answer first.
//
// Two kinds of feed come out of a provider:
//   - a playlist: the app fetches it itself, keeps it on disk and serves it
//     from its own server
//   - the provider's own player: some providers hand out nothing but their
//     player, and the app shows that rather than pretending it has no feed

/** One event of a provider's board. */
export interface ProviderEvent {
  /** The provider's own id for the event. */
  readonly id: string;
  /** The name the provider gives the match. */
  readonly title: string;
  /** The sport, as the provider names it ("Football", "Basketball"). */
  readonly sport: string;
  /** The competition, when the provider names one. */
  readonly league: string;
  /** The network the provider says carries it ("Paramount+", "Sky Sport 8"). */
  readonly network: string;
  /** Unix seconds. */
  readonly startsAt: number;
  readonly endsAt: number;
  /** True when the provider says the event is on now. */
  readonly live: boolean;
  /** The two teams, when the title names them. */
  readonly teams: readonly [string, string];
}

/** One feed of an event. */
export interface ProviderFeed {
  readonly eventId: string;
  /** The quality the provider names ("1080p", "540p"). */
  readonly quality: string;
  /** The name of the feed, for the server list. */
  readonly title: string;
  /** The playlist the app can fetch itself. */
  readonly manifestUrl: string | null;
  /** The provider's own player, when it hands out nothing else. */
  readonly playerUrl: string | null;
  /** The referers to try, best first. */
  readonly referers: readonly string[];
  /**
   * The page the feed was published on, when it was published on one.
   *
   * Some providers publish nothing but their own player. The app opens that
   * page and takes the playlist out of it, so the page's address is what the
   * feed is known by - the playlist it leads to carries a token that changes,
   * and a feed that changed its name would restart the player watching it.
   */
  readonly embedUrl?: string;
}

/**
 * One feed a provider publishes, known without opening a page.
 *
 * The board wants to say how many feeds a match has. Asking the provider for
 * its list is enough for that - no page is opened, no token is minted, no
 * segment is fetched. The key is the provider's own name for the door, so the
 * same door is counted once.
 */
export interface PublishedFeed {
  /** The provider's own id for the door. */
  readonly key: string;
  /** The quality the provider names ("1080p", "HD"). */
  readonly quality: string;
}

export interface ProviderApi {
  /** The id the app knows the provider by ("ppv", "strmfree"). */
  readonly id: string;
  /** The name the player sees ("PPV", "StreamFree"). */
  readonly label: string;
  /** What is on right now. */
  events(): Promise<ProviderEvent[]>;
  /** The feeds of one event. */
  feeds(event: ProviderEvent): Promise<ProviderFeed[]>;
  /**
   * What the provider publishes for one event, read from its list.
   *
   * This is the cheap way to count: the provider's own answer names the
   * doors it carries, and nothing is opened, minted or fetched to hear it.
   */
  publishedFeeds?(event: ProviderEvent): Promise<PublishedFeed[]>;
}
