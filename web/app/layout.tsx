// File: web/app/layout.tsx
// Root layout: LEASH v1 theme (globals.css), wordmark/favicons carried over, Privy provider.
import type { Metadata } from 'next';
import './globals.css';
import { Providers } from './providers';
import SiteNav from '@/components/SiteNav';

export const metadata: Metadata = {
  title: 'LEASH · keep your agents on a leash',
  description:
    'Create an AI agent with hard spending limits you control. Watch it think, step in on big decisions, and cut it off in one move — with a private, verifiable record of everything it did.',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: 'any' },
      { url: '/favicon.svg', type: 'image/svg+xml' },
    ],
    apple: '/logo-256.png',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <SiteNav />
          <main id="main">{children}</main>
        </Providers>
      </body>
    </html>
  );
}
