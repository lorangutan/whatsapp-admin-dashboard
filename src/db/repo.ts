import type { Db } from './index.js';
import type { InboundMessage, ChannelStatus } from '../channels/types.js';
import type { BusinessHours } from '../sla/businessHours.js';
import { defaultPrefs, type Role, type ShopPrefs, type Stage } from './schema.js';

export interface Shop {
  id: number;
  name: string;
  utcOffsetMinutes: number;
  businessHours: BusinessHours;
  slaTargetMinutes: number;
  ownerWa: string | null;
  reportTime: string | null;
  pipelineStages: Stage[];
  prefs: ShopPrefs;
}

export interface Channel {
  id: number;
  shopId: number;
  agentName: string;
  phone: string | null;
  status: ChannelStatus;
}

const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

/** A shop by id, or the first shop (the install owner's) when no id is given. */
export async function getShop(db: Db, id?: number): Promise<Shop> {
  const cols = 's.*, ss.settings AS prefs';
  const from = 'shops s LEFT JOIN shop_settings ss ON ss.shop_id = s.id';
  const [r] = id
    ? await db.query<Record<string, any>>(`SELECT ${cols} FROM ${from} WHERE s.id = ?`, [id])
    : await db.query<Record<string, any>>(`SELECT ${cols} FROM ${from} ORDER BY s.id LIMIT 1`);
  if (!r) throw Object.assign(new Error('shop not found'), { statusCode: 404 });
  return {
    id: r.id,
    name: r.name,
    utcOffsetMinutes: r.utc_offset_minutes,
    businessHours: json(r.business_hours),
    slaTargetMinutes: r.sla_target_minutes,
    ownerWa: r.owner_wa,
    reportTime: r.report_time,
    pipelineStages: json(r.pipeline_stages),
    prefs: withDefaults(json<Partial<ShopPrefs> | null>(r.prefs)),
  };
}

/** Stored prefs over the defaults, so settings added later need no data migration. */
export function withDefaults(p: Partial<ShopPrefs> | null | undefined): ShopPrefs {
  return { ...defaultPrefs, ...p, metrics: { ...defaultPrefs.metrics, ...p?.metrics } };
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
  if (set.length) {
    await db.run(`UPDATE shops SET ${set.map(([k]) => `${k} = ?`).join(', ')} WHERE id = ?`, [
      ...set.map(([, v]) => v),
      id,
    ]);
  }
  if (patch.prefs) {
    await db.run(
      'INSERT INTO shop_settings (shop_id, settings) VALUES (?, ?) ON DUPLICATE KEY UPDATE settings = VALUES(settings)',
      [id, JSON.stringify(withDefaults(patch.prefs))],
    );
  }
}

/** Leads sitting in stages that were deleted move to `toStage` instead of vanishing from the pipeline. */
export async function moveLeadsOffStages(db: Db, shopId: number, removed: string[], toStage: string) {
  if (!removed.length) return 0;
  const { affectedRows } = await db.run(
    `UPDATE chats c JOIN channels ch ON ch.id = c.channel_id
        SET c.stage = ?, c.stage_changed_at = UTC_TIMESTAMP(3)
      WHERE ch.shop_id = ? AND c.stage IN (?)`,
    [toStage, shopId, removed],
  );
  return affectedRows;
}

export const listShopIds = async (db: Db) =>
  (await db.query<{ id: number }>('SELECT id FROM shops ORDER BY id')).map((r) => r.id);

/** Finds a shop by name, creating it (with default hours, stages and quick replies) if needed. */
export async function ensureShop(
  db: Db,
  name: string,
  defaults: { businessHours: unknown; stages: unknown; quickReplies: { shortcut: string; body: string }[] },
) {
  const [existing] = await db.query<{ id: number }>('SELECT id FROM shops WHERE name = ? ORDER BY id LIMIT 1', [name]);
  if (existing) return existing.id;
  const { insertId } = await db.run('INSERT INTO shops (name, business_hours, pipeline_stages) VALUES (?, ?, ?)', [
    name,
    JSON.stringify(defaults.businessHours),
    JSON.stringify(defaults.stages),
  ]);
  for (const r of defaults.quickReplies) {
    await db.run('INSERT IGNORE INTO quick_replies (shop_id, shortcut, body) VALUES (?, ?, ?)', [insertId, r.shortcut, r.body]);
  }
  return insertId;
}

