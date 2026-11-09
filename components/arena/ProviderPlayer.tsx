'use client';

import * as React from 'react';

/**
 * The provider's own player.
 *
 * Some providers publish the match inside their own page instead of as a
 * playlist - there is nothing there for the app to fetch and host. When the
 * user picks such a feed, the app shows the provider's page inside its own
 * player surface, with the name of the provider on it, so it is clear whose
 * player is on the screen.
 */
export function ProviderPlayer({ src, label }: { src: string; label?: string }) {
  return (
    <div className="relative h-full w-full bg-black">
      <iframe
        key={src}
        src={src}
        title={label ? `${label} player` : 'Provider player'}
        allow="autoplay; fullscreen; picture-in-picture; encrypted-media; clipboard-write"
        allowFullScreen
        referrerPolicy="no-referrer"
        className="h-full w-full border-0"
      />
    </div>
  );
}
