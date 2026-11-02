import { rm } from 'node:fs/promises';
import pino from 'pino';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  fetchLatestWaWebVersion,
  jidNormalizedUser,
  useMultiFileAuthState,
  type Contact,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';
import type { ChannelAdapter, ChannelEvents, InboundMessage } from './types.js';

// Baileys is very chatty; set BAILEYS_LOG_LEVEL=debug when diagnosing connection problems.
const baileysLog = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' });

/**
 * Links one WhatsApp number as a companion device (like WhatsApp Web).
 * Unofficial: fine for a pilot, but the number can be banned. Never use it for bulk sending.
 */
export class BaileysAdapter implements ChannelAdapter {
  private sock: WASocket | null = null;
  private stopped = false;

  constructor(
    private readonly authDir: string,
    private readonly events: ChannelEvents,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.events.onStatus('connecting');
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    // WhatsApp terminates clients that report an outdated version (code 428 right after connecting),
    // so ask web.whatsapp.com for the live version and fall back to Baileys' own list.
    const live = await fetchLatestWaWebVersion().catch(() => null);
    const { version } = live?.isLatest ? live : await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      logger: baileysLog,
      // A "Desktop" fingerprint gets terminated (428) before the QR; the Chrome/WA Web one doesn't.
      browser: Browsers.ubuntu('Chrome'),
      // Don't show agents as "online" just because the monitor is connected.
      markOnlineOnConnect: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        this.events.onQr(qr);
        this.events.onStatus('qr');
      }
      if (connection === 'open') {
        this.events.onStatus('connected', sock.user?.id.split(':')[0].split('@')[0]);
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
          ?.statusCode;
        this.events.onDisconnect?.(code, lastDisconnect?.error?.message);
        if (code === DisconnectReason.loggedOut) {
          await rm(this.authDir, { recursive: true, force: true });
          this.events.onStatus('logged_out');
        } else if (!this.stopped) {
          // Network blips and the post-pairing restart (515) both land here.
          setTimeout(() => void this.start(), 3_000);
        } else {
          this.events.onStatus('disconnected');
        }
      }
    });

    // Recent history the phone shares on link, so the owner sees SLA numbers from day one.
    sock.ev.on('messaging-history.set', ({ messages, contacts, lidPnMappings }) => {
      this.enqueue(async () => {
        if (lidPnMappings?.length) await this.learnMappings(lidPnMappings);
        await this.emitContacts(contacts);
        await this.events.onMessages(await this.convert(messages));
      });
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      // 'notify' = arrived just now; 'append' = catch-up after a reconnect.
      this.enqueue(async () => this.events.onMessages(await this.convert(messages, type === 'notify')));
    });

    sock.ev.on('lid-mapping.update', (mapping) => this.enqueue(() => this.learnMappings([mapping])));
    sock.ev.on('contacts.upsert', (contacts) => this.enqueue(() => this.emitContacts(contacts)));
    sock.ev.on('contacts.update', (contacts) => this.enqueue(() => this.emitContacts(contacts)));
  }

  /** Events are handled one at a time so merges and inserts for the same chat never interleave. */
  private queue: Promise<unknown> = Promise.resolve();
  private enqueue(task: () => Promise<unknown>) {
    this.queue = this.queue.then(task).catch(() => undefined);
  }

  private lidToPn = new Map<string, string>();

  private async learnMappings(mappings: { lid: string; pn: string }[]) {
    const fresh = mappings
      .map((m) => ({ lid: jidNormalizedUser(m.lid), pn: jidNormalizedUser(m.pn) }))
      .filter((m) => m.lid.endsWith('@lid') && m.pn.endsWith('@s.whatsapp.net') && !this.lidToPn.has(m.lid));
    for (const m of fresh) this.lidToPn.set(m.lid, m.pn);
    if (fresh.length) await this.events.onLidMappings?.(fresh);
  }

  /** Phone-number JID for a contact when WhatsApp addressed them by LID and we know the mapping. */
  private async phoneJid(jid: string): Promise<string> {
    if (!jid.endsWith('@lid')) return jid;
    const lid = jidNormalizedUser(jid);
    const known = this.lidToPn.get(lid);
    if (known) return known;
    const pn = await this.sock?.signalRepository.lidMapping.getPNForLID(lid).catch(() => null);
    if (!pn) return lid;
    await this.learnMappings([{ lid, pn }]);
    return jidNormalizedUser(pn);
  }

  async resolveLids(lids: string[]): Promise<void> {
    this.enqueue(async () => {
      for (const lid of lids) await this.phoneJid(lid);
    });
  }

  private async convert(messages: WAMessage[], live = false): Promise<InboundMessage[]> {
    const out: InboundMessage[] = [];
    for (const m of messages) {
      const inbound = toInbound(m);
      if (inbound) out.push({ ...inbound, remoteJid: await this.phoneJid(inbound.remoteJid), live });
    }
    return out;
  }

  private async emitContacts(contacts: Partial<Contact>[]) {
    const named = contacts
      .map((c) => ({
        jids: [c.id, c.lid, c.phoneNumber].filter((j): j is string => Boolean(j)).map(jidNormalizedUser),
        // The name the agent saved ("Pak Rudi Vario") beats the customer's own profile name.
        name: c.name || c.notify || c.verifiedName,
      }))
      .filter((c): c is { jids: string[]; name: string } => Boolean(c.name) && c.jids.length > 0);
    if (named.length) await this.events.onContacts?.(named);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.sock?.end(undefined);
    this.sock = null;
  }

  async logout(): Promise<void> {
    this.stopped = true;
    try {
      await this.sock?.logout();
    } catch {
      // already disconnected
    }
    this.sock = null;
    await rm(this.authDir, { recursive: true, force: true });
  }

  async sendText(to: string, text: string) {
    if (!this.sock) throw new Error('channel not connected');
    const jid = to.includes('@') ? to : `${to.replace(/\D/g, '')}@s.whatsapp.net`;
    const sent = await this.sock.sendMessage(jid, { text });
    return { waId: sent?.key.id ?? `local-${Date.now()}`, sentAt: new Date() };
  }
}

