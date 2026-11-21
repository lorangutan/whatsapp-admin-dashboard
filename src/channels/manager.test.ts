import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { ChannelManager } from './manager.js';
import { opsAlert } from '../ops.js';

const logs: string[] = [];
const log = {
  info() {},
  warn: (_o: unknown, msg: string) => logs.push(msg),
  error: (_o: unknown, msg: string) => logs.push(msg),
} as unknown as FastifyBaseLogger;

// Open every day, all day, in UTC: any silence counts as opening time.
const allDay = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [['00:00', '24:00']]]));
const db = {
  query: async () => [{ id: 1, name: 'Toko Uji', utc_offset_minutes: 0, business_hours: JSON.stringify(allDay), pipeline_stages: '[]', prefs: null }],
  run: async () => ({ insertId: 0, affectedRows: 0 }),
  close: async () => {},
} as unknown as Db;

type Entry = { shopId: number; status: string; lastChatAt: number };
function managerWith(entry: Entry) {
  const m = new ChannelManager(db, 'unused', log);
  const restarts: number[] = [];
  const inner = m as unknown as {
    live: Map<number, Entry>;
    start(id: number): Promise<void>;
    checkSilence(id: number, e: Entry): Promise<void>;
  };
  inner.live.set(7, entry);
  inner.start = async (id) => {
    restarts.push(id);
    entry.lastChatAt = Date.now(); // what a real reconnect does
  };
  return { check: () => inner.checkSilence(7, entry), restarts };
}

test('a connected number with no chat for 90 open minutes is reconnected', async () => {
  const { check, restarts } = managerWith({ shopId: 1, status: 'connected', lastChatAt: Date.now() - 91 * 60_000 });
  await check();
  assert.deepEqual(restarts, [7]);
});

test('a number that had a chat recently is left alone', async () => {
  const { check, restarts } = managerWith({ shopId: 1, status: 'connected', lastChatAt: Date.now() - 30 * 60_000 });
  await check();
  assert.deepEqual(restarts, []);
});

test('the third silence reconnect in a row raises an ops alert', async () => {
  const entry = { shopId: 1, status: 'connected', lastChatAt: 0 };
  const { check, restarts } = managerWith(entry);
  logs.length = 0;
  for (let i = 0; i < 3; i++) {
    entry.lastChatAt = Date.now() - 91 * 60_000;
    await check();
  }
  await new Promise((r) => setTimeout(r, 20)); // the alert names the shop first
  assert.equal(restarts.length, 3);
  assert.equal(logs.filter((l) => l === 'ops alert').length, 1);
});

test('ops alerts are POSTed to OPS_ALERT_URL, once an hour per kind', async () => {
  const bodies: string[] = [];
  const server = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => {
      bodies.push(b);
      res.end('ok');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  process.env.OPS_ALERT_URL = `http://127.0.0.1:${port}/topic`;
  try {
    opsAlert(log, 'test:1', 'pertama');
    opsAlert(log, 'test:1', 'kedua (ditahan)');
    opsAlert(log, 'test:2', 'jenis lain');
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(bodies.sort(), ['jenis lain', 'pertama']);
  } finally {
    delete process.env.OPS_ALERT_URL;
    server.close();
  }
});
