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
//
// A match is not one door but many. Every provider that knows the match
// publishes its own feed of it, and the broadcaster's own pages carry it as
// well - so the app scrapes all of them, keeps them as the doors of one
// channel, and moves to the next door by itself when the one it is reading
// stops answering. A feed that dies in the middle of a game is a cut, not
// the end of the game.

import { providerReferers } from '@/lib/server/provider';
import { resolveManifestUrl, resolveServers, type ResolvedServer } from '@/lib/server/streamfree';
import {
  currentUpstream,
  MATCH_SLOT,
  newGeneration,
  replaceUpstream,
  type ChannelUpstream,
  type MediaChannel,
} from '@/lib/server/media/channels';
import { personalSourceFor } from '@/lib/server/media/sources';
import { strictMode } from '@/lib/server/mode';
import { resolveDirectSources } from '@/lib/server/direct/resolve';
import {
  invalidateMatchSources,
  resolveMatchSources,
  sourceById,
  type ResolvedSource,
} from '@/lib/server/sources/resolve';
import { refreshProviderFeed } from '@/lib/server/sources/providers';
import { forgetEmbed } from '@/lib/server/sources/providers/embed';
import { resolverForget } from '@/lib/server/resolver';

/** The doors the app knows, in the order it tries them when nothing is known. */
const BACKEND_ORDER = ['cdn', 'origin', 'mirror'] as const;

/**
 * How long the app waits before it looks the match up again.
 *
 * The lookup asks every provider for its feeds and measures them, so it is
 * not something to do on every cycle - but a match whose feeds are all dead
 * has to be looked up again by itself, without the user doing anything.
 */
const RESCUE_INTERVAL_MS = 10_000;

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
 * One feed of a match, as a door the personal server can open.
 *
 * The door carries what it takes to find the feed again: the provider it
 * came from and the match it belongs to, so the provider can be asked for a
 * fresh address when this one stops answering.
 */
export function upstreamOf(source: ResolvedSource): ChannelUpstream | null {
  const candidate = source.candidate;
  if (!candidate.manifestUrl) return null;

  const isDirect = candidate.providerId === 'direct';
  const providerId = candidate.providerId.startsWith('api:')
    ? candidate.providerId.slice(4)
    : '';
  const eventId = candidate.eventId ?? '';

  return {
    serverId: `source-${source.id}`,
    manifestUrl: candidate.manifestUrl,
    referers: candidate.referers,
    personal: false,
    // A free channel is addressed by one address that does not change.
    // A broadcaster's address does change - the app reads the new one
    // instead of giving up on the game. A provider's address carries a
    // token, so it is read again when the feed stops answering.
    fixed: !isDirect && !providerId,
    direct: isDirect,
    quality: source.quality,
    label: candidate.title,
    providerLabel: candidate.providerLabel,
    provider:
      providerId && eventId
        ? {
            providerId,
            eventId,
            // The quality the provider gave the feed, not the one it was
            // measured at: the provider is asked again for the same feed
            // when its address stops answering, and it knows its feeds by
            // their own names.
            quality: candidate.quality || source.quality,
            embedUrl: candidate.identity,
          }
        : undefined,
  };
}

/**
 * The provider's own doors of a feed, as doors the channel can open.
 *
 * These are the same files on the same machines: the CDN, the origin and the
 * mirror of one feed. They are kept as doors of the match's channel, so the
 * app has a way in even when the address the provider's API handed out is
 * gone.
 */
