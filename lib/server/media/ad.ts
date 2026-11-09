// Is this feed the game?
//
// A provider that wants to be paid does not answer with an error: it answers
// with a picture. The playlist is fine, the segment downloads, the bytes are
// even a real MPEG-TS stream - it just shows an advertisement instead of the
// match, over and over.
//
// The app has to see through that, because a player cannot: the picture comes
// up, the sound comes up, and the user is watching an advert for an API.
//
// Three things give it away, and all three are checked here:
//   - the playlist says it is a recording ("VOD", or an end list): a live
//     match does not end like that
//   - the playlist repeats one segment: that is a loop of one picture
//   - the segments come from the provider's own advertisement path
//
// Nothing here guesses: a feed that is merely quiet or slow is left alone.

/** The addresses a playlist names, in the order it names them. */
export function segmentUris(body: string): string[] {
  const uris: string[] = [];
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    uris.push(line);
  }
  return uris;
}

/**
 * Why this playlist is not the live match - empty when it may be.
 *
 * The reasons are the app's own words: they end up in the server list and in
 * the log, and they say what was seen rather than what was guessed.
 */
export function advertisementReason(body: string, baseUrl = ''): string {
  if (body.includes('#EXT-X-ENDLIST')) {
    return 'the feed has ended - it is a recording, not the match';
  }
  if (/#EXT-X-PLAYLIST-TYPE\s*:\s*VOD/i.test(body)) {
    return 'the feed is a recording, not the match';
  }

  const uris = segmentUris(body);
  if (uris.length >= 3) {
    const first = uris[0];
    const allTheSame = uris.every((uri) => uri === first);
    if (allTheSame && !body.includes('#EXT-X-PROGRAM-DATE-TIME')) {
      return 'the feed repeats one segment - it is a loop, not the match';
    }
  }

  // The provider's own advertisement path. The name is not the point: a
  // segment that comes from a path named after the advertisement is not the
  // match, whatever is in it.
  for (const uri of uris) {
    let path = uri;
    try {
      path = new URL(uri, baseUrl).pathname;
    } catch {
      path = uri;
    }
    if (/\/(?:troll|ad|ads|advert|advertisement|promo|promo-?slot)\//i.test(path)) {
      return 'the provider is serving an advertisement instead of the match';
    }
  }

  return '';
}

/** True when the playlist may be the live match. */
export function looksLive(body: string, baseUrl = ''): boolean {
  return advertisementReason(body, baseUrl) === '';
}
