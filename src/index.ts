import pino from 'pino';
import { config } from './config.js';
import { openDb } from './db/index.js';
import { getShop } from './db/repo.js';
import { ChannelManager } from './channels/manager.js';
import { scheduleDailyReport } from './report/daily.js';
import { buildServer } from './server.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const db = await openDb();
const channels = new ChannelManager(db, config.dataDir, log);
const app = buildServer(db, channels, log);

await app.listen({ port: config.port, host: config.host });
await channels.resumeAll((await getShop(db)).id);
const timer = scheduleDailyReport(db, channels, log);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(timer);
    await channels.stopAll();
    await app.close();
    await db.close();
    process.exit(0);
  });
}
