import type { FastifyBaseLogger } from 'fastify';
import type { ChannelManager } from '../channels/manager.js';
import type { Db } from '../db/index.js';
import { getShop, listShopIds, type Shop } from '../db/repo.js';
import { localDayStart, toLocalWallClock } from '../sla/businessHours.js';
import { buildReport, shopClock, type Report } from './service.js';

export function formatDuration(ms: number | null): string {
  if (ms === null) return '-';
  const min = Math.round(ms / 60_000);
  if (min < 1) return '<1 mnt';
  if (min < 60) return `${min} mnt`;
  return `${Math.floor(min / 60)}j ${min % 60}m`;
}

/** The owner's end-of-day summary, sent to them on WhatsApp. */
export function formatDailyReport(shop: Shop, report: Report): string {
  const day = toLocalWallClock(report.period.from, shopClock(shop)).toLocaleDateString('id-ID', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const t = report.totals;
  const lines = [
    `📊 *Laporan Chat — ${shop.name}*`,
    day,
    '',
    `Chat masuk: ${t.chats} (${t.conversations} percakapan baru)`,
    `Dibalas ≤${report.targetMinutes} mnt: ${t.slaPct ?? '-'}%`,
    `Rata-rata respon pertama: ${formatDuration(t.avgFirstResponseMs)}`,
    `Masalah tuntas: ${t.resolutionPct ?? '-'}%${t.medianResolutionMs != null ? ` (median ${formatDuration(t.medianResolutionMs)})` : ''}`,
    `Belum dibalas: ${t.overdue + t.waiting}`,
    `Deal: ${report.pipeline.wonCount}` +
      (report.pipeline.wonValue ? ` (Rp ${report.pipeline.wonValue.toLocaleString('id-ID')})` : ''),
  ];

  const ranked = report.agents
    .filter((a) => a.turns > 0)
    .sort((a, b) => (b.slaPct ?? -1) - (a.slaPct ?? -1));
  if (ranked.length) {
    lines.push('', '*Per sales:*');
    ranked.forEach((a, i) => {
      const warn = a.overdue > 0 || (a.slaPct ?? 100) < 70 ? ' ⚠️' : '';
      lines.push(
        `${i + 1}. ${a.agentName} — ${a.slaPct ?? '-'}% · median ${formatDuration(a.medianResponseMs)} · ${a.overdue} telat${warn}`,
      );
    });
  }

  const overdue = report.waiting.filter((w) => w.overdue).slice(0, 5);
  if (overdue.length) {
    lines.push('', '*Masih menunggu balasan:*');
    for (const w of overdue) {
      lines.push(`• ${w.contactName ?? w.phone} (${w.agentName}) — ${formatDuration(w.waitedMs)}`);
    }
  }
  lines.push('', '_Dikirim oleh Wamon_');
  return lines.join('\n');
}

export async function sendDailyReport(db: Db, channels: ChannelManager, shopId: number, now = new Date()) {
  const shop = await getShop(db, shopId);
  if (!shop.ownerWa) throw new Error('Nomor WA owner belum diisi');
  const from = localDayStart(now, shopClock(shop));
  const report = await buildReport(db, shop, { from, to: new Date(from.getTime() + 86_400_000) }, now);
  await channels.sendFromAny(shop.id, shop.ownerWa, formatDailyReport(shop, report));
}

/** Checks once a minute, for every shop, whether it's that shop's report time. */
export function scheduleDailyReport(db: Db, channels: ChannelManager, log: FastifyBaseLogger) {
  const lastSentDay = new Map<number, string>();
  return setInterval(async () => {
    for (const shopId of await listShopIds(db).catch(() => [])) {
      try {
        const shop = await getShop(db, shopId);
        if (!shop.reportTime || !shop.ownerWa) continue;
        const local = toLocalWallClock(new Date(), shopClock(shop)).toISOString(); // YYYY-MM-DDTHH:MM
        const day = local.slice(0, 10);
        if (local.slice(11, 16) !== shop.reportTime || lastSentDay.get(shopId) === day) continue;
        lastSentDay.set(shopId, day);
        await sendDailyReport(db, channels, shopId);
        log.info({ shopId }, 'daily report sent');
      } catch (err) {
        log.error({ err, shopId }, 'daily report failed');
      }
    }
  }, 60_000);
}