// ---- accounts

export interface User {
  id: number;
  shopId: number;
  username: string;
  passwordHash: string;
  role: Role;
}

export async function findUser(db: Db, username: string): Promise<User | undefined> {
  const [u] = await db.query<User>(
    'SELECT id, shop_id AS shopId, username, password_hash AS passwordHash, role FROM users WHERE username = ?',
    [username],
  );
  return u;
}

/** Creates the account, or resets its password, shop and role if the username exists. */
export async function upsertUser(db: Db, username: string, passwordHash: string, shopId: number, role: Role) {
  await db.run(
    `INSERT INTO users (shop_id, username, password_hash, role) VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE shop_id = VALUES(shop_id), password_hash = VALUES(password_hash), role = VALUES(role)`,
    [shopId, username, passwordHash, role],
  );
}

// ---- tenant checks: which shop owns a given row (undefined if the row doesn't exist)

const ownerQueries = {
  chat: 'SELECT ch.shop_id AS shopId FROM chats c JOIN channels ch ON ch.id = c.channel_id WHERE c.id = ?',
  note: 'SELECT ch.shop_id AS shopId FROM notes n JOIN chats c ON c.id = n.chat_id JOIN channels ch ON ch.id = c.channel_id WHERE n.id = ?',
  followup:
    'SELECT ch.shop_id AS shopId FROM followups f JOIN chats c ON c.id = f.chat_id JOIN channels ch ON ch.id = c.channel_id WHERE f.id = ?',
  channel: 'SELECT shop_id AS shopId FROM channels WHERE id = ?',
  quickReply: 'SELECT shop_id AS shopId FROM quick_replies WHERE id = ?',
} as const;

export async function shopOf(db: Db, kind: keyof typeof ownerQueries, id: number): Promise<number | undefined> {
  const [row] = await db.query<{ shopId: number }>(ownerQueries[kind], [id]);
  return row?.shopId;
}

const channelCols = 'id, shop_id AS shopId, agent_name AS agentName, phone, status';

/** Every number across all shops; the WhatsApp manager reconnects them all on startup. */
export function listAllChannels(db: Db): Promise<Channel[]> {
  return db.query<Channel>(`SELECT ${channelCols} FROM channels ORDER BY id`);
}

export function listChannels(db: Db, shopId: number): Promise<Channel[]> {
  return db.query<Channel>(`SELECT ${channelCols} FROM channels WHERE shop_id = ? ORDER BY id`, [shopId]);
}

export async function createChannel(db: Db, shopId: number, agentName: string): Promise<Channel> {
  const { insertId } = await db.run('INSERT INTO channels (shop_id, agent_name) VALUES (?, ?)', [shopId, agentName]);
  return { id: insertId, shopId, agentName, phone: null, status: 'disconnected' };
}

export async function setChannelStatus(db: Db, id: number, status: ChannelStatus, phone?: string) {
  await db.run('UPDATE channels SET status = ?, phone = COALESCE(?, phone) WHERE id = ?', [status, phone ?? null, id]);
}

/** Removes a number and everything recorded under it. */
export async function deleteChannel(db: Db, id: number) {
  await db.run('DELETE m FROM messages m JOIN chats c ON c.id = m.chat_id WHERE c.channel_id = ?', [id]);
  await db.run('DELETE n FROM notes n JOIN chats c ON c.id = n.chat_id WHERE c.channel_id = ?', [id]);
  await db.run('DELETE f FROM followups f JOIN chats c ON c.id = f.chat_id WHERE c.channel_id = ?', [id]);
  await db.run('DELETE FROM chats WHERE channel_id = ?', [id]);
  await db.run('DELETE FROM channels WHERE id = ?', [id]);
}

