'use client';

import * as React from 'react';
import { Radio } from 'lucide-react';
import { useFixtures } from '@/lib/hooks';
import { splitTitle } from '@/lib/utils';

export function Ticker() {
  const { liveFixtures } = useFixtures();

  const items = React.useMemo(
    () =>
      liveFixtures.slice(0, 14).map((fixture) => {
        const fallback = splitTitle(fixture.title);
        return `${fixture.home?.name ?? fallback.home} vs ${fixture.away?.name ?? fallback.away}`;
      }),
    [liveFixtures],
  );

  if (items.length === 0) return null;
  const loop = [...items, ...items];

  return (
    <div className="app-drag relative overflow-hidden border-b border-edge bg-void-850">
      <div className="flex w-max animate-ticker items-center gap-10 py-2.5 will-change-transform">
        {loop.map((title, index) => (
          <span
            key={`${title}-${index}`}
            className="inline-flex items-center gap-2 whitespace-nowrap text-[11px] font-medium uppercase tracking-[0.2em] text-ink-400"
          >
            <Radio className="h-3 w-3 text-live" />
            {title}
            <span className="text-edge-hi">●</span>
          </span>
        ))}
      </div>
    </div>
  );
}
