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

/** The usual path of a motor bekas sale. */
export const defaultStages: Stage[] = [
  { id: 'new', name: 'Baru' },
  { id: 'asked', name: 'Tanya harga' },
  { id: 'visit', name: 'Survey / test ride' },
  { id: 'nego', name: 'Nego' },
  { id: 'dp', name: 'DP' },
  { id: 'won', name: 'Deal', outcome: 'won' },
  { id: 'lost', name: 'Batal', outcome: 'lost' },
];

export const defaultQuickReplies = [
  { shortcut: 'salam', body: 'Halo kak, terima kasih sudah menghubungi kami 🙏 Ada yang bisa kami bantu?' },
  { shortcut: 'ready', body: 'Unitnya masih ready kak. Mau lihat langsung atau minta foto/video dulu?' },
  {
    shortcut: 'kredit',
    body: 'Bisa kredit kak, DP mulai 2 jutaan tergantung leasing. Boleh info domisili dan pekerjaan untuk simulasinya?',
  },
  { shortcut: 'lokasi', body: 'Showroom kami buka Senin–Sabtu 08.00–17.00. Lokasi: (isi alamat & link Google Maps)' },
  { shortcut: 'surat', body: 'Surat-surat lengkap kak: BPKB, STNK, faktur. Pajak hidup.' },
];

// Multi-tenant shape from day one (shop_id everywhere), even though the MVP serves one shop.
// One channel = one linked WhatsApp number = one sales agent.
// Every statement is idempotent, so this doubles as the migration on startup.
export const schemaSql = `
CREATE TABLE IF NOT EXISTS shops (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  utc_offset_minutes INT  NOT NULL DEFAULT 420,
  business_hours     JSONB NOT NULL,
  sla_target_minutes INT  NOT NULL DEFAULT 15,
  owner_wa           TEXT,
  report_time        TEXT DEFAULT '20:00',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id         SERIAL PRIMARY KEY,
  shop_id    INT  NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  agent_name TEXT NOT NULL,
  phone      TEXT,
  status     TEXT NOT NULL DEFAULT 'disconnected',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chats (
  id              SERIAL PRIMARY KEY,
  channel_id      INT  NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  remote_jid      TEXT NOT NULL,
  contact_name    TEXT,
  last_message_at TIMESTAMPTZ,
  UNIQUE (channel_id, remote_jid)
);

CREATE TABLE IF NOT EXISTS messages (
  id      BIGSERIAL PRIMARY KEY,
  chat_id INT     NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  wa_id   TEXT    NOT NULL,
  from_me BOOLEAN NOT NULL,
  kind    TEXT    NOT NULL DEFAULT 'text',
  body    TEXT,
  sent_at TIMESTAMPTZ NOT NULL,
  UNIQUE (chat_id, wa_id)
);

CREATE INDEX IF NOT EXISTS messages_chat_sent ON messages (chat_id, sent_at);
CREATE INDEX IF NOT EXISTS chats_channel_last ON chats (channel_id, last_message_at DESC);

-- CRM: a chat is the lead. stage NULL = not triaged yet, 'none' = explicitly not a lead.
ALTER TABLE shops ADD COLUMN IF NOT EXISTS pipeline_stages JSONB NOT NULL DEFAULT '${JSON.stringify(defaultStages)}';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS stage            TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS stage_changed_at TIMESTAMPTZ;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS deal_value       BIGINT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS interest         TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS tags             TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS last_read_at     TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS notes (
  id         SERIAL PRIMARY KEY,
  chat_id    INT  NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  body       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS followups (
  id         SERIAL PRIMARY KEY,
  chat_id    INT  NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  due_at     TIMESTAMPTZ NOT NULL,
  note       TEXT,
  done_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS followups_open ON followups (due_at) WHERE done_at IS NULL;

CREATE TABLE IF NOT EXISTS quick_replies (
  id       SERIAL PRIMARY KEY,
  shop_id  INT  NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  shortcut TEXT NOT NULL,
  body     TEXT NOT NULL,
  UNIQUE (shop_id, shortcut)
);
`;
