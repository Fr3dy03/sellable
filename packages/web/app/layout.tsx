import type { ReactNode } from 'react';
import Image from 'next/image';
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
          <div className="footer-inner">
            <div className="footer-network">
              <span className="footer-label">Built on</span>
              <a
                className="footer-logo"
                href="https://www.botchain.ai/"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="BOT Chain official website (opens in a new tab)"
              >
                <Image src="/brand/bot-chain-logo.png" alt="BOT Chain" width={166} height={32} />
              </a>
            </div>
            <nav className="footer-links" aria-label="BOT Chain resources">
              <a href="https://www.botchain.ai/" target="_blank" rel="noopener noreferrer">
                BOT Chain <span aria-hidden="true">↗</span>
              </a>
              <a href="https://scan.botchain.ai/" target="_blank" rel="noopener noreferrer">
                Explorer <span aria-hidden="true">↗</span>
              </a>
            </nav>
          </div>
          <p className="footer-tagline">paste the CA. know if you can sell.</p>
        </footer>
      </body>
    </html>
  );
}
