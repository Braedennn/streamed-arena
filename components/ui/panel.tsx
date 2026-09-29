import * as React from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('skeleton rounded-xl', className)} {...props} />;
}

export function Panel({
  className,
  children,
  interactive = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  interactive?: boolean;
}) {
  return (
    <div
      className={cn(
        'surface rounded-2xl',
        interactive && 'surface-hover lift',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  action,
  className,
  as: Tag = 'h2',
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  as?: 'h1' | 'h2';
}) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4', className)}>
      <div className="space-y-1.5">
        {eyebrow ? (
          <p className="text-[10px] font-semibold uppercase tracking-[0.32em] text-volt">
            {eyebrow}
          </p>
        ) : null}
        <Tag className="font-display text-2xl font-semibold tracking-tight text-white sm:text-3xl">
          {title}
        </Tag>
      </div>
      {action}
    </div>
  );
}
