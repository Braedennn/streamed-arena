import Link from 'next/link';
import { Home, Radio, Search } from 'lucide-react';

export default function NotFound() {
  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden bg-void px-4">
      <div className="pointer-events-none absolute inset-0 bg-grid-void bg-[size:64px_64px]" />
      <div className="relative w-full max-w-xl rounded-md border border-edge bg-void-850 p-10 text-center">
        <span className="mx-auto grid h-12 w-12 place-items-center rounded-md border border-volt bg-volt text-void">
          <Radio className="h-6 w-6" />
        </span>
        <p className="mt-6 font-mono text-5xl font-bold tabular-nums text-live">404</p>
        <h1 className="mt-3 font-display text-2xl font-bold tracking-tight text-white">
          Off the board
        </h1>
        <p className="mx-auto mt-3 max-w-sm text-sm leading-relaxed text-ink-400">
          This page is not in the arena. Head back to the live board to catch the action.
        </p>
        <div className="mt-7 flex flex-wrap justify-center gap-2">
          <Link
            href="/"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-live bg-live px-4 text-xs font-semibold text-void transition hover:bg-live-600"
          >
            <Home className="h-4 w-4" />
            Home
          </Link>
          <Link
            href="/live"
            className="inline-flex h-10 items-center gap-2 rounded-md border border-edge bg-void-800 px-4 text-xs font-semibold text-ink-200 transition hover:border-edge-hi hover:text-white"
          >
            <Search className="h-4 w-4" />
            Live matches
          </Link>
        </div>
      </div>
    </div>
  );
}