/** New leads land in the shop's first pipeline stage (whatever the shop renamed it to). */
async function firstStage(db: Db, channelId: number): Promise<string> {
  const [r] = await db.query<{ stages: unknown }>(
    'SELECT s.pipeline_stages AS stages FROM shops s JOIN channels ch ON ch.shop_id = s.id WHERE ch.id = ?',
    [channelId],
  );
  return json<Stage[]>(r?.stages)?.[0]?.id ?? 'new';
}

/** Upserts a chat and returns its id. A name already on the chat (e.g. from the address book) is kept. */
async function upsertChat(db: Db, channelId: number, remoteJid: string, contactName: string | null) {
  const { insertId } = await db.run(
    `INSERT INTO chats (channel_id, remote_jid, contact_name) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), contact_name = COALESCE(contact_name, VALUES(contact_name))`,
    [channelId, remoteJid, contactName],
  );
  if (insertId) return insertId;
  const [row] = await db.query<{ id: number }>('SELECT id FROM chats WHERE channel_id = ? AND remote_jid = ?', [
    channelId,
    remoteJid,
  ]);
  return row.id;
}

/**
 * Recomputes a chat's summary columns from its messages: latest message, last reply and the
 * unread count (customer messages after both the last reply and the last time it was opened).
 */
export async function refreshChat(db: Db, chatId: number) {
  const [last] = await db.query<{ body: string | null; fromMe: boolean; kind: string; sentAt: Date }>(
    'SELECT body, from_me AS fromMe, kind, sent_at AS sentAt FROM messages WHERE chat_id = ? ORDER BY sent_at DESC, id DESC LIMIT 1',
    [chatId],
  );
  const [state] = await db.query<{ replyAt: Date | null; readAt: Date | null }>(
    `SELECT (SELECT MAX(sent_at) FROM messages WHERE chat_id = ? AND from_me = 1) AS replyAt, last_read_at AS readAt
       FROM chats WHERE id = ?`,
    [chatId, chatId],
  );
  if (!state) return;
  const since = new Date(Math.max(state.replyAt?.getTime() ?? 0, state.readAt?.getTime() ?? 0));
  const [{ n }] = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND from_me = 0 AND sent_at > ?',
    [chatId, since],
  );
  await db.run(
    `UPDATE chats SET last_message_at = ?, last_body = ?, last_from_me = ?, last_kind = ?, last_reply_at = ?, unread = ?
      WHERE id = ?`,
    [last?.sentAt ?? null, last?.body ?? null, last?.fromMe ?? null, last?.kind ?? null, state.replyAt, Number(n), chatId],
  );
}

/**
 * Stores messages (duplicates are ignored). A live message from a customer whose chat hasn't been
 * triaged yet turns the chat into a new lead — that's the automatic lead capture.
 * Returns the ids of chats that received new messages.
 */
export async function saveMessages(db: Db, channelId: number, messages: InboundMessage[]): Promise<number[]> {
  // Group by chat so a history sync of thousands of messages is a few bulk inserts, not one round trip each.
  const byChat = new Map<string, InboundMessage[]>();
  for (const m of messages) {
    const list = byChat.get(m.remoteJid) ?? [];
    list.push(m);
    byChat.set(m.remoteJid, list);
  }

  const touched: number[] = [];
  let newLeadStage: string | undefined;
  for (const [remoteJid, list] of byChat) {
    const name = list.findLast((m) => m.contactName)?.contactName ?? null;
    const chatId = await upsertChat(db, channelId, remoteJid, name);
    let inserted = 0;
    for (let i = 0; i < list.length; i += 400) {
      const rows = list.slice(i, i + 400).map((m) => [chatId, m.waId, m.fromMe, m.kind, m.body, m.sentAt]);
      inserted += (await db.run('INSERT IGNORE INTO messages (chat_id, wa_id, from_me, kind, body, sent_at) VALUES ?', [rows]))
        .affectedRows;
    }
    if (!inserted) continue;
    touched.push(chatId);
    const firstLive = list.find((m) => m.live && !m.fromMe);
    if (firstLive) {
      newLeadStage ??= await firstStage(db, channelId);
      await db.run('UPDATE chats SET stage = ?, stage_changed_at = ? WHERE id = ? AND stage IS NULL', [
        newLeadStage,
        firstLive.sentAt,
        chatId,
      ]);
    }
    await refreshChat(db, chatId);
  }
  return touched;
}