function isPersonalChat(jid: string): boolean {
  return jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid');
}

function toInbound(m: WAMessage): InboundMessage | null {
  const { key, message } = m;
  if (!key.remoteJid || !key.id || !message) return null;
  // Prefer the phone-number JID so the same customer maps to one chat whether WhatsApp
  // addresses them by phone or by LID.
  const remoteJid = [key.remoteJid, key.remoteJidAlt].find((j) => j?.endsWith('@s.whatsapp.net')) ?? key.remoteJid;
  if (!isPersonalChat(remoteJid)) return null; // skip groups, status, channels

  const content = extractContent(message);
  if (!content) return null; // protocol/reaction/receipt noise

  return {
    waId: key.id,
    remoteJid,
    contactName: key.fromMe ? undefined : (m.pushName ?? undefined),
    fromMe: Boolean(key.fromMe),
    kind: content.kind,
    body: content.body,
    sentAt: new Date(Number(m.messageTimestamp ?? 0) * 1000),
  };
}

function extractContent(msg: NonNullable<WAMessage['message']>): { kind: string; body: string | null } | null {
  const inner = msg.ephemeralMessage?.message ?? msg.viewOnceMessage?.message ?? msg;
  if (inner.conversation) return { kind: 'text', body: inner.conversation };
  if (inner.extendedTextMessage) return { kind: 'text', body: inner.extendedTextMessage.text ?? null };
  if (inner.imageMessage) return { kind: 'image', body: inner.imageMessage.caption ?? null };
  if (inner.videoMessage) return { kind: 'video', body: inner.videoMessage.caption ?? null };
  if (inner.audioMessage) return { kind: 'audio', body: null };
  if (inner.documentMessage) return { kind: 'document', body: inner.documentMessage.fileName ?? null };
  if (inner.stickerMessage) return { kind: 'sticker', body: null };
  if (inner.locationMessage) return { kind: 'location', body: inner.locationMessage.name ?? null };
  if (inner.contactMessage) return { kind: 'contact', body: inner.contactMessage.displayName ?? null };
  return null;
}
