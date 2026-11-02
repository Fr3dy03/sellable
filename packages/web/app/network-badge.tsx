'use client';

import { useEffect, useState } from 'react';
import { fetchHealth, type Health } from '@/lib/api';

export default function NetworkBadge() {
  const [health, setHealth] = useState<Health | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const next = await fetchHealth();
        if (active) { setHealth(next); setUnavailable(false); }
      } catch {
        if (active) { setHealth(null); setUnavailable(true); }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    window.addEventListener('online', refresh);
    return () => { active = false; clearInterval(timer); window.removeEventListener('online', refresh); };
  }, []);

  if (unavailable) return <span className="chain-badge" role="status">API unavailable</span>;
  if (!health) return <span className="chain-badge" role="status">connecting…</span>;

  const testnet = health.network === 'testnet';
  const status = !health.rpc ? ' · RPC unavailable' : !health.db ? ' · storage unavailable' : '';
  return (
    <span className="chain-badge" role="status" title={`${testnet ? 'Bohr testnet · chainId 968' : 'BOT Chain mainnet · chainId 677'}${health.block != null ? ` · block ${health.block}` : ''}${status}`}>
      <span className={`chain-dot${testnet || !health.ok ? ' testnet' : ''}`} />
      {testnet ? 'Bohr testnet · 968' : 'BOT Chain mainnet · 677'}{status}
    </span>
  );
}
