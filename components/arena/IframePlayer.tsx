'use client';

import * as React from 'react';
import { RotateCcw } from 'lucide-react';

interface IframePlayerProps {
  src: string;
  title: string;
  reloadToken: number;
}

export function IframePlayer({ src, title, reloadToken }: IframePlayerProps) {
  const [nonce, setNonce] = React.useState(0);

  return (
    <div className="relative h-full w-full overflow-hidden bg-void-950">
      <iframe
        key={`${src}-${reloadToken}-${nonce}`}
        src={src}
        title={title}
        // "web-share" isn't a recognized permissions-policy feature in this
        // Chromium build — and the allow list already carries fullscreen, so
        // the legacy allowFullScreen attribute would just warn.
        allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
        className="h-full w-full border-0"
      />

      <div className="absolute left-3 top-3 z-20 flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setNonce((value) => value + 1)}
          className="grid h-6 w-6 place-items-center rounded-lg border border-edge bg-void-950 text-ink-300 transition hover:text-white"
          aria-label="Reload embed"
        >
          <RotateCcw className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}
