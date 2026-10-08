'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { isAddress } from '@/lib/api';

const EXAMPLE = '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C';

export default function Home() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState('');

  const go = (raw: string): void => {
    const addr = raw.trim();
    if (!isAddress(addr)) {
      setError('that is not a contract address (need 0x + 40 hex chars)');
      return;
    }
    setError('');
    router.push(`/token/${addr}`);
  };

  return (
    <>
      <h1>
        Paste the CA.
        <br />
        <span className="accent">Know if you can sell.</span>
      </h1>
      <p className="lead">
        deterministic trade-safety checks for BOT Chain: bytecode scan, liquidity &amp; lock
        status, buy simulation — then a real micro buy→sell probe for the final
        SELLABLE / HONEYPOT verdict.
      </p>

      <form
        className="paste-form"
        onSubmit={(e) => {
          e.preventDefault();
          go(value);
        }}
      >
        <input
          className="paste-input"
          placeholder="0x… token contract address"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          spellCheck={false}
          autoFocus
        />
        <button className="btn" type="submit">
          scan
        </button>
      </form>
      {error && <div className="form-error">{error}</div>}
      <p className="hint">
        no address? try the official USDT —{' '}
        <code onClick={() => go(EXAMPLE)}>{EXAMPLE.slice(0, 10)}…{EXAMPLE.slice(-6)}</code>
      </p>
    </>
  );
}
