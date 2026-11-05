// The morning to-do list: what each salesperson (and the owner, for everyone) should handle today.
// The same data feeds the "Hari ini" card in the dashboard and the WhatsApp message at morningTime.
import type { ChannelManager } from '../channels/manager.js';
import type { Db } from '../db/index.js';
import { getShop, listChannels, listFollowups, staleLeads, type Shop } from '../db/repo.js';
import { DAY, localDayStart, toLocalWallClock } from '../sla/businessHours.js';
import { formatDuration } from './daily.js';
import { buildReport, shopClock } from './service.js';

interface Item {
  chatId: number;
  channelId: number;
  agentName: string;
  contactName: string | null;
  phone: string;
}

export interface TodayList {
  /** Shop-local date, YYYY-MM-DD. */
  day: string;
  followups: (Item & { id: number; dueAt: Date; note: string | null; overdue: boolean })[];
  waiting: (Item & { waitedMs: number; overdue: boolean })[];
  stale: (Item & { stage: string; stageName: string; idleDays: number })[];
  /** Linked numbers that are not connected right now. */
  offline: { channelId: number; agentName: string; phone: string | null }[];
  staleDays: number;
}

const phoneOf = (jid: string) => jid.split('@')[0];

export async function buildToday(db: Db, shop: Shop, channels: ChannelManager, now = new Date()): Promise<TodayList> {
  const clock = shopClock(shop);
  const dayStart = localDayStart(now, clock);
  const dayEnd = new Date(dayStart.getTime() + DAY);

  const followups = (await listFollowups(db, shop.id))
    .filter((f) => new Date(f.dueAt) < dayEnd)
    .map((f) => ({
      id: f.id,
      chatId: f.chatId,
      channelId: f.channelId,
      agentName: f.agentName,
      contactName: f.contactName,
      phone: phoneOf(f.remoteJid),
      dueAt: f.dueAt,
      note: f.note,
      overdue: new Date(f.dueAt) < dayStart,
    }));

  const report = await buildReport(db, shop, { from: dayStart, to: dayEnd }, now);
  const waiting = report.waiting.map((w) => ({
    chatId: w.chatId,
    channelId: w.channelId,
    agentName: w.agentName,
    contactName: w.contactName,
    phone: w.phone,
    waitedMs: w.waitedMs,
    overdue: w.overdue,
  }));

  const working = shop.pipelineStages.filter((s) => !s.outcome);
  const idleSince = new Date(now.getTime() - shop.prefs.staleDays * DAY);
  const stale = (await staleLeads(db, shop.id, working.map((s) => s.id), idleSince)).map((l) => ({
    chatId: l.chatId,
    channelId: l.channelId,
    agentName: l.agentName,
    contactName: l.contactName,
    phone: phoneOf(l.remoteJid),
    stage: l.stage,
    stageName: working.find((s) => s.id === l.stage)?.name ?? l.stage,
    idleDays: Math.floor((now.getTime() - new Date(l.lastActivityAt).getTime()) / DAY),
  }));

  const offline = (await listChannels(db, shop.id))
    .filter((c) => channels.state(c.id)?.down)
    .map((c) => ({ channelId: c.id, agentName: c.agentName, phone: c.phone }));

  return {
    day: toLocalWallClock(now, clock).toISOString().slice(0, 10),
    followups,
    waiting,
    stale,
    offline,
    staleDays: shop.prefs.staleDays,
  };
}

/** Only one salesperson's part of the list. */
export function forChannel(list: TodayList, channelId: number): TodayList {
  return {
    ...list,
    followups: list.followups.filter((x) => x.channelId === channelId),
    waiting: list.waiting.filter((x) => x.channelId === channelId),
    stale: list.stale.filter((x) => x.channelId === channelId),
    offline: list.offline.filter((x) => x.channelId === channelId),
  };
}

export const isEmpty = (l: TodayList) => !l.followups.length && !l.waiting.length && !l.stale.length && !l.offline.length;

const MAX = 5;

/** WhatsApp text. `forAgent` drops the "(sales name)" from each line, since it is all theirs. */
export function formatToday(shop: Shop, list: TodayList, opts: { title: string; forAgent?: boolean }): string {
  const clock = shopClock(shop);
  const day = new Date(`${list.day}T00:00:00Z`).toLocaleDateString('id-ID', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
  });
  const who = (x: Item) => `${x.contactName ?? x.phone}${opts.forAgent ? '' : ` (${x.agentName})`}`;
  const more = (n: number) => (n > MAX ? [`  _+${n - MAX} lainnya_`] : []);
  const lines = [`☀️ *${opts.title}*`, day];

  for (const o of list.offline) {
    lines.push('', `⚠️ Nomor ${o.agentName} terputus dari Wamon, chat baru tidak masuk. Scan ulang QR di menu Nomor WA.`);
  }
  if (list.followups.length) {
    lines.push('', `*Follow-up (${list.followups.length})*`);
    for (const f of list.followups.slice(0, MAX)) {
      const when = f.overdue
        ? 'terlambat'
        : toLocalWallClock(new Date(f.dueAt), clock).toISOString().slice(11, 16);
      lines.push(`• ${who(f)} — ${when}${f.note ? ` · ${f.note}` : ''}`);
    }
    lines.push(...more(list.followups.length));
  }
  if (list.waiting.length) {
    lines.push('', `*Belum dibalas (${list.waiting.length})*`);
    for (const w of list.waiting.slice(0, MAX)) lines.push(`• ${who(w)} — menunggu ${formatDuration(w.waitedMs)}`);
    lines.push(...more(list.waiting.length));
  }
  if (list.stale.length) {
    lines.push('', `*Lead diam > ${list.staleDays} hari (${list.stale.length})*`);
    for (const s of list.stale.slice(0, MAX)) lines.push(`• ${who(s)} — ${s.stageName}, ${s.idleDays} hari`);
    lines.push(...more(list.stale.length));
  }
  if (isEmpty(list)) lines.push('', 'Tidak ada yang tertunda. Semangat hari ini! 💪');
  lines.push('', '_Dikirim oleh Wamon_');
  return lines.join('\n');
}

/** Sends the owner the whole list, and (if the shop wants) each salesperson their own part. */
export async function sendMorningList(db: Db, channels: ChannelManager, shopId: number, now = new Date()) {
  const shop = await getShop(db, shopId);
  const list = await buildToday(db, shop, channels, now);
  const sent: string[] = [];
  if (shop.ownerWa) {
    await channels.sendFromAny(shop.id, shop.ownerWa, formatToday(shop, list, { title: `Hari ini — ${shop.name}` }));
    sent.push('owner');
  }
  if (shop.prefs.morningToSales) {
    for (const c of await listChannels(db, shop.id)) {
      const mine = forChannel(list, c.id);
      // Skip numbers that are not linked, and the owner's own number (they already got everything).
      if (!c.phone || c.phone === shop.ownerWa || isEmpty(mine)) continue;
      await channels.sendFromAny(shop.id, c.phone, formatToday(shop, mine, { title: `Hari ini — ${c.agentName}`, forAgent: true }), c.id);
      sent.push(c.agentName);
    }
  }
  if (!sent.length) throw new Error('Nomor WA owner belum diisi');
  return sent;
}
