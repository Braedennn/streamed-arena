'use client';

import { Header } from '@/components/layout/Header';
import { Ticker } from '@/components/layout/Ticker';
import { Footer } from '@/components/layout/Footer';

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative min-h-screen overflow-x-hidden">
      <div className="pointer-events-none fixed inset-0 -z-10 bg-grid-void bg-[size:64px_64px]" />
      <Ticker />
      <Header />
      <main className="mx-auto w-full max-w-[1440px] px-4 sm:px-6">{children}</main>
      <Footer />
    </div>
  );
}
