import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accessProblem, localToday, trialDaysLeft } from './trial.js';

const wib = 420;
// 2026-11-15 23:30 WIB is still the 15th in Jakarta but already the 15th 16:30 UTC.
const lateOn15th = new Date('2026-11-15T16:30:00Z');
const earlyOn16th = new Date('2026-11-15T17:30:00Z'); // 00:30 WIB on the 16th

test('localToday follows the shop calendar, not UTC', () => {
  assert.equal(localToday(wib, lateOn15th), '2026-11-15');
  assert.equal(localToday(wib, earlyOn16th), '2026-11-16');
});

test('no dates and not disabled means full access', () => {
  assert.equal(accessProblem({ trialFrom: null, trialUntil: null, disabled: false, utcOffsetMinutes: wib }), null);
});

test('the last trial day is still allowed, the next day is not', () => {
  const u = { trialFrom: '2026-11-09', trialUntil: '2026-11-15', disabled: false, utcOffsetMinutes: wib };
  assert.equal(accessProblem(u, lateOn15th), null);
  assert.match(accessProblem(u, earlyOn16th) ?? '', /berakhir 15 November 2026/);
});

test('a trial that has not started yet is refused', () => {
  const u = { trialFrom: '2026-11-20', trialUntil: '2026-11-27', disabled: false, utcOffsetMinutes: wib };
  assert.match(accessProblem(u, lateOn15th) ?? '', /baru mulai 20 November 2026/);
});

test('a disabled account is refused even inside its trial', () => {
  const u = { trialFrom: null, trialUntil: '2026-12-31', disabled: true, utcOffsetMinutes: wib };
  assert.match(accessProblem(u, lateOn15th) ?? '', /dinonaktifkan/);
});

test('days left counts today', () => {
  const u = { trialUntil: '2026-11-15', utcOffsetMinutes: wib };
  assert.equal(trialDaysLeft(u, lateOn15th), 1);
  assert.equal(trialDaysLeft(u, earlyOn16th), 0);
  assert.equal(trialDaysLeft({ trialUntil: null, utcOffsetMinutes: wib }, lateOn15th), null);
});
