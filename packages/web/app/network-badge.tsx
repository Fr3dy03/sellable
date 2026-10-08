'use client';

import { useEffect, useState } from 'react';
import { fetchHealth } from '@/lib/api';

export default function NetworkBadge() {
  const [network, setNetwork] = useState<string | null>(null);

  useEffect(() => {
    fetchHealth()
      .then((h) => setNetwork(h.network))
      .catch(() => setNetwork('unknown'));
  }, []);

  if (network === null) return <span className="chain-badge" aria-hidden="true" />;
  if (network === 'unknown') return <span className="chain-badge">rpc offline</span>;

  const testnet = network === 'testnet';
  return (
    <span className="chain-badge" title={testnet ? 'Bohr testnet · chainId 968' : 'BOT Chain mainnet · chainId 677'}>
      <span className={`chain-dot${testnet ? ' testnet' : ''}`} />
      {testnet ? 'Bohr testnet · 968' : 'BOT Chain · 677'}
    </span>
  );
}
