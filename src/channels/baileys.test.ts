import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { BaileysAdapter, toInbound } from './baileys.js';

// The event queue handles steps one at a time. A step that never settles used to block every later
// message for good (2026-11-19); now it is skipped after a time limit and reported.
test('a hung queue step is skipped and later steps still run', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const problems: string[] = [];
    const adapter = new BaileysAdapter('unused', {
      onQr() {},
      onStatus() {},
      onMessages() {},
      onQueueProblem: (label, problem) => problems.push(`${label}: ${problem}`),
    });
    const enqueue = (adapter as unknown as { enqueue(label: string, task: () => Promise<unknown>): void }).enqueue.bind(adapter);
    const ran: string[] = [];

    enqueue('stuck', () => new Promise(() => {})); // never settles
    enqueue('messages:notify', async () => { ran.push('later'); });
    enqueue('broken', async () => { throw new Error('boom'); });
    enqueue('after-error', async () => { ran.push('after-error'); });

    const settle = () => new Promise((r) => setImmediate(r));
    await settle();
    assert.deepEqual(ran, [], 'nothing runs past the stuck step before the time limit');

    mock.timers.tick(120_000);
    for (let i = 0; i < 10; i++) await settle();

    assert.deepEqual(ran, ['later', 'after-error']);
    assert.deepEqual(problems, ['stuck: timed out after 120s', 'broken: boom']);
  } finally {
    mock.timers.reset();
  }
});

// A contact's Status post arrives from status@broadcast with the poster's number as remoteJidAlt.
// It must not land in their personal chat (it did at Clean Stop until 2026-11-21).
test('status posts, groups and channels are not chats, even with a phone-number alt', () => {
  const msg = (remoteJid: string, remoteJidAlt?: string) =>
    ({ key: { remoteJid, remoteJidAlt, id: 'X1', fromMe: false }, message: { conversation: 'hi' }, messageTimestamp: 1 }) as never;
  assert.equal(toInbound(msg('status@broadcast', '6281234@s.whatsapp.net')), null);
  assert.equal(toInbound(msg('1203630@g.us', '6281234@s.whatsapp.net')), null);
  assert.equal(toInbound(msg('1203630@newsletter')), null);
  assert.equal(toInbound(msg('12345@lid', '6281234@s.whatsapp.net'))?.remoteJid, '6281234@s.whatsapp.net');
  assert.equal(toInbound(msg('6281234@s.whatsapp.net'))?.remoteJid, '6281234@s.whatsapp.net');
});
