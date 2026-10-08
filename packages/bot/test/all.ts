import assert from 'node:assert/strict';
import type { PreCheckReport, PreVerdict } from '@sellable/core';
import { MemoryRepo, type ProbeRecord } from '@sellable/db';
import { HELP, formatReport, handleCommand, isAddress } from '../src/commands.js';
import {
  PAIR_CREATED_TOPIC,
  parsePairCreated,
  pickListingToken,
  createScanState,
  scanTick,
} from '../src/scanner.js';
import { flushAlerts, notifyNewProbes, probeVerdictSeverity } from '../src/notify.js';
import { createTelegram, type Telegram } from '../src/telegram.js';

type Fn = () => void | Promise<void>;
const tests: { name: string; fn: Fn }[] = [];
const test = (name: string, fn: Fn) => tests.push({ name, fn });

const BENIGN = '0xa96746E5A95B84fE758b754C857bF0eFD08B77Ad';
const TAX = '0x5508c9b8CA4540B273ea7e14c4ace6778a20412b';
const WRAP = '0xD5452816194a3784dBa983426cCe7c122F4abd30';
const USDT = '0xaBabc7Ddc03e501d190C676BF3d92ef0e6e87a3C';
const PAIR = '0x1E40432322ddb36814C16d63Bc03e3885639E666';
const CHAT = 42;
const CHAT2 = 77;

const realPairLog = {
  address: '0x65b8e98cea190d8c28b3e4716402027f634d15a3',
  blockNumber: '0x18db65e',
  data:
    '0x0000000000000000000000001e40432322ddb36814c16d63bc03e3885639e666' +
    '00000000000000000000000000000000000000000000000000000000000000019f',
  topics: [
    PAIR_CREATED_TOPIC,
    `0x000000000000000000000000${BENIGN.slice(2).toLowerCase()}`,
    `0x000000000000000000000000${WRAP.slice(2).toLowerCase()}`,
  ],
  transactionHash: '0xabc',
};

const makeReport = (address: string, verdict: PreVerdict = 'QUOTE_OK', risks: string[] = []): PreCheckReport => ({
  stage: 'pre-check',
  chainId: 968,
  block: 26064478,
  token: {
    address,
    name: 'Fixture',
    symbol: 'FIX',
    decimals: 18,
    totalSupply: '1000000',
    isContract: true,
    isVerified: false,
    isScamFlagged: false,
  },
  verdict,
  checks: [],
  risks,
  quote: null,
  sellable: 'not-run',
  disclaimer: 'test',
});

const makeProbe = (address: string, opts: Partial<ProbeRecord> = {}): ProbeRecord => ({
  address,
  chainId: 968,
  amountInWei: '20000000000000000',
  buyOk: true,
  sellOk: true,
  buyReceived: '1',
  sellReceived: '1',
  fairBuyOut: null,
  fairSellOut: null,
  buyTaxBps: 0,
  sellTaxBps: 0,
  lossBps: 57,
  buyTx: '0x1',
  approveTx: null,
  sellTx: '0x2',
  gasSpentWei: '1000',
  costBotWei: '5000000000000000',
  costUsd: 0.07,
  revertReason: null,
  verdict: 'SELLABLE',
  createdAt: '2026-10-07T21:00:00.000Z',
  ...opts,
});

const fakeCheck = (calls: string[] = [], repo?: MemoryRepo) => async (address: string) => {
  calls.push(address);
  const report = makeReport(address);
  if (repo) await repo.savePrecheck(report);
  return report;
};

test('parsePairCreated decodes the real testnet log', () => {
  const parsed = parsePairCreated(realPairLog);
  assert.ok(parsed);
  assert.equal(parsed.token0, BENIGN);
  assert.equal(parsed.token1, WRAP);
  assert.equal(parsed.pair, PAIR);
  assert.equal(parsed.block, Number('0x18db65e'));
});

