import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessMs, localDayStart, MINUTE, type ShopClock } from './businessHours.js';
import { buildTurns } from './turns.js';
import { summarize } from './summary.js';
import { resolutionSummary } from './resolution.js';

// WIB, Mon–Sat 08:00–17:00. 2026-11-02 is a Monday.
const clock: ShopClock = {
  utcOffsetMinutes: 420,
  hours: Object.fromEntries([1, 2, 3, 4, 5, 6].map((d) => [d, [['08:00', '17:00']]])),
};
const wib = (s: string) => new Date(`${s}+07:00`);
const msg = (fromMe: boolean, at: string) => ({ fromMe, sentAt: wib(at) });

test('businessMs counts only time inside opening hours', () => {
  assert.equal(businessMs(wib('2026-11-02T10:00'), wib('2026-11-02T10:07'), clock), 7 * MINUTE);
  // 22:00 Monday → 08:05 Tuesday = 5 business minutes
  assert.equal(businessMs(wib('2026-11-02T22:00'), wib('2026-11-03T08:05'), clock), 5 * MINUTE);
  // Saturday 16:50 → Monday 08:10 skips closed Sunday: 10 + 10
  assert.equal(businessMs(wib('2026-11-07T16:50'), wib('2026-11-09T08:10'), clock), 20 * MINUTE);
  assert.equal(businessMs(wib('2026-11-08T09:00'), wib('2026-11-08T12:00'), clock), 0);
});

test('localDayStart returns local midnight', () => {
  assert.deepEqual(localDayStart(wib('2026-11-02T03:00'), clock), wib('2026-11-02T00:00'));
});

test('a burst of customer messages is one turn answered by the first reply', () => {
  const turns = buildTurns(
    [
      msg(false, '2026-11-02T10:00'),
      msg(false, '2026-11-02T10:01'),
      msg(false, '2026-11-02T10:03'),
      msg(true, '2026-11-02T10:12'),
      msg(true, '2026-11-02T10:13'),
      msg(false, '2026-11-02T10:20'),
    ],
    clock,
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].responseMs, 12 * MINUTE);
  assert.equal(turns[0].opensConversation, true);
  assert.equal(turns[1].repliedAt, null);
  assert.equal(turns[1].opensConversation, false);
});

test('agent-initiated messages do not create turns; a long gap opens a new conversation', () => {
  const turns = buildTurns(
    [
      msg(true, '2026-11-02T09:00'),
      msg(false, '2026-11-02T09:30'),
      msg(true, '2026-11-02T09:31'),
      msg(false, '2026-11-04T09:00'),
      msg(true, '2026-11-04T09:02'),
    ],
    clock,
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].opensConversation, false); // the agent spoke first, recently
  assert.equal(turns[1].opensConversation, true);
  assert.equal(turns[1].responseMs, 2 * MINUTE);
});

test('exchanges entirely outside opening hours are on time but left out of reply times', () => {
  const now = wib('2026-11-09T12:00');
  const chats = [
    // Sunday, closed all day: answered after 30 wall-clock minutes
    buildTurns([msg(false, '2026-11-08T10:00'), msg(true, '2026-11-08T10:30')], clock),
    // Monday 21:00 → 21:05, after closing
    buildTurns([msg(false, '2026-11-09T21:00'), msg(true, '2026-11-09T21:05')], clock),
    // Asked at night, answered 08:10 next morning: 10 business minutes, still counted
    buildTurns([msg(false, '2026-11-08T22:00'), msg(true, '2026-11-09T08:10')], clock),
  ];
  assert.equal(chats[0][0].offHours, true);
  assert.equal(chats[2][0].offHours, false);
  const s = summarize(
    chats,
    { from: wib('2026-11-08T00:00'), to: wib('2026-11-10T00:00') },
    15 * MINUTE,
    clock,
    now,
  );
  assert.equal(s.answered, 3);
  assert.equal(s.withinTarget, 3);
  assert.equal(s.offHours, 2);
  assert.equal(s.slaPct, 100);
  assert.equal(s.medianResponseMs, 10 * MINUTE);
});

test('summarize separates within-target, late, overdue and still-waiting turns', () => {
  const now = wib('2026-11-02T16:00');
  const chats = [
    buildTurns([msg(false, '2026-11-02T10:00'), msg(true, '2026-11-02T10:05')], clock), // 5m ok
    buildTurns([msg(false, '2026-11-02T11:00'), msg(true, '2026-11-02T11:40')], clock), // 40m late
    buildTurns([msg(false, '2026-11-02T13:00')], clock), // overdue
    buildTurns([msg(false, '2026-11-02T15:55')], clock), // waiting 5m
    buildTurns([msg(false, '2026-11-01T10:00'), msg(true, '2026-11-01T10:01')], clock), // outside period
  ];
  const s = summarize(
    chats,
    { from: wib('2026-11-02T00:00'), to: wib('2026-11-03T00:00') },
    15 * MINUTE,
    clock,
    now,
  );
  assert.equal(s.chats, 4);
  assert.equal(s.answered, 2);
  assert.equal(s.withinTarget, 1);
  assert.equal(s.overdue, 1);
  assert.equal(s.waiting, 1);
  assert.equal(s.slaPct, 33);
  assert.equal(s.medianResponseMs, Math.round(22.5 * MINUTE));
});

test('resolution: tuntas within the conversation counts, opening hours only; later ones go to the next conversation', () => {
  const chat = (msgs: ReturnType<typeof msg>[], resolutions: string[]) => ({
    turns: buildTurns(msgs, clock),
    resolutions: resolutions.map(wib),
  });
  const chats = [
    // asked Monday 10:00, solved 10:45 → 45 business minutes
    chat([msg(false, '2026-11-02T10:00'), msg(true, '2026-11-02T10:05')], ['2026-11-02T10:45']),
    // asked Monday 16:30, solved Tuesday 08:30 → 30 + 30 = 60 business minutes
    chat([msg(false, '2026-11-02T16:30'), msg(true, '2026-11-02T16:40')], ['2026-11-03T08:30']),
    // never solved
    chat([msg(false, '2026-11-02T11:00'), msg(true, '2026-11-02T11:02')], []),
    // two conversations two days apart; the only resolution belongs to the second one
    chat(
      [msg(false, '2026-11-02T09:00'), msg(true, '2026-11-02T09:01'), msg(false, '2026-11-04T09:00'), msg(true, '2026-11-04T09:01')],
      ['2026-11-04T09:20'],
    ),
  ];
  const r = resolutionSummary(chats, { from: wib('2026-11-02T00:00'), to: wib('2026-11-05T00:00') }, clock);
  assert.equal(r.conversations, 5);
  assert.equal(r.resolved, 3);
  assert.equal(r.resolutionPct, 60);
  assert.equal(r.medianResolutionMs, 45 * MINUTE);
});
