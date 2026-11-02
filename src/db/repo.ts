import type { Db } from './index.js';
import type { InboundMessage, ChannelStatus } from '../channels/types.js';
import type { BusinessHours } from '../sla/businessHours.js';
import type { Stage } from './schema.js';

export interface Shop {
  id: number;
  name: string;
  utcOffsetMinutes: number;
  businessHours: BusinessHours;
  slaTargetMinutes: number;
  ownerWa: string | null;
  reportTime: string | null;
  pipelineStages: Stage[];
}

export interface Channel {
  id: number;
  shopId: number;
  agentName: string;
  phone: string | null;
  status: ChannelStatus;
}

export async function getShop(db: Db): Promise<Shop> {
  const [r] = await db.query<Record<string, any>>('SELECT * FROM shops ORDER BY id LIMIT 1');
  return {
    id: r.id,
    name: r.name,
    utcOffsetMinutes: r.utc_offset_minutes,
    businessHours: typeof r.business_hours === 'string' ? JSON.parse(r.business_hours) : r.business_hours,
    slaTargetMinutes: r.sla_target_minutes,
    ownerWa: r.owner_wa,
    reportTime: r.report_time,
    pipelineStages: typeof r.pipeline_stages === 'string' ? JSON.parse(r.pipeline_stages) : r.pipeline_stages,
  };
}

