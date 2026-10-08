import { CURRENT, getBlockNumber, getLogs, preCheck } from '@sellable/core';
import { makeRepo } from '@sellable/db';
import { createTelegram } from './telegram.js';
import { handleCommand } from './commands.js';
import { createScanState, PAIR_CREATED_TOPIC, scanTick } from './scanner.js';
import { flushAlerts, notifyNewProbes } from './notify.js';

const log = (msg: string): void => console.log(`[bot ${new Date().toISOString()}] ${msg}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error('TELEGRAM_BOT_TOKEN not set — create a bot via @BotFather, put the token in .env');
    process.exit(1);
  }

  const repo = makeRepo();
  const telegram = createTelegram(token);
  const broadcastChat = process.env.TELEGRAM_ALERT_CHAT
    ? Number(process.env.TELEGRAM_ALERT_CHAT)
    : null;
  const scanMs = Number(process.env.TELEGRAM_SCAN_INTERVAL_MS || 20000);

  const check = async (address: string) => {
    const report = await preCheck(address);
    await repo.savePrecheck(report);
    return report;
  };

  const me = await telegram.getMe();
  log(`@${me.username} online - chain ${CURRENT.chainId} - broadcast ${broadcastChat ?? 'off'} - scan every ${scanMs}ms`);

  const state = createScanState();
  const seen = new Map<string, string>();
  const failures = new Map<number, number>();
  const startedAt = new Date().toISOString();

  let offset = 0;
  const pollUpdates = async (): Promise<void> => {
    try {
      const updates = await telegram.getUpdates(offset, 30);
      for (const update of updates) {
        offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;
        try {
          const replies = await handleCommand(msg.text, msg.chat.id, { repo, check });
          for (const reply of replies) await telegram.sendMessage(msg.chat.id, reply);
        } catch (err) {
          log(`command error: ${errMsg(err)}`);
          await telegram.sendMessage(msg.chat.id, 'scan failed — try again').catch(() => {});
        }
      }
    } catch (err) {
      log(`updates error: ${errMsg(err)}`);
      await sleep(3000);
    }
    void pollUpdates();
  };
  void pollUpdates();

  let scanning = false;
  const tickScan = async (): Promise<void> => {
    if (scanning) return;
    scanning = true;
    try {
      const listings = await scanTick(state, {
        repo,
        check,
        bases: [CURRENT.wrap, CURRENT.usdt],
        window: 100,
        broadcast: broadcastChat != null,
        getLogs: (fromBlock, toBlock) =>
          getLogs({ fromBlock, toBlock, address: CURRENT.dex.v2Factory, topic0: PAIR_CREATED_TOPIC }),
        getBlockNumber,
      });
      for (const l of listings) {
        log(`new pair: ${l.symbol || '??'} ${l.token} → ${l.verdict} (pair ${l.pair})`);
      }
    } catch (err) {
      log(`scan error: ${errMsg(err)}`);
    } finally {
      scanning = false;
    }
  };

  let notifying = false;
  const tickNotify = async (): Promise<void> => {
    if (notifying) return;
    notifying = true;
    try {
      const queued = await notifyNewProbes(seen, repo, startedAt);
      if (queued) log(`queued ${queued} probe alert(s)`);
      const sent = await flushAlerts(repo, telegram, broadcastChat, failures);
      if (sent) log(`sent ${sent} alert(s)`);
    } catch (err) {
      log(`notify error: ${errMsg(err)}`);
    } finally {
      notifying = false;
    }
  };

  void tickScan();
  void tickNotify();
  setInterval(() => void tickScan(), scanMs);
  setInterval(() => void tickNotify(), 10000);

  const shutdown = async (): Promise<void> => {
    await repo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
