// The provider's list of embed pages changed shape under us.
//
// It used to send plain URL strings:
//
//   "sources": ["https://strmfree.st/embed/soccer/foo1080p"]
//
// and now sends objects that also carry the quality label:
//
//   "sources": [{ "quality": "FHD", "url": "https://strmfree.st/embed/soccer/foo1080p" }]
//
// A filter that keeps only strings therefore empties the list *silently* -
// the app then believes the match has no pages at all and reports that the
// feed "has not started yet" while the provider is happily streaming it.
//
// Both shapes are accepted here, so a format change on the provider's side
// cannot empty the lists again.

export interface SourceEntry {
  /** The provider's own label for the page ("FHD", "SD", ...). */
  readonly quality: string;
  readonly url: string;
}

/** Reads the provider's source list, whatever shape it arrives in. */
export function sourceEntries(value: unknown): SourceEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: SourceEntry[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry) entries.push({ quality: '', url: entry });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const record = entry as { quality?: unknown; url?: unknown };
      const url = typeof record.url === 'string' ? record.url : '';
      if (!url) continue;
      entries.push({
        quality: typeof record.quality === 'string' ? record.quality : '',
        url,
      });
    }
  }
  return entries;
}

/** Just the URLs of the provider's source list. */
export function sourceUrls(value: unknown): string[] {
  return sourceEntries(value).map((entry) => entry.url);
}