export function upstreamOfServer(server: ResolvedServer): ChannelUpstream {
  return {
    serverId: server.id,
    manifestUrl: server.manifestUrl,
    referers: referersFor(server.manifestUrl),
    personal: false,
    quality: server.quality,
    label: server.label,
    providerLabel: server.backendLabel,
  };
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

  // The match's own channel: every feed the app can find for this match, the
  // best measured one first. The rest are the way out when the best one
  // stops answering in the middle of the game.
  if (options.slot === MATCH_SLOT) {
    // Two lists, asked at the same time: the provider's own doors of the
    // feed (the CDN, the origin, the mirror) and the feeds every provider
    // publishes for this match. They are all doors to the same game.
    const [pool, resolution] = await Promise.all([
      resolveServers(options.streamKey).catch(() => null),
      resolveMatchSources(options.streamKey),
    ]);
    for (const server of pool?.servers ?? []) {
      upstreams.push(upstreamOfServer(server));
    }
    for (const source of resolution.sources) {
      const upstream = upstreamOf(source);
      if (upstream) upstreams.push(upstream);
    }
    // A fallback of the user's own comes last: it takes over when every
    // door of the providers stops answering.
    if (personalUpstream && personal?.kind === 'default') {
      upstreams.push(personalUpstream);
    }
    return upstreams;
  }

  // A free channel: the app knows it by its own id, and the address of a
  // free channel does not change. The feed is looked up by that id - the
  // same one the channel was built with - so a channel that is rebuilt after
  // a restart comes back to the same channel.
  if (options.quality === 'src') {
    const source = await sourceById(options.streamKey, options.slot);
    if (source) {
      const upstream = upstreamOf(source);
      if (upstream) upstreams.push(upstream);
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
    const directUpstreams: ChannelUpstream[] = direct.sources.map((source, index) => ({
      serverId: `direct-${index}`,
      manifestUrl: source.manifestUrl,
      referers: source.referers,
      personal: false,
      direct: true,
      quality: source.quality,
      label: source.title || source.carrierLabel,
      providerLabel: source.carrierLabel,
    }));
    upstreams.push(...directUpstreams);
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
 *
 * The door to refresh is named: the door that failed is the one that is
 * asked again - not whichever door happens to be at the front of the list.
 */
export async function refreshUpstream(
  channel: MediaChannel,
  upstream?: ChannelUpstream | null,
): Promise<ChannelUpstream | null> {
  const current = upstream ?? currentUpstream(channel);
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
    replaceUpstream(channel, current.serverId, refreshed);
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
      quality: source.quality,
      label: source.title || source.carrierLabel,
      providerLabel: source.carrierLabel,
    };
    replaceUpstream(channel, current.serverId, refreshed);
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
    replaceUpstream(channel, current.serverId, refreshed);
    return refreshed;
  }

  const manifestUrl = await resolveManifestUrl(channel.streamKey, current.serverId);
  if (!manifestUrl) return null;
  const refreshed: ChannelUpstream = {
    ...current,
    manifestUrl,
    referers: referersFor(manifestUrl),
  };
  replaceUpstream(channel, current.serverId, refreshed);
  return refreshed;
}

/**
 * Moves the channel on to the next door, when there is one.
 *
 * A door that turned out to be an advertisement is not tried again: the
 * channel remembers it and moves past it, so the advert is never served a
 * second time. A door that stopped answering is remembered as well - the
 * app does not spend the time of asking a dead door again while another one
 * is still there.
 */
export function rotateUpstream(channel: MediaChannel): boolean {
  const total = channel.upstreams.length;
  if (total === 0) return false;

  // The door that is being read is remembered as dead, even when it is the
  // last one: the app has to know that every door it knew is gone, so it
  // looks the match up again instead of asking a dead door for ever.
  const current = channel.upstreams[channel.upstreamIndex];
  if (current) channel.rejected.add(current.serverId);

  for (let step = 1; step <= total; step += 1) {
    const index = (channel.upstreamIndex + step) % total;
    const upstream = channel.upstreams[index];
    if (!upstream) continue;
    if (channel.rejected.has(upstream.serverId)) continue;
    channel.upstreamIndex = index;
    // Another feed of the same match: the app's own numbering continues
    // after the last segment of the old one, so the player sees a cut.
    newGeneration(channel);
    channel.failovers += 1;
    return true;
  }
  return false;
}

/**
 * Looks the match up again and gives the channel fresh doors.
 *
 * This is what the app does by itself when every door it knew is dead: the
 * providers are asked for their feeds again, the pages are opened again, and
 * the addresses that are fresh now are given to the channel. The user does
 * not have to do anything - a feed that dies in the middle of a game is a
 * cut, not the end of the game.
 *
 * The doors that come back are the ones that answered a moment ago: the
 * lookup measures every feed it finds - the playlist has to answer, the
 * newest segment has to be video - so a door that is in this list is a door
 * that is alive right now. The dead doors are forgotten, because the address
 * they had is not the address that just answered.
 */
export async function rescueMatch(channel: MediaChannel): Promise<ChannelUpstream | null> {
  const now = Date.now();
  if (now - channel.lastRescueAt < RESCUE_INTERVAL_MS) return null;
  channel.lastRescueAt = now;

  // The answer that is cached is the answer that was found when the feeds
  // were alive. The match is looked up from scratch.
  invalidateMatchSources(channel.streamKey);

  const upstreams = await resolveUpstreams({
    streamKey: channel.streamKey,
    slot: channel.slot,
    quality: channel.quality,
  });
  if (upstreams.length === 0) return null;

  channel.upstreams.splice(0, channel.upstreams.length, ...upstreams);
  channel.upstreamIndex = 0;
  channel.rejected.clear();
  channel.failovers += 1;
  newGeneration(channel);
  return channel.upstreams[0] ?? null;
}
