/**
 * Everything WhatsApp-specific sits behind this interface, so the unofficial Baileys pilot can be
 * swapped for the official Cloud API (with Coexistence) without touching storage or SLA code.
 */
export interface ChannelAdapter {
  start(): Promise<void>;
  /** Close the socket but keep the session, so the number reconnects on next start. */
  stop(): Promise<void>;
  /** Unlink the device and forget the session. */
  logout(): Promise<void>;
  /** `to` is a JID or a bare phone number. Returns the WhatsApp message id. */
  sendText(to: string, text: string): Promise<{ waId: string; sentAt: Date }>;
  /** Look up phone numbers for LIDs stored earlier; reported through onLidMappings. */
  resolveLids?(lids: string[]): Promise<void>;
}

export type ChannelStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'logged_out';

export interface InboundMessage {
  waId: string;
  /** Stable per-contact id; the phone JID when known, otherwise WhatsApp's LID. */
  remoteJid: string;
  /** The customer's WhatsApp display name; only set on messages they sent. */
  contactName?: string;
  fromMe: boolean;
  kind: string;
  body: string | null;
  sentAt: Date;
  /** Arrived in real time (not from the history sync); only live chats are captured as new leads. */
  live?: boolean;
}

export interface ChannelEvents {
  onQr(qr: string): void;
  onStatus(status: ChannelStatus, phone?: string): void;
  onMessages(messages: InboundMessage[]): void | Promise<void>;
  onDisconnect?(code: number | undefined, reason: string | undefined): void;
  /** Names from the phone's address book or the contact's profile; `jids` covers both phone and LID forms. */
  onContacts?(contacts: { jids: string[]; name: string }[]): void | Promise<void>;
  /** WhatsApp revealed which phone number hides behind a LID; chats stored under the LID should merge. */
  onLidMappings?(mappings: { lid: string; pn: string }[]): void | Promise<void>;
}
