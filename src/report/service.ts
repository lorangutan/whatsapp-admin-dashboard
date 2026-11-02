import type { Db } from '../db/index.js';
import { chatsById, closedInPeriod, listChannels, loadSlaRows, pipelineTotals, type Shop } from '../db/repo.js';
import type { Stage } from '../db/schema.js';
import { businessMs, MINUTE, type ShopClock } from '../sla/businessHours.js';
import { buildTurns, CONVERSATION_GAP_MS, type Turn } from '../sla/turns.js';
import { summarize, type Period, type SlaSummary } from '../sla/summary.js';

export interface AgentReport extends SlaSummary {
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
  totals: SlaSummary;
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
  const rows = await loadSlaRows(db, shop.id, new Date(period.from.getTime() - CONVERSATION_GAP_MS));

  const byChat = new Map<number, { channelId: number; messages: { fromMe: boolean; sentAt: Date }[] }>();
  for (const r of rows) {
    let chat = byChat.get(r.chatId);
    if (!chat) byChat.set(r.chatId, (chat = { channelId: r.channelId, messages: [] }));
    chat.messages.push({ fromMe: r.fromMe, sentAt: new Date(r.sentAt) });
  }

  const turnsByChannel = new Map<number, Turn[][]>();
  const pending: { chatId: number; channelId: number; turn: Turn }[] = [];
  for (const [chatId, chat] of byChat) {
    const turns = buildTurns(chat.messages, clock);
    const list = turnsByChannel.get(chat.channelId) ?? [];
    list.push(turns);
    turnsByChannel.set(chat.channelId, list);
    const last = turns.at(-1);
    if (last && last.repliedAt === null) pending.push({ chatId, channelId: chat.channelId, turn: last });
  }

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
    ...summarize(turnsByChannel.get(c.id) ?? [], period, targetMs, clock, now),
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
    totals: summarize([...turnsByChannel.values()].flat(), period, targetMs, clock, now),
    agents,
    waiting,
    pipeline,
  };
}