export async function updateShop(db: Db, id: number, patch: Partial<Omit<Shop, 'id'>>): Promise<void> {
  const columns: Record<string, unknown> = {
    name: patch.name,
    utc_offset_minutes: patch.utcOffsetMinutes,
    business_hours: patch.businessHours && JSON.stringify(patch.businessHours),
    sla_target_minutes: patch.slaTargetMinutes,
    owner_wa: patch.ownerWa,
    report_time: patch.reportTime,
    pipeline_stages: patch.pipelineStages && JSON.stringify(patch.pipelineStages),
  };
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (!set.length) return;
  await db.query(
    `UPDATE shops SET ${set.map(([k], i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...set.map(([, v]) => v)],
  );
}

const channelCols = 'id, shop_id AS "shopId", agent_name AS "agentName", phone, status';

export function listChannels(db: Db, shopId: number): Promise<Channel[]> {
  return db.query<Channel>(`SELECT ${channelCols} FROM channels WHERE shop_id = $1 ORDER BY id`, [shopId]);
}

export async function createChannel(db: Db, shopId: number, agentName: string): Promise<Channel> {
  const [c] = await db.query<Channel>(
    `INSERT INTO channels (shop_id, agent_name) VALUES ($1, $2) RETURNING ${channelCols}`,
    [shopId, agentName],
  );
  return c;
}

export async function setChannelStatus(db: Db, id: number, status: ChannelStatus, phone?: string) {
  await db.query('UPDATE channels SET status = $2, phone = COALESCE($3, phone) WHERE id = $1', [
    id,
    status,
    phone ?? null,
  ]);
}

export async function deleteChannel(db: Db, id: number) {
  await db.query('DELETE FROM channels WHERE id = $1', [id]);
}

/**
 * Stores messages (duplicates are ignored). A live message from a customer whose chat hasn't been
 * triaged yet turns the chat into a new lead — that's the automatic lead capture.
 * Returns the ids of chats that received new messages.
 */
export async function saveMessages(db: Db, channelId: number, messages: InboundMessage[]): Promise<number[]> {
  const chatIds = new Map<string, number>();
  const touched = new Set<number>();
  for (const m of messages) {
    let chatId = chatIds.get(m.remoteJid);
    if (chatId === undefined || m.contactName) {
      const [row] = await db.query<{ id: number }>(
        `INSERT INTO chats (channel_id, remote_jid, contact_name, last_message_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id, remote_jid) DO UPDATE SET
           -- Keep an existing name: an address-book name from setContactNames beats a pushName.
           contact_name    = COALESCE(chats.contact_name, EXCLUDED.contact_name),
           last_message_at = GREATEST(chats.last_message_at, EXCLUDED.last_message_at)
         RETURNING id`,
        [channelId, m.remoteJid, m.contactName ?? null, m.sentAt],
      );
      chatId = row.id;
      chatIds.set(m.remoteJid, chatId);
    } else {
      await db.query('UPDATE chats SET last_message_at = GREATEST(last_message_at, $2) WHERE id = $1', [
        chatId,
        m.sentAt,
      ]);
    }
    const rows = await db.query(
      `INSERT INTO messages (chat_id, wa_id, from_me, kind, body, sent_at) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (chat_id, wa_id) DO NOTHING RETURNING id`,
      [chatId, m.waId, m.fromMe, m.kind, m.body, m.sentAt],
    );
    if (!rows.length) continue;
    touched.add(chatId);
    if (m.live && !m.fromMe) {
      await db.query(`UPDATE chats SET stage = 'new', stage_changed_at = $2 WHERE id = $1 AND stage IS NULL`, [
        chatId,
        m.sentAt,
      ]);
    }
  }
  return [...touched];
}

export async function setContactNames(db: Db, channelId: number, contacts: { jids: string[]; name: string }[]) {
  for (const c of contacts) {
    await db.query('UPDATE chats SET contact_name = $3 WHERE channel_id = $1 AND remote_jid = ANY($2::text[])', [
      channelId,
      c.jids,
      c.name,
    ]);
  }
}

/**
 * Folds chats stored under a LID into the phone-number chat for the same person.
 * Returns how many LID chats were merged or renamed.
 */
export async function mergeLidChats(db: Db, channelId: number, mappings: { lid: string; pn: string }[]) {
  let merged = 0;
  for (const { lid, pn } of mappings) {
    const rows = await db.query<{ id: number; remote_jid: string; contact_name: string | null }>(
      'SELECT id, remote_jid, contact_name FROM chats WHERE channel_id = $1 AND remote_jid = ANY($2::text[])',
      [channelId, [lid, pn]],
    );
    const lidChat = rows.find((r) => r.remote_jid === lid);
    const pnChat = rows.find((r) => r.remote_jid === pn);
    if (!lidChat) continue;
    merged++;
    if (!pnChat) {
      await db.query('UPDATE chats SET remote_jid = $2 WHERE id = $1', [lidChat.id, pn]);
      continue;
    }
    // The same message can be stored under both ids; drop the copy before moving the rest.
    await db.query(
      `DELETE FROM messages WHERE chat_id = $1 AND wa_id IN (SELECT wa_id FROM messages WHERE chat_id = $2)`,
      [lidChat.id, pnChat.id],
    );
    await db.query('UPDATE messages SET chat_id = $2 WHERE chat_id = $1', [lidChat.id, pnChat.id]);
    await db.query(
      `UPDATE chats SET
         contact_name    = COALESCE(contact_name, $2),
         last_message_at = (SELECT max(sent_at) FROM messages WHERE chat_id = $1)
       WHERE id = $1`,
      [pnChat.id, lidChat.contact_name],
    );
    await db.query('DELETE FROM chats WHERE id = $1', [lidChat.id]);
  }
  return merged;
}

export async function lidChatJids(db: Db, channelId: number): Promise<string[]> {
  const rows = await db.query<{ remote_jid: string }>(
    `SELECT remote_jid FROM chats WHERE channel_id = $1 AND remote_jid LIKE '%@lid'`,
    [channelId],
  );
  return rows.map((r) => r.remote_jid);
}

export interface ChatListItem {
  id: number;
  channelId: number;
  agentName: string;
  channelStatus: ChannelStatus;
  remoteJid: string;
  contactName: string | null;
  lastMessageAt: Date | null;
  lastBody: string | null;
  lastFromMe: boolean | null;
  lastKind: string | null;
  stage: string | null;
  stageChangedAt: Date | null;
  dealValue: number | null;
  interest: string | null;
  tags: string[];
  /** Customer messages since the last reply that nobody has opened in the dashboard yet. */
  unread: number;
  nextFollowupAt: Date | null;
}

export interface ChatFilter {
  id?: number;
  channelId?: number;
  q?: string;
  /** 'lead' = any active lead, otherwise a stage id. */
  stage?: string;
  /** Only chats whose last message is from the customer. */
  unreplied?: boolean;
  /** Cursor for infinite scroll: chats last active before this instant. */
  before?: Date;
  limit?: number;
}

export function listChats(db: Db, shopId: number, f: ChatFilter = {}): Promise<ChatListItem[]> {
  return db.query<ChatListItem>(
    `SELECT c.id, c.channel_id AS "channelId", ch.agent_name AS "agentName", ch.status AS "channelStatus",
            c.remote_jid AS "remoteJid", c.contact_name AS "contactName", c.last_message_at AS "lastMessageAt",
            last.body AS "lastBody", last.from_me AS "lastFromMe", last.kind AS "lastKind",
            c.stage, c.stage_changed_at AS "stageChangedAt", c.deal_value::float8 AS "dealValue",
            c.interest, c.tags, COALESCE(unread.n, 0)::int AS unread, fu.due_at AS "nextFollowupAt"
       FROM chats c
       JOIN channels ch ON ch.id = c.channel_id
       LEFT JOIN LATERAL (
         SELECT body, from_me, kind FROM messages m WHERE m.chat_id = c.id ORDER BY sent_at DESC LIMIT 1
       ) last ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS n FROM messages m
          WHERE m.chat_id = c.id AND NOT m.from_me
            AND m.sent_at > GREATEST(
              COALESCE(c.last_read_at, '-infinity'::timestamptz),
              COALESCE((SELECT max(sent_at) FROM messages r WHERE r.chat_id = c.id AND r.from_me), '-infinity'::timestamptz))
       ) unread ON true
       LEFT JOIN LATERAL (
         SELECT min(due_at) AS due_at FROM followups f WHERE f.chat_id = c.id AND f.done_at IS NULL
       ) fu ON true
      WHERE ch.shop_id = $1
        AND ($2::int IS NULL OR c.channel_id = $2)
        AND ($3::text IS NULL OR c.contact_name ILIKE $3 OR c.remote_jid ILIKE $3 OR c.interest ILIKE $3)
        AND ($4::text IS NULL OR ($4 = 'lead' AND c.stage IS NOT NULL AND c.stage <> 'none') OR c.stage = $4)
        AND (NOT $5::boolean OR last.from_me = false)
        AND ($6::timestamptz IS NULL OR c.last_message_at < $6)
        AND ($8::int IS NULL OR c.id = $8)
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $7`,
    [
      shopId,
      f.channelId ?? null,
      f.q ? `%${f.q}%` : null,
      f.stage ?? null,
      f.unreplied ?? false,
      f.before ?? null,
      f.limit ?? 60,
      f.id ?? null,
    ],
  );
}

export async function getChat(db: Db, shopId: number, id: number): Promise<ChatListItem | undefined> {
  const [chat] = await listChats(db, shopId, { id, limit: 1 });
  return chat;
}

export interface StoredMessage {
  id: string;
  waId: string;
  fromMe: boolean;
  kind: string;
  body: string | null;
  sentAt: Date;
}

/** The latest `limit` messages before `before`, oldest first (for upward infinite scroll). */
export function getMessages(db: Db, chatId: number, before?: Date, limit = 80) {
  return db.query<StoredMessage>(
    `SELECT * FROM (
       SELECT id::text, wa_id AS "waId", from_me AS "fromMe", kind, body, sent_at AS "sentAt"
         FROM messages WHERE chat_id = $1 AND ($2::timestamptz IS NULL OR sent_at < $2)
        ORDER BY sent_at DESC LIMIT $3
     ) t ORDER BY "sentAt"`,
    [chatId, before ?? null, limit],
  );
}

export async function chatTarget(db: Db, chatId: number) {
  const [row] = await db.query<{ channelId: number; remoteJid: string }>(
    'SELECT channel_id AS "channelId", remote_jid AS "remoteJid" FROM chats WHERE id = $1',
    [chatId],
  );
  return row;
}

export async function markRead(db: Db, chatId: number) {
  await db.query('UPDATE chats SET last_read_at = now() WHERE id = $1', [chatId]);
}

export interface LeadPatch {
  stage?: string | null;
  dealValue?: number | null;
  interest?: string | null;
  tags?: string[];
  contactName?: string | null;
}

export async function updateLead(db: Db, chatId: number, patch: LeadPatch) {
  const columns: Record<string, unknown> = {
    stage: patch.stage,
    deal_value: patch.dealValue,
    interest: patch.interest,
    tags: patch.tags,
    contact_name: patch.contactName,
  };
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (!set.length) return;
  const sql = set.map(([k], i) => `${k} = $${i + 2}`);
  if (patch.stage !== undefined) sql.push('stage_changed_at = now()');
  await db.query(`UPDATE chats SET ${sql.join(', ')} WHERE id = $1`, [chatId, ...set.map(([, v]) => v)]);
}

export interface Note {
  id: number;
  body: string;
  createdAt: Date;
}

export const listNotes = (db: Db, chatId: number) =>
  db.query<Note>('SELECT id, body, created_at AS "createdAt" FROM notes WHERE chat_id = $1 ORDER BY created_at DESC', [
    chatId,
  ]);

export async function addNote(db: Db, chatId: number, body: string): Promise<Note> {
  const [n] = await db.query<Note>(
    'INSERT INTO notes (chat_id, body) VALUES ($1, $2) RETURNING id, body, created_at AS "createdAt"',
    [chatId, body],
  );
  return n;
}

export async function deleteNote(db: Db, id: number) {
  await db.query('DELETE FROM notes WHERE id = $1', [id]);
}

export interface Followup {
  id: number;
  chatId: number;
  dueAt: Date;
  note: string | null;
  doneAt: Date | null;
  contactName: string | null;
  remoteJid: string;
  agentName: string;
  stage: string | null;
}

const followupCols = `f.id, f.chat_id AS "chatId", f.due_at AS "dueAt", f.note, f.done_at AS "doneAt",
  c.contact_name AS "contactName", c.remote_jid AS "remoteJid", ch.agent_name AS "agentName", c.stage`;

export function listFollowups(db: Db, shopId: number, opts: { chatId?: number; includeDone?: boolean } = {}) {
  return db.query<Followup>(
    `SELECT ${followupCols}
       FROM followups f JOIN chats c ON c.id = f.chat_id JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = $1 AND ($2::int IS NULL OR f.chat_id = $2) AND ($3::boolean OR f.done_at IS NULL)
      ORDER BY f.done_at NULLS FIRST, f.due_at`,
    [shopId, opts.chatId ?? null, opts.includeDone ?? false],
  );
}

export async function addFollowup(db: Db, chatId: number, dueAt: Date, note: string | null) {
  const [{ id }] = await db.query<{ id: number }>(
    'INSERT INTO followups (chat_id, due_at, note) VALUES ($1, $2, $3) RETURNING id',
    [chatId, dueAt, note],
  );
  return id;
}

export async function setFollowupDone(db: Db, id: number, done: boolean) {
  await db.query('UPDATE followups SET done_at = CASE WHEN $2 THEN now() END WHERE id = $1', [id, done]);
}

export async function deleteFollowup(db: Db, id: number) {
  await db.query('DELETE FROM followups WHERE id = $1', [id]);
}

export interface QuickReply {
  id: number;
  shortcut: string;
  body: string;
}

export const listQuickReplies = (db: Db, shopId: number) =>
  db.query<QuickReply>('SELECT id, shortcut, body FROM quick_replies WHERE shop_id = $1 ORDER BY shortcut', [shopId]);

export async function saveQuickReply(db: Db, shopId: number, shortcut: string, body: string) {
  const [r] = await db.query<QuickReply>(
    `INSERT INTO quick_replies (shop_id, shortcut, body) VALUES ($1, $2, $3)
     ON CONFLICT (shop_id, shortcut) DO UPDATE SET body = EXCLUDED.body RETURNING id, shortcut, body`,
    [shopId, shortcut, body],
  );
  return r;
}

export async function deleteQuickReply(db: Db, id: number) {
  await db.query('DELETE FROM quick_replies WHERE id = $1', [id]);
}

/** Leads per stage with their total deal value. */
export function pipelineTotals(db: Db, shopId: number) {
  return db.query<{ stage: string; count: number; value: number }>(
    `SELECT c.stage, count(*)::int AS count, COALESCE(sum(c.deal_value), 0)::float8 AS value
       FROM chats c JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = $1 AND c.stage IS NOT NULL AND c.stage <> 'none'
      GROUP BY c.stage`,
    [shopId],
  );
}

/** Leads that entered a closing stage during the period, per agent. */
export function closedInPeriod(db: Db, shopId: number, stageIds: string[], from: Date, to: Date) {
  return db.query<{ channelId: number; count: number; value: number }>(
    `SELECT c.channel_id AS "channelId", count(*)::int AS count, COALESCE(sum(c.deal_value), 0)::float8 AS value
       FROM chats c JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = $1 AND c.stage = ANY($2::text[]) AND c.stage_changed_at >= $3 AND c.stage_changed_at < $4
      GROUP BY c.channel_id`,
    [shopId, stageIds, from, to],
  );
}

export interface SlaRow {
  channelId: number;
  chatId: number;
  fromMe: boolean;
  sentAt: Date;
}

/** Messages of every chat active since `since`, the raw input for SLA turns. */
export function loadSlaRows(db: Db, shopId: number, since: Date): Promise<SlaRow[]> {
  return db.query<SlaRow>(
    `SELECT c.channel_id AS "channelId", m.chat_id AS "chatId", m.from_me AS "fromMe", m.sent_at AS "sentAt"
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = $1 AND m.sent_at >= $2
      ORDER BY m.chat_id, m.sent_at`,
    [shopId, since],
  );
}

export function chatsById(db: Db, ids: number[]) {
  if (!ids.length) return Promise.resolve([]);
  return db.query<{ id: number; contactName: string | null; remoteJid: string }>(
    `SELECT id, contact_name AS "contactName", remote_jid AS "remoteJid" FROM chats WHERE id = ANY($1::int[])`,
    [ids],
  );
}