test('parsePairCreated ignores non-matching topics', () => {
  const approval = { ...realPairLog, topics: ['0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925'] };
  assert.equal(parsePairCreated(approval), null);
  assert.equal(parsePairCreated({ ...realPairLog, topics: [PAIR_CREATED_TOPIC] }), null);
});

test('pickListingToken filters base pairs', () => {
  assert.equal(pickListingToken(BENIGN, WRAP, [WRAP, USDT]), BENIGN);
  assert.equal(pickListingToken(WRAP, BENIGN, [WRAP, USDT]), BENIGN);
  assert.equal(pickListingToken(WRAP, USDT, [WRAP, USDT]), null);
  assert.equal(pickListingToken(BENIGN, TAX, [WRAP, USDT]), null);
});

test('help and unknown commands return help; empty input returns nothing', async () => {
  const deps = { repo: new MemoryRepo(), check: fakeCheck() };
  assert.deepEqual(await handleCommand('/help', CHAT, deps), [HELP]);
  assert.deepEqual(await handleCommand('/nope', CHAT, deps), [HELP]);
  assert.deepEqual(await handleCommand('   ', CHAT, deps), []);
});

test('bare address runs the check and formats the reply', async () => {
  const calls: string[] = [];
  const deps = { repo: new MemoryRepo(), check: fakeCheck(calls) };
  const [reply] = await handleCommand(BENIGN, CHAT, deps);
  assert.deepEqual(calls, [BENIGN]);
  assert.match(reply, /QUOTE_OK/);
  assert.match(reply, /risks: none/);
  assert.match(reply, /explorer:/);
});

test('/check validates the address', async () => {
  const deps = { repo: new MemoryRepo(), check: fakeCheck() };
  assert.deepEqual(await handleCommand('/check nope', CHAT, deps), ['usage: /check 0x…']);
  assert.deepEqual(await handleCommand('/check', CHAT, deps), ['usage: /check 0x…']);
});

test('/watch checks unknown tokens, subscribes, dedupes; /list and /unwatch work', async () => {
  const calls: string[] = [];
  const repo = new MemoryRepo();
  const deps = { repo, check: fakeCheck(calls, repo) };

  const [watched] = await handleCommand(`/watch ${BENIGN}`, CHAT, deps);
  assert.match(watched, /watching/);
  assert.deepEqual(calls, [BENIGN], 'unknown token is checked first (saves meta for FK)');

  const [dup] = await handleCommand(`/watch ${BENIGN}`, CHAT, deps);
  assert.match(dup, /already watching/);
  assert.equal(calls.length, 1);

  const list = await handleCommand('/list', CHAT, deps);
  assert.match(list.join('\n'), /\$FIX 0xa967…77Ad/);

  const [off] = await handleCommand(`/unwatch ${BENIGN}`, CHAT, deps);
  assert.match(off, /stopped watching/);
  const [none] = await handleCommand(`/unwatch ${BENIGN}`, CHAT, deps);
  assert.match(none, /no subscription/);
  assert.deepEqual(await handleCommand('/list', CHAT, deps), ['watchlist is empty — /watch 0x…']);
});

test('/probe queues a job and auto-subscribes', async () => {
  const repo = new MemoryRepo();
  const deps = { repo, check: fakeCheck() };
  const [queued] = await handleCommand(`/probe ${TAX}`, CHAT, deps);
  assert.match(queued, /probe queued/);
  const job = await repo.nextProbeJob();
  assert.equal(job?.address, TAX.toLowerCase());
  assert.equal(job?.reason, `telegram:${CHAT}`);
  assert.equal((await repo.subscribers(TAX)).length, 1);

  const [again] = await handleCommand(`/probe ${TAX}`, CHAT, deps);
  assert.match(again, /already queued or running/);
});

