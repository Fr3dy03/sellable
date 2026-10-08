import type { ReactNode } from 'react';
import './globals.css';
import NetworkBadge from './network-badge';
import Particles from './particles';

export const metadata = {
  title: 'Sellable — paste the CA, know if you can sell',
  description:
    'Trade-safety scanner for BOT Chain: deterministic pre-checks and real buy->sell probe verdicts.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Particles />
        <header className="site-header">
          <a href="/" className="brand">
            <span className="brand-mark">◆</span> sellable<span className="brand-dot">.bot</span>
          </a>
          <NetworkBadge />
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          paste the CA. know if you can sell. — deterministic checks, no vibes.
        </footer>
      </body>
    </html>
  );
}
