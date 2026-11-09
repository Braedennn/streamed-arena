// How the personal server reaches the media.
//
// The upstream is the app's business: the player never sees it. There are
// three kinds of upstream:
//
//   - a source the user brought themselves (see sources.ts) - then the app
//     depends on no third party at all
//   - the broadcaster's own feed, read from the broadcaster's own pages (see
//     lib/server/direct) - then the app depends on the broadcaster and on
//     nobody else
//   - the feed behind a match, resolved by the app and reached through one of
//     the provider's doors. The doors are ordered by how fresh they measured,
//     and the server moves to the next one when the current one stops
//     answering - which is what a dead mirror is handled by.

import { providerReferers } from '@/lib/server/provider';
import { resolveManifestUrl } from '@/lib/server/streamfree';
import type { ChannelUpstream, MediaChannel } from '@/lib/server/media/channels';
import { personalSourceFor } from '@/lib/server/media/sources';
import { strictMode } from '@/lib/server/mode';
import { resolveDirectSources } from '@/lib/server/direct/resolve';
import { sourceById } from '@/lib/server/sources/resolve';
import { refreshProviderFeed } from '@/lib/server/sources/providers';
import { forgetEmbed } from '@/lib/server/sources/providers/embed';
import { resolverForget } from '@/lib/server/resolver';

/** The doors the app knows, in the order it tries them when nothing is known. */
const BACKEND_ORDER = ['cdn', 'origin', 'mirror'] as const;

function referersFor(manifestUrl: string): string[] {
  try {
    return providerReferers(new URL(manifestUrl).hostname);
  } catch {
    return [''];
  }
}

export interface ResolveUpstreamsOptions {
  readonly streamKey: string;
  readonly slot: string;
  readonly quality: string;
  /** The doors to try first, best first ("<slot>-<quality>-<backend>"). */
  readonly preferredServerIds?: readonly string[];
}

/**
 * The ways the personal server can reach a feed.
 *
 * A source of the user's own comes first - when there is one, the provider is
 * never contacted at all.
 */
export async function resolveUpstreams(
  options: ResolveUpstreamsOptions,
): Promise<ChannelUpstream[]> {
  const upstreams: ChannelUpstream[] = [];

  const personal = await personalSourceFor(options.streamKey);
  const personalUpstream: ChannelUpstream | null = personal
    ? {
        serverId: 'personal',
        manifestUrl: personal.url,
        referers: personal.referer ? [personal.referer, ''] : [''],
        personal: true,
      }
    : null;

  // A source the user set for this one match stands alone: the provider is
  // not contacted for this match at all - not for its playlist, not for a
  // token, not for anything.
  if (personalUpstream && personal?.kind === 'match') {
    return [personalUpstream];
  }

  // A free channel: the app knows it by its own id, and the address of a
  // free channel does not change. The feed is looked up by that id - the
  // same one the channel was built with - so a channel that is rebuilt after
  // a restart comes back to the same channel.
  if (options.quality === 'src') {
    const source = await sourceById(options.streamKey, options.slot);
    if (source) {
      // A broadcaster's address changes - the app reads the new one instead
      // of giving up on the game. A free channel is addressed by one address
      // that stays the same, so there is nothing to refresh.
      const isDirect = source.candidate.providerId === 'direct';
      // A provider's address carries a token that expires, so it is read
      // again when the feed stops answering.
      const providerId = source.candidate.providerId.startsWith('api:')
        ? source.candidate.providerId.slice(4)
        : '';
      const eventId = source.candidate.eventId ?? '';
      // The page the address came from, when it came from one: a provider
      // that publishes only its own player gives the app a page, and the
      // page is what has to be opened again when the address stops
      // answering.
      const embedUrl = source.candidate.identity ?? '';
      upstreams.push({
        serverId: `source-${source.id}`,
        manifestUrl: source.candidate.manifestUrl,
        referers: source.candidate.referers,
        personal: false,
        fixed: !isDirect && !providerId,
        direct: isDirect,
        provider:
          providerId && eventId
            ? {
                providerId,
                eventId,
                // The quality the provider gave the feed, not the one it was
                // measured at: the provider is asked again for the same feed
                // when its address stops answering, and it knows its feeds by
                // their own names.
                quality: source.candidate.quality || source.quality,
                embedUrl: embedUrl || undefined,
              }
            : undefined,
      });
    }
    if (personalUpstream && personal?.kind === 'default') {
      upstreams.push(personalUpstream);
    }
    return upstreams;
  }

  // The app on its own: the feed comes from the broadcaster's own pages, and
  // the provider's doors are not touched at all.
  if (await strictMode()) {
    const direct = await resolveDirectSources(options.streamKey);
    const upstreams: ChannelUpstream[] = direct.sources.map((source, index) => ({
      serverId: `direct-${index}`,
      manifestUrl: source.manifestUrl,
      referers: source.referers,
      personal: false,
      direct: true,
    }));
    // A fallback of the user's own comes last: it takes over when the
    // broadcaster stops answering.
    if (personalUpstream && personal?.kind === 'default') {
      upstreams.push(personalUpstream);
    }
    return upstreams;
  }

  const preferred =
    options.preferredServerIds && options.preferredServerIds.length > 0
      ? options.preferredServerIds
      : BACKEND_ORDER.map((backend) => `${options.slot}-${options.quality}-${backend}`);

  for (const serverId of preferred) {
    const manifestUrl = await resolveManifestUrl(options.streamKey, serverId);
    if (!manifestUrl) continue;
    upstreams.push({
      serverId,
      manifestUrl,
      referers: referersFor(manifestUrl),
      personal: false,
    });
  }

  // A fallback of the user's own comes last: it takes over when the
  // provider's doors stop answering.
  if (personalUpstream && personal?.kind === 'default') {
    upstreams.push(personalUpstream);
  }

  return upstreams;
}

