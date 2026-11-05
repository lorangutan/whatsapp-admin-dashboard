import type { Db } from '../db/index.js';
import { chatsById, closedInPeriod, listChannels, loadResolutions, loadSlaRows, pipelineTotals, type Shop } from '../db/repo.js';
import type { Stage } from '../db/schema.js';
import { businessMs, MINUTE, type ShopClock } from '../sla/businessHours.js';
import { buildTurns, type Turn } from '../sla/turns.js';
import { summarize, type Period, type SlaSummary } from '../sla/summary.js';
import { resolutionSummary, type ResolutionSummary } from '../sla/resolution.js';

/** Reply speed plus resolution ("tuntas") for one agent or the whole shop. */
export type Summary = SlaSummary & ResolutionSummary;

export interface AgentReport extends Summary {
  channelId: number;
  agentName: string;
  phone: string | null;
  /** Deals closed (moved to a "won" stage) in the period. */
  wonCount: number;
  wonValue: number;
}

export interface PipelineReport {
  stages: (Stage & { count: number; value: number })[];
  wonCount: number;
  wonValue: number;
  lostCount: number;
}

export interface WaitingLead {
  chatId: number;
  channelId: number;
  agentName: string;
  contactName: string | null;
  phone: string;
  waitingSince: Date;
  /** Business-hours wait so far. */
  waitedMs: number;
  overdue: boolean;
}

export interface Report {
  period: Period;
  targetMinutes: number;
  totals: Summary;
  agents: AgentReport[];
  waiting: WaitingLead[];
  pipeline: PipelineReport;
}

export const shopClock = (shop: Shop): ShopClock => ({
  utcOffsetMinutes: shop.utcOffsetMinutes,
  hours: shop.businessHours,
});

export async function buildReport(db: Db, shop: Shop, period: Period, now = new Date()): Promise<Report> {
  const clock = shopClock(shop);
  const targetMs = shop.slaTargetMinutes * MINUTE;
  // Look back one conversation gap so we know whether a turn early in the period opens a conversation.
  // The shop decides how long a silence starts a new conversation (default 24 h).
  const gapMs = shop.prefs.conversationGapHours * 3_600_000;
  const rows = await loadSlaRows(db, shop.id, new Date(period.from.getTime() - gapMs));

  const byChat = new Map<number, { channelId: number; messages: { fromMe: boolean; sentAt: Date }[] }>();
  for (const r of rows) {
    let chat = byChat.get(r.chatId);
    if (!chat) byChat.set(r.chatId, (chat = { channelId: r.channelId, messages: [] }));
    chat.messages.push({ fromMe: r.fromMe, sentAt: new Date(r.sentAt) });
  }

  const resolutionsByChat = new Map<number, Date[]>();
  for (const r of await loadResolutions(db, shop.id, new Date(period.from.getTime() - gapMs))) {
    const list = resolutionsByChat.get(r.chatId) ?? [];
    list.push(new Date(r.resolvedAt));
    resolutionsByChat.set(r.chatId, list);
  }

  type ChatTurns = { turns: Turn[]; resolutions: Date[] };
  const byChannel = new Map<number, ChatTurns[]>();
  const pending: { chatId: number; channelId: number; turn: Turn }[] = [];
  for (const [chatId, chat] of byChat) {
    const resolutions = resolutionsByChat.get(chatId) ?? [];
    const turns = handledByResolution(buildTurns(chat.messages, clock, gapMs), resolutions, clock);
    const list = byChannel.get(chat.channelId) ?? [];
    list.push({ turns, resolutions });
    byChannel.set(chat.channelId, list);
    const last = turns.at(-1);
    if (last && last.repliedAt === null) pending.push({ chatId, channelId: chat.channelId, turn: last });
  }
  const summary = (chats: ChatTurns[]): Summary => ({
    ...summarize(chats.map((c) => c.turns), period, targetMs, clock, now),
    ...resolutionSummary(chats, period, clock),
  });

  const channels = await listChannels(db, shop.id);
  const agentName = new Map(channels.map((c) => [c.id, c.agentName]));
  const stageIds = (outcome: 'won' | 'lost') =>
    shop.pipelineStages.filter((s) => s.outcome === outcome).map((s) => s.id);
  const won = new Map(
    (await closedInPeriod(db, shop.id, stageIds('won'), period.from, period.to)).map((r) => [r.channelId, r]),
  );
  const lost = await closedInPeriod(db, shop.id, stageIds('lost'), period.from, period.to);
  const agents = channels.map((c) => ({
    channelId: c.id,
    agentName: c.agentName,
    phone: c.phone,
    ...summary(byChannel.get(c.id) ?? []),
    wonCount: won.get(c.id)?.count ?? 0,
    wonValue: won.get(c.id)?.value ?? 0,
  }));

  const totals = new Map((await pipelineTotals(db, shop.id)).map((t) => [t.stage, t]));
  const pipeline: PipelineReport = {
    stages: shop.pipelineStages.map((s) => ({
      ...s,
      count: totals.get(s.id)?.count ?? 0,
      value: totals.get(s.id)?.value ?? 0,
    })),
    wonCount: agents.reduce((n, a) => n + a.wonCount, 0),
    wonValue: agents.reduce((n, a) => n + a.wonValue, 0),
    lostCount: lost.reduce((n, r) => n + r.count, 0),
  };

  const contacts = new Map((await chatsById(db, pending.map((p) => p.chatId))).map((c) => [c.id, c]));
  const waiting = pending
    .map(({ chatId, channelId, turn }) => {
      const waitedMs = businessMs(turn.waitingSince, now, clock);
      const contact = contacts.get(chatId);
      return {
        chatId,
        channelId,
        agentName: agentName.get(channelId) ?? '?',
        contactName: contact?.contactName ?? null,
        phone: contact?.remoteJid.split('@')[0] ?? '',
        waitingSince: turn.waitingSince,
        waitedMs,
        overdue: waitedMs > targetMs,
      };
    })
    .sort((a, b) => b.waitedMs - a.waitedMs)
    .slice(0, 50);

  return {
    period,
    targetMinutes: shop.slaTargetMinutes,
    totals: summary([...byChannel.values()].flat()),
    agents,
    waiting,
    pipeline,
  };
}

/**
 * Marking a chat tuntas also handles the customer's last message: a "makasih" that the agent closes
 * without replying shouldn't count as an overdue reply. The resolution time stands in for the reply.
 */
function handledByResolution(turns: Turn[], resolutions: Date[], clock: ShopClock): Turn[] {
  const last = turns.at(-1);
  if (!last || last.repliedAt !== null) return turns;
  const closedAt = resolutions.find((r) => r >= last.waitingSince);
  if (!closedAt) return turns;
  return [
    ...turns.slice(0, -1),
    { ...last, repliedAt: closedAt, responseMs: businessMs(last.waitingSince, closedAt, clock) },
  ];
}