export async function setContactNames(db: Db, channelId: number, contacts: { jids: string[]; name: string }[]) {
  for (const c of contacts) {
    if (!c.jids.length) continue;
    await db.run('UPDATE chats SET contact_name = ? WHERE channel_id = ? AND remote_jid IN (?)', [
      c.name,
      channelId,
      c.jids,
    ]);
  }
}

/**
 * Folds chats stored under a LID into the phone-number chat for the same person, including their
 * notes, follow-ups and lead stage. Returns how many LID chats were merged or renamed.
 */
export async function mergeLidChats(db: Db, channelId: number, mappings: { lid: string; pn: string }[]) {
  let merged = 0;
  for (const { lid, pn } of mappings) {
    const rows = await db.query<{ id: number; remote_jid: string; contact_name: string | null; stage: string | null }>(
      'SELECT id, remote_jid, contact_name, stage FROM chats WHERE channel_id = ? AND remote_jid IN (?)',
      [channelId, [lid, pn]],
    );
    const lidChat = rows.find((r) => r.remote_jid === lid);
    const pnChat = rows.find((r) => r.remote_jid === pn);
    if (!lidChat) continue;
    merged++;
    if (!pnChat) {
      await db.run('UPDATE chats SET remote_jid = ? WHERE id = ?', [pn, lidChat.id]);
      continue;
    }
    // The same message can be stored under both ids; drop the copy before moving the rest.
    await db.run(
      'DELETE m FROM messages m JOIN messages keep ON keep.wa_id = m.wa_id AND keep.chat_id = ? WHERE m.chat_id = ?',
      [pnChat.id, lidChat.id],
    );
    for (const table of ['messages', 'notes', 'followups']) {
      await db.run(`UPDATE ${table} SET chat_id = ? WHERE chat_id = ?`, [pnChat.id, lidChat.id]);
    }
    await db.run('UPDATE chats SET contact_name = COALESCE(contact_name, ?), stage = COALESCE(stage, ?) WHERE id = ?', [
      lidChat.contact_name,
      lidChat.stage,
      pnChat.id,
    ]);
    await db.run('DELETE FROM chats WHERE id = ?', [lidChat.id]);
    await refreshChat(db, pnChat.id);
  }
  return merged;
}

