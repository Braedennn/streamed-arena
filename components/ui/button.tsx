import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl font-medium transition-all duration-300 ease-out-expo focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-volt focus-visible:ring-offset-2 focus-visible:ring-offset-void-900 disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary:
          'bg-volt text-void font-semibold hover:-translate-y-0.5 hover:bg-volt-600 active:translate-y-0',
        live:
          'bg-live text-void font-semibold hover:-translate-y-0.5 hover:bg-live-600 active:translate-y-0',
        surface: 'surface surface-hover text-ink-100 hover:text-white',
        soft: 'bg-void-800 text-ink-100 hover:bg-void-700 hover:text-white',
        outline:
          'border border-edge bg-transparent text-ink-200 hover:border-edge-hi hover:bg-void-800 hover:text-white',
        ghost: 'text-ink-300 hover:bg-void-800 hover:text-white',
      },
      size: {
        sm: 'h-8 rounded-lg px-3 text-xs',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 rounded-2xl px-6 text-sm',
        icon: 'h-10 w-10 rounded-xl',
        'icon-sm': 'h-8 w-8 rounded-lg',
      },
    },
    defaultVariants: { variant: 'surface', size: 'md' },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Component = asChild ? Slot : 'button';
    return (
      <Component
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);

Button.displayName = 'Button';

export { buttonVariants };
