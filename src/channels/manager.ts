import { existsSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import {
  getShop, lidChatJids, listAllChannels, mergeLidChats, saveMessages, setChannelStatus, setContactNames, shopOf,
} from '../db/repo.js';
import { bus } from '../events.js';
import { opsAlert } from '../ops.js';
import { businessMs } from '../sla/businessHours.js';
import { BaileysAdapter } from './baileys.js';
import type { ChannelAdapter, ChannelStatus } from './types.js';

export class ChannelOfflineError extends Error {
  constructor() {
    super('Nomor WhatsApp untuk chat ini sedang tidak terhubung');
  }
}

interface LiveChannel {
  shopId: number;
  adapter: ChannelAdapter;
  status: ChannelStatus;
  /** QR as a data: URL, ready for an <img>. */
  qr: string | null;
  /** Has a WhatsApp session (linked before, or just now); only these can "drop". */
  linked: boolean;
  /** When a linked number stopped being connected; null while connected. */
  downSince: number | null;
  /** The owner has been told about this outage (or it was logged out, which needs a new QR). */
  alerted: boolean;
  /** Last time a live chat message came through (or when it connected); see checkSilence. */
  lastChatAt: number;
}

/** Network blips reconnect within seconds; only an outage this long is worth waking the owner for. */
const ALERT_AFTER_MS = 5 * 60_000;
/**
 * Twice (19 and 21 Nov 2026) a number showed "connected" while WhatsApp held its chats back for hours.
 * After this much opening time without a single chat, reconnect quietly: a healthy number loses nothing,
 * and a stuck one gets its held chats released.
 */
const SILENT_OPEN_MS = 90 * 60_000;
/** A catch-up batch this soon after a silence reconnect means chats really were held back. */
const HELD_WINDOW_MS = 10 * 60_000;

export class ChannelManager {
  private live = new Map<number, LiveChannel>();
  /** Channels reconnected for silence, and when. */
  private silenceRestarts = new Map<number, number>();
  /** Silence reconnects in a row with no chat in between. */
  private silentStreak = new Map<number, number>();

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  private authDir(channelId: number) {
    return path.resolve(this.dataDir, 'auth', `channel-${channelId}`);
  }

  /** Reconnect every number, in every shop, that was linked before the server restarted. */
  async resumeAll() {
    for (const c of await listAllChannels(this.db)) {
      if (existsSync(this.authDir(c.id))) await this.start(c.id);
      else await setChannelStatus(this.db, c.id, 'disconnected');
    }
  }

  async start(channelId: number) {
    await this.live.get(channelId)?.adapter.stop();
    const shopId = await shopOf(this.db, 'channel', channelId);
    if (shopId === undefined) throw new Error(`channel ${channelId} not found`);
    const linked = existsSync(this.authDir(channelId));
    const entry: LiveChannel = {
      shopId, adapter: null!, status: 'connecting', qr: null, linked, downSince: linked ? Date.now() : null, alerted: false,
      lastChatAt: Date.now(),
    };
    entry.adapter = new BaileysAdapter(this.authDir(channelId), {
      onQr: async (qr) => {
        entry.qr = await QRCode.toDataURL(qr);
        bus.publish({ shopId, type: 'channel', channelId, status: 'qr' });
      },
      onStatus: async (status, phone) => {
        entry.status = status;
        if (status === 'connected') {
          entry.lastChatAt = Date.now();
          entry.qr = null;
          entry.linked = true;
          if (entry.alerted) void this.alertOwner(channelId, entry, 'back');
          entry.downSince = null;
          entry.alerted = false;
        } else if (entry.linked && entry.downSince === null) {
          entry.downSince = Date.now();
        }
        if (status === 'logged_out' && entry.linked && !entry.alerted) {
          // Unlinked from the phone (or banned): it will not come back by itself, so say so right away.
          entry.alerted = true;
          void this.alertOwner(channelId, entry, 'logged_out');
          void this.ops(channelId, 'logged_out', (who) => `${who}: logout dari HP (atau diblokir). Perlu scan ulang QR.`);
        }
        await setChannelStatus(this.db, channelId, status, phone);
        this.log.info({ channelId, status }, 'channel status');
        bus.publish({ shopId, type: 'channel', channelId, status });
        if (status === 'connected') {
          const lids = await lidChatJids(this.db, channelId);
          if (lids.length) await entry.adapter.resolveLids?.(lids);
        }
      },
      onDisconnect: (code, reason) => {
        this.log.warn({ channelId, code, reason }, 'channel disconnected');
      },
      onStatusAcks: (count) => {
        this.log.info({ channelId, count }, 'status stanzas acknowledged');
      },
      onReceived: (info) => {
        this.log.info({ channelId, ...info }, 'whatsapp batch received');
        if (!info.chats) return;
        if (info.type === 'notify') {
          entry.lastChatAt = Date.now();
          this.silentStreak.delete(channelId);
        }
        const restartedAt = this.silenceRestarts.get(channelId);
        if (info.type === 'append' && restartedAt && Date.now() - restartedAt < HELD_WINDOW_MS) {
          this.silenceRestarts.delete(channelId);
          void this.ops(channelId, 'held', (who) =>
            `${who}: WhatsApp menahan chat yang masuk. Sudah disambung ulang otomatis dan ${info.chats} pesan tertahan sudah masuk. Kalau sering terjadi, cek log.`);
        }
      },
      onQueueProblem: (step, problem) => {
        this.log.error({ channelId, step, problem }, 'whatsapp event step skipped');
        void this.ops(channelId, `step:${step}`, (who) => `${who}: langkah "${step}" dilewati (${problem}). Pesan bisa terlambat.`);
      },
      onContacts: async (contacts) => {
        try {
          await setContactNames(this.db, channelId, contacts);
        } catch (err) {
          this.log.error({ err, channelId }, 'failed to store contact names');
        }
      },
      onLidMappings: async (mappings) => {
        try {
          const merged = await mergeLidChats(this.db, channelId, mappings);
          if (merged) this.log.info({ channelId, merged }, 'merged LID chats into phone-number chats');
        } catch (err) {
          this.log.error({ err, channelId }, 'failed to merge LID chats');
        }
      },
      onMessages: async (messages) => {
        if (!messages.length) return;
        try {
          const chatIds = await saveMessages(this.db, channelId, messages);
          if (chatIds.length) bus.publish({ shopId, type: 'messages', chatIds });
        } catch (err) {
          this.log.error({ err, channelId }, 'failed to store messages');
          void this.ops(channelId, 'save', (who) =>
            `${who}: ${messages.length} pesan GAGAL disimpan (${(err as Error).message.slice(0, 120)}). Cek database.`);
        }
      },
    });
    this.live.set(channelId, entry);
    await entry.adapter.start();
  }

  /** `down`: a linked number that has been offline long enough to alert about, or was logged out. */
  state(channelId: number): { status: ChannelStatus; qr: string | null; down: boolean; downSince: Date | null } | undefined {
    const e = this.live.get(channelId);
    if (!e) return undefined;
    const down = e.downSince !== null && (e.status === 'logged_out' || Date.now() - e.downSince >= ALERT_AFTER_MS);
    return { status: e.status, qr: e.qr, down, downSince: e.downSince === null ? null : new Date(e.downSince) };
  }

  /** Checks every minute for linked numbers that have been down for ALERT_AFTER_MS, or silent too long. */
  watch(): NodeJS.Timeout {
    return setInterval(() => {
      for (const [channelId, e] of this.live) {
        if (e.status === 'connected') void this.checkSilence(channelId, e);
        if (e.alerted || e.downSince === null || Date.now() - e.downSince < ALERT_AFTER_MS) continue;
        e.alerted = true;
        bus.publish({ shopId: e.shopId, type: 'channel', channelId, status: e.status });
        void this.alertOwner(channelId, e, 'down');
        void this.ops(channelId, 'down', (who) => `${who}: terputus lebih dari 5 menit.`);
      }
    }, 60_000);
  }

  /** "Connected" yet no chat for SILENT_OPEN_MS of opening hours: reconnect quietly (keeps the session). */
  private async checkSilence(channelId: number, e: LiveChannel) {
    try {
      const shop = await getShop(this.db, e.shopId);
      const clock = { utcOffsetMinutes: shop.utcOffsetMinutes, hours: shop.businessHours };
      if (businessMs(new Date(e.lastChatAt), new Date(), clock) < SILENT_OPEN_MS) return;
      if (this.live.get(channelId) !== e || e.status !== 'connected') return; // changed meanwhile
      this.log.warn({ channelId, silentSince: new Date(e.lastChatAt) }, 'channel silent, reconnecting');
      this.silenceRestarts.set(channelId, Date.now());
      const streak = (this.silentStreak.get(channelId) ?? 0) + 1;
      this.silentStreak.set(channelId, streak);
      // A quiet shop can go 90 minutes without a chat; three times running during opening hours can't be normal.
      if (streak >= 3) {
        void this.ops(channelId, 'silent', (who) =>
          `${who}: tidak ada chat masuk selama ${(streak * SILENT_OPEN_MS) / 3_600_000} jam jam buka, walau statusnya terhubung. Sudah disambung ulang ${streak}x. Cek HP-nya atau scan ulang QR.`);
      }
      await this.start(channelId);
    } catch (err) {
      this.log.warn({ err: (err as Error).message, channelId }, 'silence check failed');
    }
  }

  private async ops(channelId: number, kind: string, text: (who: string) => string) {
    let who = `#${channelId}`;
    try {
      const shopId = this.live.get(channelId)?.shopId ?? (await shopOf(this.db, 'channel', channelId));
      if (shopId !== undefined) who = `${(await getShop(this.db, shopId)).name} #${channelId}`;
    } catch {
      // the alert matters more than the name
    }
    opsAlert(this.log, `${kind}:${channelId}`, text(who));
  }

  private async alertOwner(channelId: number, e: LiveChannel, kind: 'down' | 'logged_out' | 'back') {
    try {
      const shop = await getShop(this.db, e.shopId);
      if (!shop.prefs.alertDisconnect || !shop.ownerWa) return;
      const c = (await listAllChannels(this.db)).find((x) => x.id === channelId);
      const name = c ? `${c.agentName}${c.phone ? ` (${c.phone})` : ''}` : `#${channelId}`;
      const since = e.downSince === null ? '' : new Date(e.downSince + shop.utcOffsetMinutes * 60_000).toISOString().slice(11, 16);
      const text =
        kind === 'back'
          ? `✅ *Wamon*: nomor ${name} sudah tersambung lagi. Chat baru masuk seperti biasa.`
          : kind === 'logged_out'
            ? `⚠️ *Wamon*: nomor ${name} keluar dari perangkat tertaut (logout atau diblokir WhatsApp). Chat baru dari nomor ini tidak masuk ke Wamon.

Buka menu *Nomor WA* lalu scan ulang QR.`
            : `⚠️ *Wamon*: nomor ${name} terputus sejak ${since}. Chat baru dari nomor ini tidak masuk ke Wamon.

Cek HP-nya masih online, atau buka menu *Nomor WA* lalu scan ulang QR.`;
      await this.sendFromAny(e.shopId, shop.ownerWa, text, channelId);
      this.log.info({ channelId, kind }, 'owner alerted about channel');
    } catch (err) {
      // Usually: no other number of the shop is connected to send from. The dashboard banner still shows.
      this.log.warn({ err: (err as Error).message, channelId, kind }, 'could not alert owner about channel');
    }
  }

  async remove(channelId: number) {
    const e = this.live.get(channelId);
    // Removed on purpose: the logout that follows is not an outage.
    if (e) Object.assign(e, { linked: false, downSince: null, alerted: true });
    await e?.adapter.logout();
    this.live.delete(channelId);
  }

  /**
   * Re-link the same number with a fresh QR, keeping its chats, pipeline and notes: only this device's
   * WhatsApp session is thrown away. The history WhatsApp sends after the scan skips what is already stored.
   */
  async relink(channelId: number) {
    await this.remove(channelId);
    await this.start(channelId);
  }

  /** Reply in a chat from the number that owns it, and store the sent message right away. */
  async reply(channelId: number, remoteJid: string, text: string) {
    const entry = this.live.get(channelId);
    if (!entry || entry.status !== 'connected') throw new ChannelOfflineError();
    const { waId, sentAt } = await entry.adapter.sendText(remoteJid, text);
    // The echo from messages.upsert carries the same id and is ignored as a duplicate.
    const chatIds = await saveMessages(this.db, channelId, [
      { waId, remoteJid, fromMe: true, kind: 'text', body: text, sentAt },
    ]);
    bus.publish({ shopId: entry.shopId, type: 'messages', chatIds });
    return { waId, sentAt };
  }

  /** Send from a connected number of the shop, preferably not `avoidChannelId` (the recipient's own, or the one that dropped). */
  async sendFromAny(shopId: number, toPhone: string, text: string, avoidChannelId?: number) {
    const connected = [...this.live].filter(([, e]) => e.shopId === shopId && e.status === 'connected');
    const entry = (connected.find(([id]) => id !== avoidChannelId) ?? connected[0])?.[1];
    if (!entry) throw new Error('Tidak ada nomor WA yang terhubung untuk mengirim pesan');
    await entry.adapter.sendText(toPhone, text);
  }

  async stopAll() {
    await Promise.all([...this.live.values()].map((e) => e.adapter.stop()));
  }
}
