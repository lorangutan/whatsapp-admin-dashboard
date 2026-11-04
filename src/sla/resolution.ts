import { businessMs, type ShopClock } from './businessHours.js';
import { median, type Period } from './summary.js';
import type { Turn } from './turns.js';

export interface ResolutionSummary {
  /** Conversations that started in the period (a customer message after 24 h of silence). */
  conversations: number;
  /** …of which were marked tuntas before the customer's next conversation began. */
  resolved: number;
  resolutionPct: number | null;
  /** Opening-hours time from the conversation's first customer message to "tuntas". */
  medianResolutionMs: number | null;
}

/**
 * "Was the customer's problem solved, and how long did it take?" — the resolution side of the SLA,
 * next to reply speed. Each chat brings its turns (for conversation starts) and its resolution times.
 */
export function resolutionSummary(
  chats: { turns: Turn[]; resolutions: Date[] }[],
  period: Period,
  clock: ShopClock,
): ResolutionSummary {
  let conversations = 0;
  const times: number[] = [];
  for (const { turns, resolutions } of chats) {
    const starts = turns.filter((t) => t.opensConversation).map((t) => t.waitingSince);
    const sorted = [...resolutions].sort((a, b) => a.getTime() - b.getTime());
    starts.forEach((start, i) => {
      if (start < period.from || start >= period.to) return;
      conversations++;
      const end = starts[i + 1]?.getTime() ?? Infinity;
      const solved = sorted.find((r) => r >= start && r.getTime() < end);
      if (solved) times.push(businessMs(start, solved, clock));
    });
  }
  return {
    conversations,
    resolved: times.length,
    resolutionPct: conversations ? Math.round((times.length / conversations) * 100) : null,
    medianResolutionMs: median(times),
  };
}