test('/join, /leave and /alerts manage new-pair alerts and severity', async () => {
  const repo = new MemoryRepo();
  const deps = { repo, check: fakeCheck() };

  const [joined] = await handleCommand('/join', CHAT, deps);
  assert.match(joined, /joined/);
  const [dup] = await handleCommand('/join', CHAT, deps);
  assert.match(dup, /already joined/);

  const list = await handleCommand('/list', CHAT, deps);
  assert.match(list.join('\n'), /🔔 new listings/);

  const [cur] = await handleCommand('/alerts', CHAT, deps);
  assert.match(cur, /minimum severity: info/);
  const [bad] = await handleCommand('/alerts loud', CHAT, deps);
  assert.match(bad, /usage: \/alerts info\|warn\|danger/);
  const [set] = await handleCommand('/alerts danger', CHAT, deps);
  assert.match(set, /minimum severity for 1 subscription: danger/);

  const [left] = await handleCommand('/leave', CHAT, deps);
  assert.match(left, /left/);
  const [leftAgain] = await handleCommand('/leave', CHAT, deps);
  assert.match(leftAgain, /not joined/);
  const [empty] = await handleCommand('/alerts', CHAT, deps);
  assert.match(empty, /no subscriptions yet/);
});

test('/alerts without subscriptions hints to join or watch first', async () => {
  const deps = { repo: new MemoryRepo(), check: fakeCheck() };
  const [hint] = await handleCommand('/alerts warn', CHAT, deps);
  assert.match(hint, /no subscriptions yet/);
});

test('scanner delivers to new-listing subscribers, filtered by minSeverity', async () => {
  const repo = new MemoryRepo();
  await repo.subscribe(CHAT, '', 'new-listing');
  await repo.subscribe(CHAT2, BENIGN, 'token');
  await repo.setMinSeverity(CHAT2, 'danger');
  const deps = {
    repo,
    check: fakeCheck(),
    getLogs: async () => [realPairLog],
    getBlockNumber: async () => Number('0x18db65e') + 5,
    bases: [WRAP, USDT],
    window: 100,
    broadcast: false,
  };
  const listings = await scanTick(createScanState(), deps);
  assert.equal(listings.length, 1);

  const pending = await repo.pendingAlerts(10);
  assert.equal(pending.length, 1, 'info listing: new-listing sub gets it, danger sub filtered');
  assert.equal(pending[0].chatId, CHAT);
  assert.equal(pending[0].severity, 'info');
});

test('notifyNewProbes respects minSeverity', async () => {
  const repo = new MemoryRepo();
  await repo.subscribe(CHAT, BENIGN, 'token');
  await repo.setMinSeverity(CHAT, 'danger');
  const seen = new Map<string, string>();

  await repo.saveProbe(makeProbe(BENIGN, { createdAt: new Date(Date.now() + 60_000).toISOString() }));
  assert.equal(await notifyNewProbes(seen, repo), 0, 'info verdict below the danger bar');

  await repo.saveProbe(
    makeProbe(BENIGN, {
      verdict: 'HONEYPOT',
      lossBps: null,
      createdAt: new Date(Date.now() + 120_000).toISOString(),
    }),
  );
  assert.equal(await notifyNewProbes(seen, repo), 1, 'danger verdict passes the bar');
});

test('scanTick alerts subscribers and broadcast on a new pair, dedupes replays', async () => {
  const repo = new MemoryRepo();
  await repo.subscribe(CHAT, BENIGN, 'token');
  const calls: string[] = [];
  let block = Number('0x18db65e') + 5;
  const deps = {
    repo,
    check: fakeCheck(calls),
    getLogs: async () => [realPairLog],
    getBlockNumber: async () => block,
    bases: [WRAP, USDT],
    window: 100,
    broadcast: true,
  };
  const state = createScanState();

  const listings = await scanTick(state, deps);
  assert.equal(listings.length, 1);
  assert.equal(listings[0].token, BENIGN);
  assert.equal(listings[0].verdict, 'QUOTE_OK');
  assert.deepEqual(calls, [BENIGN]);

  const pending = await repo.pendingAlerts(10);
  assert.equal(pending.length, 2, 'subscriber alert + broadcast alert');
  assert.ok(pending.some((a) => a.chatId === CHAT));
  assert.ok(pending.some((a) => a.chatId === null && a.subscriptionId === null));
  assert.ok(pending.every((a) => a.title.startsWith('new pair')));

  block += 10;
  const replay = await scanTick(state, deps);
  assert.equal(replay.length, 0, 'pair address deduped across ticks');
  assert.equal((await repo.pendingAlerts(10)).length, 2);
});

