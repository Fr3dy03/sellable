import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: repoRoot,
  async rewrites() {
    const raw = (process.env.API_URL || 'http://localhost:8787').trim();
    let api = raw;
    try {
      api = new URL(raw).origin;
    } catch {
    }
    return [{ source: '/api/:path*', destination: `${api}/:path*` }];
  },
};

export default nextConfig;
