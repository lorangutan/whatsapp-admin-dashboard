import pino from 'pino';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { ChannelManager } from './channels/manager.js';
import { scheduleDailyReport } from './report/daily.js';
import { buildServer } from './server.js';
import { opsAlert } from './ops.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const db = await openDb();
const channels = new ChannelManager(db, config.dataDir, log);
const app = buildServer(db, channels, log);

await app.listen({ port: config.port, host: config.host });
await channels.resumeAll();
const timer = scheduleDailyReport(db, channels, log);
const watchdog = channels.watch();

// One stray failure (a DB hiccup in a background step) must not take every WhatsApp number offline.
process.on('unhandledRejection', (err) => {
  log.error({ err }, 'unhandled rejection');
  opsAlert(log, 'unhandled', `Error tak tertangani: ${(err as Error)?.message ?? err}`);
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    // Never hang on the way out: a restart that waits for systemd's kill means minutes without WhatsApp.
    setTimeout(() => process.exit(1), 10_000).unref();
    clearInterval(timer);
    clearInterval(watchdog);
    await channels.stopAll();
    await app.close();
    await db.close();
    process.exit(0);
  });
}