test('scanTick skips base-only pairs without calling check', async () => {
  const calls: string[] = [];
  const basePairLog = {
    ...realPairLog,
    data: `0x${'0'.repeat(24)}${USDT.slice(2).toLowerCase()}${'0'.repeat(64)}`,
    topics: [PAIR_CREATED_TOPIC, `0x${'0'.repeat(24)}${USDT.slice(2)}`, `0x${'0'.repeat(24)}${WRAP.slice(2)}`],
  };
  const deps = {
    repo: new MemoryRepo(),
    check: fakeCheck(calls),
    getLogs: async () => [basePairLog],
    getBlockNumber: async () => 999,
    bases: [WRAP, USDT],
    window: 10,
    broadcast: false,
  };
  const listings = await scanTick(createScanState(), deps);
  assert.equal(listings.length, 0);
  assert.equal(calls.length, 0);
});

test('notifyNewProbes ignores probes predating the subscription (seed only)', async () => {
  const repo = new MemoryRepo();
  await repo.subscribe(CHAT, BENIGN, 'token');
  const seen = new Map<string, string>();

  await repo.saveProbe(makeProbe(BENIGN, { createdAt: '2020-01-01T00:00:00.000Z' }));
  assert.equal(await notifyNewProbes(seen, repo), 0, 'pre-watch probe does not alert');

  await repo.saveProbe(makeProbe(BENIGN, { createdAt: '2020-01-02T00:00:00.000Z' }));
  assert.equal(await notifyNewProbes(seen, repo), 0, 'still predates the watch');
  assert.equal((await repo.pendingAlerts(10)).length, 0);
});

test('notifyNewProbes alerts when the probe postdates the subscription (/probe flow)', async () => {
  const repo = new MemoryRepo();
  await repo.subscribe(CHAT, BENIGN, 'token');
  const seen = new Map<string, string>();
  const fresh = new Date(Date.now() + 60_000).toISOString();

  await repo.saveProbe(makeProbe(BENIGN, { verdict: 'HONEYPOT', lossBps: null, createdAt: fresh }));
  assert.equal(await notifyNewProbes(seen, repo), 1, 'first sighting after the watch still alerts');
  const pending = await repo.pendingAlerts(10);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].severity, 'danger');
  assert.equal(pending[0].chatId, CHAT);
  assert.equal(await notifyNewProbes(seen, repo), 0, 'no duplicate for the same probe');
});

test('notifyNewProbes does not re-alert old probes after a bot restart', async () => {
  const repo = new MemoryRepo();
  await repo.subscribe(CHAT, BENIGN, 'token');
  const probeAt = new Date(Date.now() + 60_000).toISOString();
  await repo.saveProbe(makeProbe(BENIGN, { createdAt: probeAt }));

  const restartedAt = new Date(Date.now() + 120_000).toISOString();
  const seen = new Map<string, string>();
  assert.equal(await notifyNewProbes(seen, repo, restartedAt), 0, 'probe finished before restart');
  assert.equal((await repo.pendingAlerts(10)).length, 0);
});

test('probe verdict severity mapping', () => {
  assert.equal(probeVerdictSeverity('SELLABLE'), 'info');
  assert.equal(probeVerdictSeverity('HIGH_TAX'), 'warn');
  assert.equal(probeVerdictSeverity('INCONCLUSIVE'), 'warn');
  assert.equal(probeVerdictSeverity('HONEYPOT'), 'danger');
});

