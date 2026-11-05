// Creates (or tops up) the "Demo Toko Emas" shop. Safe to re-run.
//   npm run seed              add the demo data if it is missing
//   npm run seed -- --fresh   delete the demo agents' chats and seed them again relative to now
import { openDb } from './db/index.js';
import { seedDemo } from './demo.js';

const db = await openDb();
await seedDemo(db, { fresh: process.argv.includes('--fresh') });
await db.close();
