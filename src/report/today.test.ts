import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultBusinessHours, defaultPrefs, defaultStages } from '../db/schema.js';
import type { Shop } from '../db/repo.js';
import { forChannel, formatToday, isEmpty, type TodayList } from './today.js';

const shop: Shop = {
  id: 1,
  name: 'Bengkel Uji',
  utcOffsetMinutes: 420,
  businessHours: defaultBusinessHours,
  slaTargetMinutes: 15,
  ownerWa: '62811',
  reportTime: '20:00',
  pipelineStages: defaultStages,
  prefs: defaultPrefs,
} as Shop;

const base = { agentName: 'Budi', contactName: 'Pak Rudi', phone: '62812' };
const list: TodayList = {
  day: '2026-11-05',
  followups: [
    { ...base, id: 1, chatId: 1, channelId: 1, dueAt: new Date('2026-11-05T03:00:00Z'), note: 'kirim simulasi', overdue: false },
    { ...base, id: 2, chatId: 2, channelId: 2, agentName: 'Citra', dueAt: new Date('2026-11-03T03:00:00Z'), note: null, overdue: true },
  ],
  waiting: [{ ...base, chatId: 3, channelId: 1, waitedMs: 95 * 60_000, overdue: true }],
  stale: [{ ...base, chatId: 4, channelId: 2, agentName: 'Citra', stage: 'nego', stageName: 'Nego', idleDays: 5 }],
  offline: [],
  staleDays: 3,
};

test('owner list names the salesperson and shows local times', () => {
  const text = formatToday(shop, list, { title: 'Hari ini — Bengkel Uji' });
  assert.match(text, /Follow-up \(2\)/);
  assert.match(text, /Pak Rudi \(Budi\) — 10:00 · kirim simulasi/); // 03:00 UTC is 10:00 WIB
  assert.match(text, /Pak Rudi \(Citra\) — terlambat/);
  assert.match(text, /menunggu 1j 35m/);
  assert.match(text, /Lead diam > 3 hari \(1\)/);
});

test("a salesperson's list holds only their chats, without their own name", () => {
  const mine = forChannel(list, 1);
  assert.equal(mine.followups.length, 1);
  assert.equal(mine.stale.length, 0);
  const text = formatToday(shop, mine, { title: 'Hari ini — Budi', forAgent: true });
  assert.doesNotMatch(text, /\(Budi\)/);
  assert.doesNotMatch(text, /Lead diam/);
});

test('an empty day says so', () => {
  const empty = forChannel(list, 99);
  assert.ok(isEmpty(empty));
  assert.match(formatToday(shop, empty, { title: 'x' }), /Tidak ada yang tertunda/);
});
