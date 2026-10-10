'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { Languages, Loader2, Radio, SignalHigh, Users } from 'lucide-react';
import { cn, formatViewers, streamKey } from '@/lib/utils';
import type { StreamGroup } from '@/lib/types';

interface StreamSwitcherProps {
  groups: readonly StreamGroup[];
  selectedSource: string | null;
  selectedKey: string | null;
  onSelectSource: (source: string) => void;
  onSelectStream: (key: string) => void;
  loading: boolean;
}

export function StreamSwitcher({
  groups,
  selectedSource,
  selectedKey,
  onSelectSource,
  onSelectStream,
  loading,
}: StreamSwitcherProps) {
  const activeGroup = groups.find((group) => group.source === selectedSource) ?? groups[0];

  if (loading) {
    return (
      <div className="space-y-3">
        <BlockLabel label="Servers" />
        <div className="flex flex-wrap gap-2">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="skeleton h-9 w-24 rounded-xl" />
          ))}
        </div>
        <BlockLabel label="Channels" />
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, index) => (
            <div key={index} className="skeleton h-14 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div>
        <BlockLabel label="Servers" />
        <p className="rounded-md border border-dashed border-edge px-3 py-6 text-center text-xs leading-relaxed text-ink-500">
          No servers yet — they show up here as soon as a stream is available.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <BlockLabel label="Servers" />
        <div className="flex flex-wrap gap-2">
          {groups.map((group) => {
            const active = group.source === activeGroup?.source;
            return (
              <button
                key={group.source}
                type="button"
                onClick={() => onSelectSource(group.source)}
                className={cn(
                  'inline-flex shrink-0 items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold uppercase tracking-[0.14em] transition-all duration-300 ease-out-expo',
                  active
                    ? 'border-volt bg-volt text-void'
                    : 'border-edge bg-void-800 text-ink-400 hover:-translate-y-0.5 hover:border-edge-hi hover:text-white',
                )}
              >
                <Radio className={cn('h-3.5 w-3.5', active ? 'text-void' : 'text-ink-500')} />
                {group.source}
                <span
                  className={cn(
                    'rounded-md px-1.5 py-0.5 font-mono text-[9px]',
                    active ? 'bg-void-950 text-white' : 'bg-void-700 text-ink-500',
                  )}
                >
                  {group.streams.length}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <BlockLabel label="Channels" />
        <div className="space-y-2">
          {activeGroup?.streams.map((stream) => {
            const key = streamKey(stream.source, stream.streamNo, stream.id);
            const active = key === selectedKey;
            const viewers = formatViewers(stream.viewers);

            return (
              <motion.button
                key={key}
                type="button"
                onClick={() => onSelectStream(key)}
                whileTap={{ scale: 0.985 }}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-all duration-300 ease-out-expo',
                  active
                    ? 'border-live bg-void-800'
                    : 'border-edge bg-void-800 hover:border-edge-hi hover:bg-void-700',
                )}
              >
                <span
                  className={cn(
                    'grid h-9 w-9 shrink-0 place-items-center rounded-lg border font-mono text-xs font-bold',
                    active
                      ? 'border-live bg-void-950 text-live'
                      : 'border-edge bg-void-700 text-ink-400',
                  )}
                >
                  {stream.streamNo}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-semibold text-white">
                      {stream.language || 'Standard feed'}
                    </span>
                    <span
                      className={cn(
                        'rounded-md px-1.5 py-0.5 font-mono text-[9px] font-bold',
                        stream.hd ? 'bg-live text-void' : 'bg-void-700 text-ink-400',
                      )}
                    >
                      {stream.hd ? 'HD' : 'SD'}
                    </span>
                  </span>
                  <span className="mt-1 flex items-center gap-3 text-[10px] uppercase tracking-[0.14em] text-ink-500">
                    <span className="inline-flex items-center gap-1">
                      <Languages className="h-3 w-3" />
                      {stream.source}
                    </span>
                    {viewers ? (
                      <span className="inline-flex items-center gap-1">
                        <Users className="h-3 w-3" />
                        {viewers}
                      </span>
                    ) : null}
                  </span>
                </span>

                {active ? (
                  <SignalHigh className="h-4 w-4 shrink-0 text-live-400" />
                ) : null}
              </motion.button>
            );
          })}

          {activeGroup && activeGroup.streams.length === 0 ? (
            <p className="rounded-xl border border-dashed border-edge px-3 py-6 text-center text-xs text-ink-500">
              This server has no active channels right now.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function BlockLabel({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <p className="text-[10px] font-semibold uppercase tracking-[0.28em] text-ink-500">{label}</p>
      {hint ? (
        <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-[0.16em] text-ink-500">
          <Loader2 className="h-3 w-3 animate-spin" />
          {hint}
        </span>
      ) : null}
    </div>
  );
}
