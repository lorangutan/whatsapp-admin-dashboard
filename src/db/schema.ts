import type { BusinessHours } from '../sla/businessHours.js';

/** Mon–Sat 08:00–17:00, closed Sunday. */
export const defaultBusinessHours: BusinessHours = {
  1: [['08:00', '17:00']],
  2: [['08:00', '17:00']],
  3: [['08:00', '17:00']],
  4: [['08:00', '17:00']],
  5: [['08:00', '17:00']],
  6: [['08:00', '17:00']],
};

export interface Stage {
  id: string;
  name: string;
  /** Closing stages: won counts toward revenue, lost drops out of the active pipeline. */
  outcome?: 'won' | 'lost';
}

/** The usual path of a jewellery sale over WhatsApp, from the counter or after a live session. */
export const defaultStages: Stage[] = [
  { id: 'new', name: 'Baru' },
  { id: 'asked', name: 'Tanya harga' },
  { id: 'model', name: 'Pilih model' },
  { id: 'nego', name: 'Nego' },
  { id: 'keep', name: 'Keep / DP' },
  { id: 'won', name: 'Terjual', outcome: 'won' },
  { id: 'lost', name: 'Batal', outcome: 'lost' },
];

export const defaultQuickReplies = [
  { shortcut: 'salam', body: 'Halo kak, terima kasih sudah menghubungi kami 🙏 Ada yang bisa kami bantu?' },
  { shortcut: 'harga', body: 'Harga emas hari ini kak: 24K Rp … /gr, 22K Rp … /gr, 17K Rp … /gr. Mau dicarikan model yang mana?' },
  { shortcut: 'ready', body: 'Modelnya masih ready kak. Mau dikirim foto/video detail dan beratnya dulu?' },
  {
    shortcut: 'keep',
    body: 'Bisa di-keep 2 hari kak dengan DP 20%. Pelunasan bisa di toko atau transfer, barang dikirim dengan asuransi.',
  },
  { shortcut: 'buyback', body: 'Perhiasan dari toko kami bisa dijual kembali atau tukar tambah kak, bawa barang dan suratnya ya.' },
  { shortcut: 'lokasi', body: 'Toko kami buka Senin–Sabtu 08.00–17.00. Lokasi: (isi alamat & link Google Maps)' },
];

