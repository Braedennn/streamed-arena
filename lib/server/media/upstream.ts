// How the personal server reaches the media.
//
// The upstream is the app's business: the player never sees it. There are two
// kinds of upstream:
//
//   - a source the user brought themselves (see sources.ts) - then the app
//     depends on no third party at all
//   - the feed behind a match, resolved by the app and reached through one of
//     the provider's doors. The doors are ordered by how fresh they measured,
//     and the server moves to the next one when the current one stops
//     answering - which is what a dead mirror is handled by.

import { providerReferers } from '@/lib/server/provider';
import { resolveManifestUrl } from '@/lib/server/streamfree';
import type { ChannelUpstream, MediaChannel } from '@/lib/server/media/channels';
import { personalSourceFor } from '@/lib/server/media/sources';

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

/** Moves the channel on to the next door, when there is one. */
export function rotateUpstream(channel: MediaChannel): boolean {
  if (channel.upstreams.length <= 1) return false;
  channel.upstreamIndex = (channel.upstreamIndex + 1) % channel.upstreams.length;
  return true;
}
