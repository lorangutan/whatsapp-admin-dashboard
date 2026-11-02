import { existsSync } from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { lidChatJids, listChannels, mergeLidChats, saveMessages, setChannelStatus, setContactNames } from '../db/repo.js';
import { bus } from '../events.js';
import { BaileysAdapter } from './baileys.js';
import type { ChannelAdapter, ChannelStatus } from './types.js';

export class ChannelOfflineError extends Error {
  constructor() {
    super('Nomor WhatsApp untuk chat ini sedang tidak terhubung');
  }
}

interface LiveChannel {
  adapter: ChannelAdapter;
  status: ChannelStatus;
  /** QR as a data: URL, ready for an <img>. */
  qr: string | null;
}

export class ChannelManager {
  private live = new Map<number, LiveChannel>();

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    private readonly log: FastifyBaseLogger,
  ) {}

  private authDir(channelId: number) {
    return path.resolve(this.dataDir, 'auth', `channel-${channelId}`);
  }

  /** Reconnect every number that was linked before the server restarted. */
  async resumeAll(shopId: number) {
    for (const c of await listChannels(this.db, shopId)) {
      if (existsSync(this.authDir(c.id))) await this.start(c.id);
      else await setChannelStatus(this.db, c.id, 'disconnected');
    }
  }

  async start(channelId: number) {
    await this.live.get(channelId)?.adapter.stop();
    const entry: LiveChannel = { adapter: null!, status: 'connecting', qr: null };
    entry.adapter = new BaileysAdapter(this.authDir(channelId), {
      onQr: async (qr) => {
        entry.qr = await QRCode.toDataURL(qr);
        bus.publish({ type: 'channel', channelId, status: 'qr' });
      },
      onStatus: async (status, phone) => {
        entry.status = status;
        if (status === 'connected') entry.qr = null;
        await setChannelStatus(this.db, channelId, status, phone);
        this.log.info({ channelId, status }, 'channel status');
        bus.publish({ type: 'channel', channelId, status });
        if (status === 'connected') {
          const lids = await lidChatJids(this.db, channelId);
          if (lids.length) await entry.adapter.resolveLids?.(lids);
        }
      },
      onDisconnect: (code, reason) => {
        this.log.warn({ channelId, code, reason }, 'channel disconnected');
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
          if (chatIds.length) bus.publish({ type: 'messages', chatIds });
        } catch (err) {
          this.log.error({ err, channelId }, 'failed to store messages');
        }
      },
    });
    this.live.set(channelId, entry);
    await entry.adapter.start();
  }

  state(channelId: number): { status: ChannelStatus; qr: string | null } | undefined {
    const e = this.live.get(channelId);
    return e && { status: e.status, qr: e.qr };
  }

  async remove(channelId: number) {
    await this.live.get(channelId)?.adapter.logout();
    this.live.delete(channelId);
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
    bus.publish({ type: 'messages', chatIds });
    return { waId, sentAt };
  }

  /** Send from any connected number; used for the owner's daily report. */
  async sendFromAny(toPhone: string, text: string) {
    const entry = [...this.live.values()].find((e) => e.status === 'connected');
    if (!entry) throw new Error('no connected WhatsApp number to send from');
    await entry.adapter.sendText(toPhone, text);
  }

  async stopAll() {
    await Promise.all([...this.live.values()].map((e) => e.adapter.stop()));
  }
}
