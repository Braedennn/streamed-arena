import type { Metadata, Viewport } from 'next';
import { Inter, Roboto_Mono } from 'next/font/google';
import './globals.css';
import { Providers } from '@/app/providers';
import { FilterProvider } from '@/components/providers/FilterProvider';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter', display: 'swap' });
const robotoMono = Roboto_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-roboto-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'Streamed Arena — Live Sports Streaming',
  description:
    'An ultra-modern live sports streaming arena: realtime fixtures, favorite-team pinning, multistream hero board, adaptive HLS playback and uBlock-powered ad blocking, built on the StreamFree API.',
  keywords: ['sports streaming', 'live sports', 'HLS', 'StreamFree', 'fixtures'],
};

export const viewport: Viewport = {
  themeColor: '#070405',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className={`min-h-screen bg-void font-sans text-ink-100 ${inter.variable} ${robotoMono.variable}`}>
        <Providers>
          <FilterProvider>{children}</FilterProvider>
        </Providers>
      </body>
    </html>
  );
}
