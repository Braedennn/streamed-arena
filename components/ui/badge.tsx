import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] transition-colors',
  {
    variants: {
      variant: {
        live: 'border-live bg-live text-void',
        volt: 'border-volt bg-volt text-void',
        flare: 'border-flare bg-flare text-white',
        neutral: 'border-edge bg-void-800 text-ink-300',
        solid: 'border-edge bg-void-700 text-white',
        outline: 'border-edge-hi bg-transparent text-ink-200',
      },
    },
    defaultVariants: { variant: 'neutral' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export function LivePill({ label = 'Live', className }: { label?: string; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border border-live bg-live px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-void',
        className,
      )}
    >
      <span className="relative flex h-1.5 w-1.5">
        <span className="absolute inline-flex h-full w-full animate-pulse-live rounded-full bg-void-950" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-void-950" />
      </span>
      {label}
    </span>
  );
}
