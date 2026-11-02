import { businessMs, type ShopClock } from './businessHours.js';

export interface SlaMessage {
  fromMe: boolean;
  sentAt: Date;
}

export interface Turn {
  /** First customer message of the burst the agent owes a reply to. */
  waitingSince: Date;
  repliedAt: Date | null;
  /** Business-hours ms until the reply; null while unanswered. */
  responseMs: number | null;
  /** True when this turn opens a new conversation, i.e. it measures "first response time". */
  opensConversation: boolean;
  /**
   * Asked and answered entirely while the shop was closed (e.g. Sunday, or 21:00 → 21:10).
   * Counts as on time, but is left out of reply-time averages so it doesn't drag them to zero.
   */
  offHours: boolean;
}

/** Silence longer than this means the next customer message starts a new conversation. */
export const CONVERSATION_GAP_MS = 24 * 60 * 60_000;

/**
 * Splits one chat into customer → agent turns. A burst of customer messages ("halo", "gan",
 * "vario 2019 masih ada?") is a single turn that starts at its first message and ends at the
 * first agent reply after it. Agent messages with nothing pending (follow-ups, broadcasts) are ignored.
 */
export function buildTurns(messages: SlaMessage[], clock: ShopClock, gapMs = CONVERSATION_GAP_MS): Turn[] {
  const sorted = [...messages].sort((x, y) => x.sentAt.getTime() - y.sentAt.getTime());
  const turns: Turn[] = [];
  let open: Turn | null = null;
  let previous: SlaMessage | undefined;

  for (const m of sorted) {
    if (!m.fromMe && !open) {
      open = {
        waitingSince: m.sentAt,
        repliedAt: null,
        responseMs: null,
        opensConversation: !previous || m.sentAt.getTime() - previous.sentAt.getTime() > gapMs,
        offHours: false,
      };
      turns.push(open);
    } else if (m.fromMe && open) {
      open.repliedAt = m.sentAt;
      open.responseMs = businessMs(open.waitingSince, m.sentAt, clock);
      // Real time passed but none of it was business time: the whole exchange happened while closed.
      open.offHours = open.responseMs === 0 && m.sentAt > open.waitingSince;
      open = null;
    }
    previous = m;
  }
  return turns;
}