// MySQL / TiDB schema. All DATETIMEs are UTC (the pool sets time_zone = '+00:00').
// Multi-tenant shape from day one (shop_id everywhere), even though the MVP serves one shop.
// One channel = one linked WhatsApp number = one sales agent; a chat is the lead.
// No foreign keys: deletes cascade in code (repo.deleteChannel), which works on every TiDB version.
// Every statement is idempotent, so this doubles as the migration on startup.
export const schemaSql = `
CREATE TABLE IF NOT EXISTS shops (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  name               VARCHAR(120) NOT NULL,
  utc_offset_minutes INT NOT NULL DEFAULT 420,
  business_hours     JSON NOT NULL,
  sla_target_minutes INT NOT NULL DEFAULT 15,
  owner_wa           VARCHAR(32),
  report_time        VARCHAR(5) DEFAULT '20:00',
  pipeline_stages    JSON NOT NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS channels (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  shop_id    INT NOT NULL,
  agent_name VARCHAR(80) NOT NULL,
  phone      VARCHAR(32),
  status     VARCHAR(20) NOT NULL DEFAULT 'disconnected',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_channels_shop (shop_id)
);

CREATE TABLE IF NOT EXISTS chats (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  channel_id       INT NOT NULL,
  remote_jid       VARCHAR(100) NOT NULL,
  contact_name     VARCHAR(255),
  -- summary of the latest message, kept by repo.refreshChat so the inbox reads one row per chat
  last_message_at  DATETIME(3),
  last_body        TEXT,
  last_from_me     BOOLEAN,
  last_kind        VARCHAR(20),
  last_reply_at    DATETIME(3),
  last_read_at     DATETIME(3),
  unread           INT NOT NULL DEFAULT 0,
  -- CRM: stage NULL = not triaged yet, 'none' = explicitly not a lead
  stage            VARCHAR(32),
  stage_changed_at DATETIME(3),
  deal_value       BIGINT,
  interest         VARCHAR(255),
  tags             JSON,
  UNIQUE KEY uq_chats_jid (channel_id, remote_jid),
  KEY idx_chats_last (channel_id, last_message_at)
);

CREATE TABLE IF NOT EXISTS messages (
  id      BIGINT AUTO_INCREMENT PRIMARY KEY,
  chat_id INT NOT NULL,
  wa_id   VARCHAR(100) NOT NULL,
  from_me BOOLEAN NOT NULL,
  kind    VARCHAR(20) NOT NULL DEFAULT 'text',
  body    TEXT,
  sent_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_messages_wa (chat_id, wa_id),
  KEY idx_messages_chat_sent (chat_id, sent_at)
);

CREATE TABLE IF NOT EXISTS notes (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  chat_id    INT NOT NULL,
  body       TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_notes_chat (chat_id)
);

CREATE TABLE IF NOT EXISTS followups (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  chat_id    INT NOT NULL,
  due_at     DATETIME(3) NOT NULL,
  note       VARCHAR(500),
  done_at    DATETIME(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_followups_chat (chat_id),
  KEY idx_followups_open (done_at, due_at)
);

CREATE TABLE IF NOT EXISTS quick_replies (
  id       INT AUTO_INCREMENT PRIMARY KEY,
  shop_id  INT NOT NULL,
  shortcut VARCHAR(40) NOT NULL,
  body     TEXT NOT NULL,
  UNIQUE KEY uq_quick_replies (shop_id, shortcut)
);

-- "Tuntas": each time an agent marks a conversation as solved (or it reaches Deal/Batal).
-- A chat counts as tuntas while its latest resolution is newer than the customer's latest message,
-- so a new message from the customer reopens it by itself. History is kept for the resolution metrics.
CREATE TABLE IF NOT EXISTS resolutions (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  chat_id     INT NOT NULL,
  resolved_at DATETIME(3) NOT NULL,
  KEY idx_resolutions_chat (chat_id, resolved_at)
);

-- Per-shop metric preferences as JSON (see ShopPrefs). A shop with no row uses defaultPrefs.
CREATE TABLE IF NOT EXISTS shop_settings (
  shop_id  INT PRIMARY KEY,
  settings JSON NOT NULL
);

-- Dashboard accounts. Each belongs to one shop and only ever sees that shop's data.
-- The owner login from ADMIN_PASSWORD is not stored here (it always belongs to the first shop).
-- Note: statements are split on semicolons, so comments in this file must not contain one.
CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  shop_id       INT NOT NULL,
  username      VARCHAR(60) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role          VARCHAR(20) NOT NULL DEFAULT 'owner',
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_username (username)
)
`;

/** How a shop wants its metrics judged and shown. */
export interface ShopPrefs {
  /** SLA % at or above this is green… */
  slaGoodPct: number;
  /** …at or above this is amber, below it red. */
  slaWarnPct: number;
  /** Silence longer than this starts a new conversation (first response, tuntas). */
  conversationGapHours: number;
  /** Moving a lead to a Deal/Batal stage marks the chat tuntas. */
  autoResolveOnClose: boolean;
  /** Optional metrics in Laporan and the nightly report; "dibalas tepat waktu" always shows. */
  metrics: { firstResponse: boolean; median: boolean; resolution: boolean; deals: boolean };
  /** WhatsApp the owner when a linked number drops, and again when it is back. */
  alertDisconnect: boolean;
  /** "HH:MM" shop time for the morning to-do list, or null for none. */
  morningTime: string | null;
  /** Also send each salesperson their own list, to the number they linked. */
  morningToSales: boolean;
  /** A lead in a working stage with no message or stage change for this many days counts as gone quiet. */
  staleDays: number;
}

export const defaultPrefs: ShopPrefs = {
  slaGoodPct: 85,
  slaWarnPct: 60,
  conversationGapHours: 24,
  autoResolveOnClose: true,
  metrics: { firstResponse: true, median: true, resolution: true, deals: true },
  alertDisconnect: true,
  morningTime: '08:00',
  morningToSales: false,
  staleDays: 3,
};

/** owner: everything in their shop. demo: explore freely, but no WhatsApp linking, sending or settings. */
export type Role = 'owner' | 'demo';