test('flushAlerts delivers to subscriber chat and broadcast, marks sent', async () => {
  const repo = new MemoryRepo();
  await repo.subscribe(CHAT, BENIGN, 'token');
  const sent: { chat: number; text: string }[] = [];
  const tg: Telegram = {
    getMe: async () => ({ username: 'test' }),
    sendMessage: async (chatId, text) => {
      sent.push({ chat: chatId, text });
    },
    getUpdates: async () => [],
  };

  await repo.enqueueAlert({
    subscriptionId: (await repo.subscribers(BENIGN))[0].id,
    address: BENIGN,
    severity: 'danger',
    title: 'HONEYPOT · FIX',
    body: 'sell reverted',
  });
  await repo.enqueueAlert({
    subscriptionId: null,
    address: BENIGN,
    severity: 'info',
    title: 'new pair · FIX',
    body: 'QUOTE_OK',
  });

  const n = await flushAlerts(repo, tg, 999);
  assert.equal(n, 2);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].chat, CHAT);
  assert.match(sent[0].text, /🚨/);
  assert.equal(sent[1].chat, 999);
  assert.equal((await repo.pendingAlerts(10)).length, 0);
});

test('flushAlerts drops alerts with no destination and retries failures up to max', async () => {
  const repo = new MemoryRepo();
  await repo.enqueueAlert({ subscriptionId: null, address: null, severity: 'info', title: 't', body: 'b' });
  assert.equal(await flushAlerts(repo, { getMe: async () => ({ username: 'x' }), sendMessage: async () => {}, getUpdates: async () => [] }, null), 0);
  assert.equal((await repo.pendingAlerts(10)).length, 0, 'no chat and no broadcast → dropped');

  await repo.subscribe(CHAT, BENIGN, 'token');
  const subId = (await repo.subscribers(BENIGN))[0].id;
  await repo.enqueueAlert({
    subscriptionId: subId,
    address: BENIGN,
    severity: 'warn',
    title: 't',
    body: 'b',
  });
  const failing: Telegram = {
    getMe: async () => ({ username: 'x' }),
    sendMessage: async () => {
      throw new Error('blocked');
    },
    getUpdates: async () => [],
  };
  const failures = new Map<number, number>();
  await flushAlerts(repo, failing, null, failures, 3);
  assert.equal((await repo.pendingAlerts(10)).length, 1, 'failure keeps alert pending');
  await flushAlerts(repo, failing, null, failures, 3);
  await flushAlerts(repo, failing, null, failures, 3);
  assert.equal((await repo.pendingAlerts(10)).length, 0, 'gives up after maxFailures');
});

test('createTelegram posts to the right URL and payload', async () => {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ ok: true, result: { username: 'me' } }), { status: 200 });
  };
  const tg = createTelegram('TOKEN123', fetchFn);
  const me = await tg.getMe();
  assert.equal(me.username, 'me');
  assert.match(calls[0].url, /botTOKEN123\/getMe$/);

  await tg.sendMessage(77, 'hello');
  assert.equal(calls[1].url, '/botTOKEN123/sendMessage'.replace('/bot', 'https://api.telegram.org/bot'));
  assert.equal(calls[1].body.chat_id, 77);
  assert.equal(calls[1].body.text, 'hello');
});

test('createTelegram surfaces API errors', async () => {
  const fetchFn = async (): Promise<Response> =>
    new Response(JSON.stringify({ ok: false, description: 'chat not found' }), { status: 400 });
  const tg = createTelegram('T', fetchFn);
  await assert.rejects(() => tg.sendMessage(1, 'x'), /chat not found/);
});

test('isAddress matches the 0x+40-hex shape', () => {
  assert.equal(isAddress(BENIGN), true);
  assert.equal(isAddress('0x123'), false);
  assert.equal(isAddress('nope'), false);
});

test('formatReport includes verdict, risks and explorer link', () => {
  const out = formatReport(makeReport(BENIGN, 'NO_LIQUIDITY', ['no pair']));
  assert.match(out, /NO_LIQUIDITY · FIX/);
  assert.match(out, /risks: no pair/);
  assert.match(out, /explorer: https:\/\//);
});

async function run(): Promise<void> {
  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log(`  ok  ${t.name}`);
    } catch (err) {
      fail++;
      console.log(`FAIL  ${t.name}`);
      console.log(`      ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

run();