export async function lidChatJids(db: Db, channelId: number): Promise<string[]> {
  const rows = await db.query<{ remote_jid: string }>(
    `SELECT remote_jid FROM chats WHERE channel_id = ? AND remote_jid LIKE '%@lid'`,
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
  /** Marked tuntas (solved) and the customer hasn't written since. */
  resolved: boolean;
  resolvedAt: Date | null;
}

export interface ChatFilter {
  id?: number;
  channelId?: number;
  q?: string;
  /** 'lead' = any active lead, otherwise a stage id. */
  stage?: string;
  /** Only chats whose last message is from the customer. */
  unreplied?: boolean;
  /** Only chats not marked tuntas (or reopened by a newer customer message). */
  unresolved?: boolean;
  /** Cursor for infinite scroll: chats last active before this instant. */
  before?: Date;
  limit?: number;
}

export async function listChats(db: Db, shopId: number, f: ChatFilter = {}): Promise<ChatListItem[]> {
  const where = ['ch.shop_id = ?'];
  const params: unknown[] = [shopId];
  if (f.id !== undefined) {
    where.push('c.id = ?');
    params.push(f.id);
  }
  if (f.channelId !== undefined) {
    where.push('c.channel_id = ?');
    params.push(f.channelId);
  }
  if (f.q) {
    // LOWER() keeps search case-insensitive whatever the column collation is.
    const like = `%${f.q.toLowerCase()}%`;
    where.push('(LOWER(c.contact_name) LIKE ? OR c.remote_jid LIKE ? OR LOWER(c.interest) LIKE ?)');
    params.push(like, like, like);
  }
  if (f.stage === 'lead') where.push(`c.stage IS NOT NULL AND c.stage <> 'none'`);
  else if (f.stage) {
    where.push('c.stage = ?');
    params.push(f.stage);
  }
  if (f.unreplied) where.push('c.last_from_me = 0');
  if (f.unresolved) where.push(`NOT EXISTS (SELECT 1 FROM resolutions r WHERE ${STANDING})`);
  if (f.before) {
    where.push('c.last_message_at < ?');
    params.push(f.before);
  }
  const rows = await db.query<ChatListItem>(
    `SELECT c.id, c.channel_id AS channelId, ch.agent_name AS agentName, ch.status AS channelStatus,
            c.remote_jid AS remoteJid, c.contact_name AS contactName, c.last_message_at AS lastMessageAt,
            c.last_body AS lastBody, c.last_from_me AS lastFromMe, c.last_kind AS lastKind,
            c.stage, c.stage_changed_at AS stageChangedAt, c.deal_value AS dealValue, c.interest, c.tags, c.unread,
            (SELECT MIN(f.due_at) FROM followups f WHERE f.chat_id = c.id AND f.done_at IS NULL) AS nextFollowupAt,
            (SELECT MAX(r.resolved_at) FROM resolutions r WHERE ${STANDING}) AS resolvedAt
       FROM chats c
       JOIN channels ch ON ch.id = c.channel_id
      WHERE ${where.join(' AND ')}
      ORDER BY c.last_message_at IS NULL, c.last_message_at DESC
      LIMIT ?`,
    [...params, f.limit ?? 60],
  );
  for (const r of rows) {
    r.tags = json<string[] | null>(r.tags) ?? [];
    r.dealValue = r.dealValue == null ? null : Number(r.dealValue);
    r.resolved = r.resolvedAt != null;
  }
  return rows;
}

/**
 * Condition on `resolutions r` for chat `c`: the resolutions that still stand, i.e. newer than the
 * customer's latest message. A customer writing again after "tuntas" reopens the chat by itself.
 */
const STANDING = `r.chat_id = c.id AND r.resolved_at >= COALESCE(
  (SELECT MAX(m.sent_at) FROM messages m WHERE m.chat_id = c.id AND m.from_me = 0), '1970-01-01')`;

/** Marks the chat tuntas now, unless it already is. */
export async function resolveChat(db: Db, chatId: number) {
  await db.run(
    `INSERT INTO resolutions (chat_id, resolved_at)
     SELECT c.id, UTC_TIMESTAMP(3) FROM chats c WHERE c.id = ? AND NOT EXISTS (SELECT 1 FROM resolutions r WHERE ${STANDING})`,
    [chatId],
  );
}

/** Undo "tuntas": removes the resolutions that currently stand; older history stays. */
export async function reopenChat(db: Db, chatId: number) {
  await db.run(
    `DELETE FROM resolutions WHERE chat_id = ? AND resolved_at >= COALESCE(
       (SELECT MAX(sent_at) FROM messages WHERE chat_id = ? AND from_me = 0), '1970-01-01')`,
    [chatId, chatId],
  );
}

/** Every resolution in the shop since `since`, for the resolution metrics. */
export function loadResolutions(db: Db, shopId: number, since: Date) {
  return db.query<{ chatId: number; resolvedAt: Date }>(
    `SELECT r.chat_id AS chatId, r.resolved_at AS resolvedAt
       FROM resolutions r JOIN chats c ON c.id = r.chat_id JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = ? AND r.resolved_at >= ?
      ORDER BY r.chat_id, r.resolved_at`,
    [shopId, since],
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
export async function getMessages(db: Db, chatId: number, before?: Date, limit = 80) {
  const rows = await db.query<StoredMessage>(
    `SELECT CAST(id AS CHAR) AS id, wa_id AS waId, from_me AS fromMe, kind, body, sent_at AS sentAt
       FROM messages WHERE chat_id = ? ${before ? 'AND sent_at < ?' : ''}
      ORDER BY sent_at DESC, id DESC LIMIT ?`,
    before ? [chatId, before, limit] : [chatId, limit],
  );
  return rows.reverse();
}

export async function chatTarget(db: Db, chatId: number) {
  const [row] = await db.query<{ channelId: number; remoteJid: string }>(
    'SELECT channel_id AS channelId, remote_jid AS remoteJid FROM chats WHERE id = ?',
    [chatId],
  );
  return row;
}

export async function markRead(db: Db, chatId: number) {
  await db.run('UPDATE chats SET last_read_at = UTC_TIMESTAMP(3), unread = 0 WHERE id = ?', [chatId]);
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
    tags: patch.tags && JSON.stringify(patch.tags),
    contact_name: patch.contactName,
  };
  const set = Object.entries(columns).filter(([, v]) => v !== undefined);
  if (!set.length) return;
  const sql = set.map(([k]) => `${k} = ?`);
  if (patch.stage !== undefined) sql.push('stage_changed_at = UTC_TIMESTAMP(3)');
  await db.run(`UPDATE chats SET ${sql.join(', ')} WHERE id = ?`, [...set.map(([, v]) => v), chatId]);
}

export interface Note {
  id: number;
  body: string;
  createdAt: Date;
}

export const listNotes = (db: Db, chatId: number) =>
  db.query<Note>('SELECT id, body, created_at AS createdAt FROM notes WHERE chat_id = ? ORDER BY created_at DESC', [
    chatId,
  ]);

export async function addNote(db: Db, chatId: number, body: string): Promise<Note> {
  const { insertId } = await db.run('INSERT INTO notes (chat_id, body) VALUES (?, ?)', [chatId, body]);
  return { id: insertId, body, createdAt: new Date() };
}

export async function deleteNote(db: Db, id: number) {
  await db.run('DELETE FROM notes WHERE id = ?', [id]);
}

export interface Followup {
  id: number;
  chatId: number;
  channelId: number;
  dueAt: Date;
  note: string | null;
  doneAt: Date | null;
  contactName: string | null;
  remoteJid: string;
  agentName: string;
  stage: string | null;
}

export function listFollowups(db: Db, shopId: number, opts: { chatId?: number; includeDone?: boolean } = {}) {
  const where = ['ch.shop_id = ?'];
  const params: unknown[] = [shopId];
  if (opts.chatId !== undefined) {
    where.push('f.chat_id = ?');
    params.push(opts.chatId);
  }
  if (!opts.includeDone) where.push('f.done_at IS NULL');
  return db.query<Followup>(
    `SELECT f.id, f.chat_id AS chatId, c.channel_id AS channelId, f.due_at AS dueAt, f.note, f.done_at AS doneAt,
            c.contact_name AS contactName, c.remote_jid AS remoteJid, ch.agent_name AS agentName, c.stage
       FROM followups f JOIN chats c ON c.id = f.chat_id JOIN channels ch ON ch.id = c.channel_id
      WHERE ${where.join(' AND ')}
      ORDER BY f.done_at IS NOT NULL, f.due_at`,
    params,
  );
}

export async function addFollowup(db: Db, chatId: number, dueAt: Date, note: string | null) {
  const { insertId } = await db.run('INSERT INTO followups (chat_id, due_at, note) VALUES (?, ?, ?)', [
    chatId,
    dueAt,
    note,
  ]);
  return insertId;
}

export async function setFollowupDone(db: Db, id: number, done: boolean) {
  await db.run('UPDATE followups SET done_at = IF(?, UTC_TIMESTAMP(3), NULL) WHERE id = ?', [done, id]);
}

export async function deleteFollowup(db: Db, id: number) {
  await db.run('DELETE FROM followups WHERE id = ?', [id]);
}

export interface QuickReply {
  id: number;
  shortcut: string;
  body: string;
}

export const listQuickReplies = (db: Db, shopId: number) =>
  db.query<QuickReply>('SELECT id, shortcut, body FROM quick_replies WHERE shop_id = ? ORDER BY shortcut', [shopId]);

export async function saveQuickReply(db: Db, shopId: number, shortcut: string, body: string) {
  await db.run(
    `INSERT INTO quick_replies (shop_id, shortcut, body) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE body = VALUES(body)`,
    [shopId, shortcut, body],
  );
  const [r] = await db.query<QuickReply>('SELECT id, shortcut, body FROM quick_replies WHERE shop_id = ? AND shortcut = ?', [
    shopId,
    shortcut,
  ]);
  return r;
}

export async function deleteQuickReply(db: Db, id: number) {
  await db.run('DELETE FROM quick_replies WHERE id = ?', [id]);
}

/** Leads per stage with their total deal value. */
export async function pipelineTotals(db: Db, shopId: number) {
  const rows = await db.query<{ stage: string; count: number; value: number }>(
    `SELECT c.stage, COUNT(*) AS count, COALESCE(SUM(c.deal_value), 0) AS value
       FROM chats c JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = ? AND c.stage IS NOT NULL AND c.stage <> 'none'
      GROUP BY c.stage`,
    [shopId],
  );
  return rows.map((r) => ({ stage: r.stage, count: Number(r.count), value: Number(r.value) }));
}

/** Leads that entered a closing stage during the period, per agent. */
export async function closedInPeriod(db: Db, shopId: number, stageIds: string[], from: Date, to: Date) {
  if (!stageIds.length) return [];
  const rows = await db.query<{ channelId: number; count: number; value: number }>(
    `SELECT c.channel_id AS channelId, COUNT(*) AS count, COALESCE(SUM(c.deal_value), 0) AS value
       FROM chats c JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = ? AND c.stage IN (?) AND c.stage_changed_at >= ? AND c.stage_changed_at < ?
      GROUP BY c.channel_id`,
    [shopId, stageIds, from, to],
  );
  return rows.map((r) => ({ channelId: r.channelId, count: Number(r.count), value: Number(r.value) }));
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
    `SELECT c.channel_id AS channelId, m.chat_id AS chatId, m.from_me AS fromMe, m.sent_at AS sentAt
       FROM messages m
       JOIN chats c ON c.id = m.chat_id
       JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = ? AND m.sent_at >= ?
      ORDER BY m.chat_id, m.sent_at`,
    [shopId, since],
  );
}

export function chatsById(db: Db, ids: number[]) {
  if (!ids.length) return Promise.resolve([]);
  return db.query<{ id: number; contactName: string | null; remoteJid: string }>(
    'SELECT id, contact_name AS contactName, remote_jid AS remoteJid FROM chats WHERE id IN (?)',
    [ids],
  );
}

export interface StaleLead {
  chatId: number;
  channelId: number;
  agentName: string;
  contactName: string | null;
  remoteJid: string;
  stage: string;
  lastActivityAt: Date;
}

/**
 * Leads in a working stage with no message and no stage change since `idleSince`, and nothing planned:
 * a lead with an open follow-up is waiting on purpose, so it is left out.
 */
export function staleLeads(db: Db, shopId: number, stageIds: string[], idleSince: Date): Promise<StaleLead[]> {
  if (!stageIds.length) return Promise.resolve([]);
  const activity = 'GREATEST(COALESCE(c.last_message_at, c.stage_changed_at), COALESCE(c.stage_changed_at, c.last_message_at))';
  return db.query<StaleLead>(
    `SELECT c.id AS chatId, c.channel_id AS channelId, ch.agent_name AS agentName, c.contact_name AS contactName,
            c.remote_jid AS remoteJid, c.stage, ${activity} AS lastActivityAt
       FROM chats c JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = ? AND c.stage IN (${stageIds.map(() => '?').join(', ')}) AND ${activity} < ?
        AND NOT EXISTS (SELECT 1 FROM followups f WHERE f.chat_id = c.id AND f.done_at IS NULL)
      ORDER BY lastActivityAt
      LIMIT 50`,
    [shopId, ...stageIds, idleSince],
  );
}