/**
 * A fresh copy of the upstream the channel is using.
 *
 * The provider hands out a rotating token, so a URL that worked a minute ago
 * can stop working. When the fetch fails, the server asks for a new one
 * instead of giving up on the feed.
 */
export async function refreshUpstream(channel: MediaChannel): Promise<ChannelUpstream | null> {
  const current = channel.upstreams[channel.upstreamIndex];
  if (!current) return null;

  // The address of a free channel does not change: there is nothing to
  // refresh, and asking again would only cost a request.
  if (current.fixed) return current;

  if (current.personal) {
    const personal = await personalSourceFor(channel.streamKey);
    if (!personal) return null;
    const refreshed: ChannelUpstream = {
      ...current,
      manifestUrl: personal.url,
      referers: personal.referer ? [personal.referer, ''] : [''],
    };
    channel.upstreams[channel.upstreamIndex] = refreshed;
    return refreshed;
  }

  // A feed of the broadcaster's own: its address changes, so the app reads
  // the new one instead of giving up on the game.
  if (current.direct) {
    const direct = await resolveDirectSources(channel.streamKey);
    const index = current.serverId.startsWith('direct-')
      ? Number(current.serverId.slice('direct-'.length))
      : Number.NaN;
    const source =
      direct.sources[index] ??
      direct.sources.find((entry) => entry.quality === channel.quality) ??
      direct.sources[0];
    if (!source) return null;
    const refreshed: ChannelUpstream = {
      ...current,
      manifestUrl: source.manifestUrl,
      referers: source.referers,
    };
    channel.upstreams[channel.upstreamIndex] = refreshed;
    return refreshed;
  }

  // A feed of a provider's API: the address carries a token, and the token
  // expires. The provider is asked for the match again, and the new address
  // is used from then on.
  //
  // A feed that came from a page is a little different: the page is what
  // hands out the address, so the page is asked again - not the provider,
  // and not with the address the app already has.
  if (current.provider) {
    const embedUrl = current.provider.embedUrl ?? '';
    if (embedUrl) {
      forgetEmbed(embedUrl);
      await resolverForget(embedUrl);
    }
    const manifestUrl = await refreshProviderFeed(
      current.provider.providerId,
      current.provider.eventId,
      current.provider.quality,
      embedUrl || undefined,
    );
    if (!manifestUrl) return null;
    const refreshed: ChannelUpstream = { ...current, manifestUrl };
    channel.upstreams[channel.upstreamIndex] = refreshed;
    return refreshed;
  }

  const manifestUrl = await resolveManifestUrl(channel.streamKey, current.serverId);
  if (!manifestUrl) return null;
  const refreshed: ChannelUpstream = {
    ...current,
    manifestUrl,
    referers: referersFor(manifestUrl),
  };
  channel.upstreams[channel.upstreamIndex] = refreshed;
  return refreshed;
}

/**
 * Moves the channel on to the next door, when there is one.
 *
 * A door that turned out to be an advertisement is not tried again: the
 * channel remembers it and moves past it, so the advert is never served a
 * second time.
 */
export function rotateUpstream(channel: MediaChannel): boolean {
  if (channel.upstreams.length <= 1) return false;
  const total = channel.upstreams.length;
  for (let step = 1; step <= total; step += 1) {
    const index = (channel.upstreamIndex + step) % total;
    const upstream = channel.upstreams[index];
    if (!upstream) continue;
    if (channel.rejected.has(upstream.serverId)) continue;
    channel.upstreamIndex = index;
    return true;
  }
  return false;
}
