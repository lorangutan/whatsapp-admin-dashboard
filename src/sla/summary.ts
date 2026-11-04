import { businessMs, type ShopClock } from './businessHours.js';
import type { Turn } from './turns.js';

export interface Period {
  from: Date;
  to: Date;
}

export interface SlaSummary {
  /** Chats with at least one turn in the period. */
  chats: number;
  /** Turns that opened a new conversation (≈ new inquiries). */
  conversations: number;
  turns: number;
  answered: number;
  /** Answered within the shop's target. */
  withinTarget: number;
  /** Answered while closed; counted as on time but not in the reply-time figures. */
  offHours: number;
  /** Still unanswered and already past the target. */
  overdue: number;
  /** Still unanswered but not yet past the target. */
  waiting: number;
  /** withinTarget / (answered + overdue); null when there is nothing to judge yet. */
  slaPct: number | null;
  medianResponseMs: number | null;
  avgFirstResponseMs: number | null;
}

export function summarize(
  chats: Turn[][],
  period: Period,
  targetMs: number,
  clock: ShopClock,
  now: Date,
): SlaSummary {
  const s: SlaSummary = {
    chats: 0,
    conversations: 0,
    turns: 0,
    answered: 0,
    withinTarget: 0,
    offHours: 0,
    overdue: 0,
    waiting: 0,
    slaPct: null,
    medianResponseMs: null,
    avgFirstResponseMs: null,
  };
  const responses: number[] = [];
  const firstResponses: number[] = [];

  for (const turns of chats) {
    const inPeriod = turns.filter((t) => t.waitingSince >= period.from && t.waitingSince < period.to);
    if (inPeriod.length) s.chats++;
    for (const t of inPeriod) {
      s.turns++;
      if (t.opensConversation) s.conversations++;
      if (t.responseMs !== null) {
        s.answered++;
        if (t.responseMs <= targetMs) s.withinTarget++;
        if (t.offHours) {
          s.offHours++;
          continue;
        }
        responses.push(t.responseMs);
        if (t.opensConversation) firstResponses.push(t.responseMs);
      } else if (businessMs(t.waitingSince, now, clock) > targetMs) {
        s.overdue++;
      } else {
        s.waiting++;
      }
    }
  }

  const judged = s.answered + s.overdue;
  s.slaPct = judged ? Math.round((s.withinTarget / judged) * 100) : null;
  s.medianResponseMs = median(responses);
  s.avgFirstResponseMs = firstResponses.length
    ? Math.round(firstResponses.reduce((a, b) => a + b, 0) / firstResponses.length)
    : null;
  return s;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}
