// File: web/app/layout.tsx
// Root layout: LEASH v1 theme (globals.css), wordmark/favicons carried over, Privy provider.
import type { Metadata } from 'next';
import './globals.css';
import './shell.css';
import { Providers } from './providers';
import AppShell from '@/components/shell/AppShell';

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
    // suppressHydrationWarning: the anti-FOUC <script> below sets `data-theme` on this
    // element BEFORE React hydrates, so a light-mode visitor's client <html> legitimately
    // differs from the server's. This is the documented Next.js pattern for an inline
    // theme script; it suppresses the attribute-mismatch warning on THIS element only
    // (one level deep), not on any descendant. (Latent since the G-1.2 toggle landed.)
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Preload the landing's two primary used faces (Clash Display 700 headline,
            Manrope 400 body). font-display: swap is set per @font-face in marketing.css. */}
        <link rel="preload" href="/fonts/clash-display-700.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href="/fonts/manrope-latin-400-normal.woff2" as="font" type="font/woff2" crossOrigin="anonymous" />
        {/* anti-FOUC — lifted from `design-reference/marketing.html:7`. Inline and
            synchronous is the entire point: this must set `data-theme` BEFORE first paint.
            A `useEffect` would paint dark, then flash to light. Rendered as script CHILDREN,
            never `dangerouslySetInnerHTML`, because `react/no-danger` is an eslint ERROR
            app-wide (P5C-3 / I-01).
            STAGE G-2.1 — the `location.pathname === '/'` gate is REMOVED. It scoped light
            mode to marketing while the console's five literal-dark globals.css tokens were
            un-themeable; this slice retargeted them to themeable aliases (§0d), so light now
            applies app-wide and the gate would wrongly keep the console dark. */}
        <script>
          {`try{if(localStorage.getItem('leash-theme')==='light')document.documentElement.setAttribute('data-theme','light')}catch(e){}`}
        </script>
      </head>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
