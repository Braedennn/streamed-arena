'use client';

import { Header } from '@/components/layout/Header';
import { Ticker } from '@/components/layout/Ticker';
import { Footer } from '@/components/layout/Footer';
import { UpdatePopup } from '@/components/updater/UpdatePopup';

export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    // overflow-x-clip, not -hidden: "hidden" turns this div into a scroll
    // container, which silently disabled the header's position: sticky.
    // The env() paddings keep content clear of the notch / status bar on iOS
    // and are 0 everywhere else.
    <div className="relative min-h-screen overflow-x-clip pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] pt-[env(safe-area-inset-top)]">
      <div className="fixed inset-x-0 top-0 z-50 h-[env(safe-area-inset-top)] bg-void" />
      <div className="pointer-events-none fixed inset-0 -z-10 bg-grid-void bg-[size:64px_64px]" />
      <Ticker />
      <Header />
      <main className="mx-auto w-full max-w-[1440px] px-4 sm:px-6">{children}</main>
      <Footer />
      <UpdatePopup />
    </div>
  );
}
