import fs from 'node:fs';
import { makeRepo, norm } from './index.js';
import type { Alert, ProbeRecord, Severity, Subscription } from './types.js';
import type { TokenMeta } from '@sellable/core';

interface StoreFile {
  tokens?: [string, TokenMeta][];
  subs?: Subscription[];
  alerts?: Alert[];
  probes?: [string, ProbeRecord[]][];
}

async function main(): Promise<void> {
  const url = process.env.DB_URL;
  if (!url || !url.trim()) {
    console.error('DB_URL not set');
    process.exit(1);
  }
  const file = process.env.SEED_FILE ?? 'data/dev-store.json';
  const store = JSON.parse(fs.readFileSync(file, 'utf8')) as StoreFile;
  const repo = makeRepo(url.trim());
  if (!(await repo.ping())) {
    console.error('postgres unreachable');
    process.exit(1);
  }

  let tokens = 0;
  for (const [, meta] of store.tokens ?? []) {
    await repo.upsertToken(meta);
    tokens++;
  }

  const oldSubs = store.subs ?? [];
  for (const s of oldSubs) {
    await repo.subscribe(s.chatId, s.address, s.kind);
  }
  const current = await repo.allSubscriptions();
  const key = (chatId: number, address: string, kind: string): string =>
    `${chatId}|${norm(address)}|${kind}`;
  const idBy = new Map(current.map((s) => [key(s.chatId, s.address, s.kind), s.id]));
  const sevByChat = new Map<number, Severity>();
  for (const s of oldSubs) {
    if (!sevByChat.has(s.chatId)) sevByChat.set(s.chatId, s.minSeverity);
  }
  for (const [chatId, sev] of sevByChat) {
    await repo.setMinSeverity(chatId, sev);
  }

  const oldById = new Map(oldSubs.map((s) => [s.id, s]));
  let alerts = 0;
  for (const a of store.alerts ?? []) {
    if (a.sent) continue;
    const old =
      a.subscriptionId != null ? oldById.get(a.subscriptionId) : undefined;
    const newId = old
      ? idBy.get(key(old.chatId, old.address, old.kind)) ?? null
      : null;
    await repo.enqueueAlert({
      subscriptionId: newId,
      address: a.address,
      severity: a.severity,
      title: a.title,
      body: a.body,
    });
    alerts++;
  }

  let probes = 0;
  for (const [addr, list] of store.probes ?? []) {
    const existing = new Set((await repo.listProbes(addr)).map((p) => p.createdAt));
    for (const p of list) {
      if (existing.has(p.createdAt)) continue;
      await repo.saveProbe({ ...p, address: p.address ?? addr });
      probes++;
    }
  }

  console.log(
    `seeded: ${tokens} tokens, ${oldSubs.length} subscriptions, ${alerts} pending alerts, ${probes} probes (${file} -> postgres)`
  );
  await repo.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
