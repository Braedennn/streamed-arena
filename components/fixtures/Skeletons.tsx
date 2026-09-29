'use client';

import { Skeleton } from '@/components/ui/panel';
import { cn } from '@/lib/utils';

export function MatchCardSkeletons({ count = 8, compact = false }: { count?: number; compact?: boolean }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div
          key={index}
          className={cn(
            'overflow-hidden rounded-2xl border border-edge bg-void-850',
            compact ? 'flex items-center gap-3 p-3.5' : 'flex flex-col gap-4 p-4 sm:p-5',
          )}
        >
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-16 rounded-md" />
            <Skeleton className="h-6 w-24 rounded-md" />
            <Skeleton className="ml-auto h-6 w-12 rounded-md" />
          </div>
          <div className={cn('flex items-center gap-3', !compact && 'justify-between px-1 py-2')}>
            <Skeleton className="h-14 w-14 rounded-2xl sm:h-16 sm:w-16" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
            {!compact ? <Skeleton className="h-14 w-14 rounded-2xl sm:h-16 sm:w-16" /> : null}
          </div>
          <div className="mt-auto flex items-center justify-between gap-3 border-t border-edge pt-3.5">
            <div className="space-y-2">
              <div className="flex gap-1.5">
                <Skeleton className="h-4 w-12 rounded-md" />
                <Skeleton className="h-4 w-12 rounded-md" />
              </div>
              <Skeleton className="h-3 w-32" />
            </div>
            <Skeleton className="h-9 w-20 rounded-xl" />
          </div>
        </div>
      ))}
    </>
  );
}

export function HeroSkeleton() {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-edge bg-void-850 p-6 sm:p-10">
      <div className="relative grid gap-8 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-5">
          <Skeleton className="h-6 w-40 rounded-md" />
          <Skeleton className="h-12 w-3/4" />
          <Skeleton className="h-12 w-1/2" />
          <div className="flex gap-3">
            <Skeleton className="h-14 w-14 rounded-2xl" />
            <Skeleton className="h-14 w-14 rounded-2xl" />
          </div>
          <div className="flex gap-3">
            <Skeleton className="h-12 w-40 rounded-xl" />
            <Skeleton className="h-12 w-32 rounded-xl" />
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-24 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
