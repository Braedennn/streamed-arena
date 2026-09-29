'use client';

import Image from 'next/image';
import * as React from 'react';
import { cn, initials } from '@/lib/utils';

export const BLUR_DATA_URL =
  "data:image/svg+xml;charset=utf-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Crect width='24' height='24' fill='%2312151E'/%3E%3C/svg%3E";

interface SafeImageProps {
  src: string | null | undefined;
  alt: string;
  className?: string;
  imgClassName?: string;
  width?: number;
  height?: number;
  sizes?: string;
  fill?: boolean;
  priority?: boolean;
  fallbackText?: string;
  fallbackClassName?: string;
}

export function SafeImage({
  src,
  alt,
  className,
  imgClassName,
  width = 48,
  height = 48,
  sizes,
  fill = false,
  priority = false,
  fallbackText,
  fallbackClassName,
}: SafeImageProps) {
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setFailed(false);
  }, [src]);

  const showFallback = !src || failed;
  const label = fallbackText ?? initials(alt);

  if (showFallback) {
    return (
      <span
        aria-label={alt}
        className={cn(
          'inline-flex select-none items-center justify-center overflow-hidden rounded-md border border-edge bg-void-800 font-display text-[11px] font-bold text-ink-200',
          fill && 'absolute inset-0',
          className,
          fallbackClassName,
        )}
      >
        {label}
      </span>
    );
  }

  return (
    <span className={cn('relative block overflow-hidden', fill && 'absolute inset-0', className)}>
      <Image
        src={src}
        alt={alt}
        fill={fill}
        width={fill ? undefined : width}
        height={fill ? undefined : height}
        sizes={sizes}
        priority={priority}
        placeholder="blur"
        blurDataURL={BLUR_DATA_URL}
        className={cn('object-contain', fill && 'absolute inset-0', imgClassName)}
        onError={() => setFailed(true)}
      />
    </span>
  );
}
