'use client';

import Link from 'next/link';
import { Radio, ShieldCheck } from 'lucide-react';

const FOOTER_LINKS = [
  { href: '/', label: 'Home' },
  { href: '/live', label: 'Live Now' },
  { href: '/schedule', label: 'Schedule' },
  { href: '/multistream', label: 'Multistream' },
] as const;

export function Footer() {
  return (
    <footer className="mt-16 border-t border-edge bg-void-950">
      <div className="mx-auto flex max-w-[1440px] flex-col gap-5 px-4 py-10 sm:px-6 md:flex-row md:items-center md:justify-between">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md border border-volt bg-volt">
            <Radio className="h-4 w-4 text-void" />
          </span>
          <div>
            <p className="font-display text-sm font-bold tracking-[0.16em] text-white">
              STREAMED ARENA
            </p>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-ink-500">
              {'Made with love by TotallyNoire <3'}
            </p>
          </div>
        </div>

        <div className="flex flex-col items-start gap-4 md:items-end">
          <nav className="flex flex-wrap items-center gap-2">
            {FOOTER_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="inline-flex h-9 items-center rounded-md border border-edge bg-void-850 px-3.5 text-xs font-semibold uppercase tracking-[0.12em] text-ink-300 transition hover:border-edge-hi hover:text-white"
              >
                {link.label}
              </Link>
            ))}
          </nav>
          <div className="flex flex-wrap items-center gap-3">
            <span className="inline-flex items-center gap-2 rounded-md border border-edge bg-void-850 px-3 py-2 text-[11px] uppercase tracking-[0.16em] text-ink-400">
              <ShieldCheck className="h-3.5 w-3.5 text-live" />
              Ad shield
            </span>
          </div>
        </div>
      </div>
    </footer>
  );
}
