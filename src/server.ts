import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger, type FastifyReply, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import type { Db } from './db/index.js';
import * as repo from './db/repo.js';
import { ChannelOfflineError, type ChannelManager } from './channels/manager.js';
import { bus } from './events.js';
import { registerAuth } from './auth.js';
import { localDayStart } from './sla/businessHours.js';
import { buildReport, shopClock } from './report/service.js';
import { formatDailyReport, sendDailyReport } from './report/daily.js';

const DAY = 86_400_000;

type IdParams = { Params: { id: string } };

/** A 404 for rows in another shop too, so ids from other shops reveal nothing. */
const notFound = () => Object.assign(new Error('tidak ditemukan'), { statusCode: 404 });
const demoDenied = () =>
  Object.assign(new Error('Akun demo tidak bisa melakukan ini'), { statusCode: 403 });

export function buildServer(db: Db, channels: ChannelManager, loggerInstance: FastifyBaseLogger) {
  const app = Fastify({ loggerInstance, disableRequestLogging: true, trustProxy: config.trustProxy });

  app.register(fastifyStatic, {
    root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  });

  registerAuth(app, db);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ChannelOfflineError) return reply.code(409).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (!e.statusCode || e.statusCode >= 500) app.log.error(err);
    return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'error' });
  });

  const shopOf = (req: FastifyRequest) => repo.getShop(db, req.session.shopId);

  /** Throws 404 unless the row belongs to the caller's shop. */
  async function own(req: FastifyRequest, kind: Parameters<typeof repo.shopOf>[1], id: number) {
    if (!Number.isInteger(id) || (await repo.shopOf(db, kind, id)) !== req.session.shopId) throw notFound();
    return id;
  }

  /** Owner-only actions: linking numbers, sending WhatsApp messages, shop settings. */
  const ownerOnly = async (req: FastifyRequest, _reply: FastifyReply) => {
    if (req.session.role !== 'owner') throw demoDenied();
  };

  // ---- live updates (only this shop's events)
  app.get('/api/events', (req, reply) => {
    const shopId = req.session.shopId;
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write('retry: 2000\n\n');
    const unsubscribe = bus.subscribe((e) => {
      if (e.shopId === shopId) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    });
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ---- shop & settings
  app.get('/api/shop', (req) => shopOf(req));

  app.put<{ Body: Partial<Omit<repo.Shop, 'id'>> }>('/api/shop', { preHandler: ownerOnly }, async (req) => {
    await repo.updateShop(db, req.session.shopId, req.body);
    return shopOf(req);
  });

  app.get('/api/quick-replies', (req) => repo.listQuickReplies(db, req.session.shopId));

  app.post<{ Body: { shortcut: string; body: string } }>('/api/quick-replies', { preHandler: ownerOnly }, async (req, reply) => {
    const shortcut = req.body?.shortcut?.trim().replace(/^\//, '').toLowerCase();
    const body = req.body?.body?.trim();
    if (!shortcut || !body) return reply.code(400).send({ error: 'shortcut dan isi wajib diisi' });
    return repo.saveQuickReply(db, req.session.shopId, shortcut, body);
  });

  app.delete<IdParams>('/api/quick-replies/:id', { preHandler: ownerOnly }, async (req) => {
    await repo.deleteQuickReply(db, await own(req, 'quickReply', Number(req.params.id)));
    return { ok: true };
  });

  // ---- numbers
  app.get('/api/channels', async (req) =>
    (await repo.listChannels(db, req.session.shopId)).map((c) => ({ ...c, ...channels.state(c.id) })),
  );

  app.post<{ Body: { agentName: string } }>('/api/channels', { preHandler: ownerOnly }, async (req, reply) => {
    const agentName = req.body?.agentName?.trim();
    if (!agentName) return reply.code(400).send({ error: 'agentName is required' });
    const channel = await repo.createChannel(db, req.session.shopId, agentName);
    await channels.start(channel.id);
    return channel;
  });

  app.post<IdParams>('/api/channels/:id/reconnect', { preHandler: ownerOnly }, async (req) => {
    await channels.start(await own(req, 'channel', Number(req.params.id)));
    return { ok: true };
  });

  app.delete<IdParams>('/api/channels/:id', { preHandler: ownerOnly }, async (req) => {
    const id = await own(req, 'channel', Number(req.params.id));
    await channels.remove(id);
    await repo.deleteChannel(db, id);
    return { ok: true };
  });

  // ---- reports
  // ?days=1 is "today" in shop time, ?days=7 is the last 7 local days including today.
  app.get<{ Querystring: { days?: string } }>('/api/report', async (req) => {
    const s = await shopOf(req);
    const days = Math.max(1, Number(req.query.days ?? 1));
    const now = new Date();
    const todayStart = localDayStart(now, shopClock(s));
    return buildReport(db, s, { from: new Date(todayStart.getTime() - (days - 1) * DAY), to: now }, now);
  });

  app.get('/api/report/daily-preview', async (req) => {
    const s = await shopOf(req);
    const now = new Date();
    const from = localDayStart(now, shopClock(s));
    return { text: formatDailyReport(s, await buildReport(db, s, { from, to: now }, now)) };
  });

  app.post('/api/report/send', { preHandler: ownerOnly }, async (req, reply) => {
    try {
      await sendDailyReport(db, channels, req.session.shopId);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ---- chats & leads
  app.get<{
    Querystring: {
      channelId?: string; q?: string; stage?: string; unreplied?: string; unresolved?: string; before?: string; limit?: string;
    };
  }>('/api/chats', async (req) => {
    const q = req.query;
    return repo.listChats(db, req.session.shopId, {
      channelId: q.channelId ? Number(q.channelId) : undefined,
      q: q.q || undefined,
      stage: q.stage || undefined,
      unreplied: q.unreplied === '1',
      unresolved: q.unresolved === '1',
      before: q.before ? new Date(q.before) : undefined,
      limit: q.limit ? Math.min(Number(q.limit), 500) : undefined,
    });
  });

  app.get<IdParams>('/api/chats/:id', async (req) => {
    const shopId = req.session.shopId;
    const chat = await repo.getChat(db, shopId, Number(req.params.id));
    if (!chat) throw notFound();
    const [notes, followups] = await Promise.all([
      repo.listNotes(db, chat.id),
      repo.listFollowups(db, shopId, { chatId: chat.id, includeDone: true }),
    ]);
    return { ...chat, notes, followups };
  });

  app.patch<IdParams & { Body: repo.LeadPatch }>('/api/chats/:id', async (req) => {
    const id = await own(req, 'chat', Number(req.params.id));
    await repo.updateLead(db, id, req.body ?? {});
    // Reaching Deal or Batal settles the conversation, so it counts as tuntas too.
    const stage = req.body?.stage;
    if (stage && (await shopOf(req)).pipelineStages.find((s) => s.id === stage)?.outcome) await repo.resolveChat(db, id);
    bus.publish({ shopId: req.session.shopId, type: 'chat', chatId: id });
    return repo.getChat(db, req.session.shopId, id);
  });

  // "Tuntas": the customer's problem is solved. A new message from the customer reopens it by itself.
  app.post<IdParams>('/api/chats/:id/resolve', async (req) => {
    const id = await own(req, 'chat', Number(req.params.id));
    await repo.resolveChat(db, id);
    bus.publish({ shopId: req.session.shopId, type: 'chat', chatId: id });
    return repo.getChat(db, req.session.shopId, id);
  });

  app.delete<IdParams>('/api/chats/:id/resolve', async (req) => {
    const id = await own(req, 'chat', Number(req.params.id));
    await repo.reopenChat(db, id);
    bus.publish({ shopId: req.session.shopId, type: 'chat', chatId: id });
    return repo.getChat(db, req.session.shopId, id);
  });

  app.post<IdParams>('/api/chats/:id/read', async (req) => {
    await repo.markRead(db, await own(req, 'chat', Number(req.params.id)));
    return { ok: true };
  });

  app.get<IdParams & { Querystring: { before?: string } }>('/api/chats/:id/messages', async (req) =>
    repo.getMessages(
      db,
      await own(req, 'chat', Number(req.params.id)),
      req.query.before ? new Date(req.query.before) : undefined,
    ),
  );

  app.post<IdParams & { Body: { text: string } }>('/api/chats/:id/messages', { preHandler: ownerOnly }, async (req, reply) => {
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'pesan kosong' });
    const target = await repo.chatTarget(db, await own(req, 'chat', Number(req.params.id)));
    return channels.reply(target.channelId, target.remoteJid, text);
  });

  app.post<IdParams & { Body: { body: string } }>('/api/chats/:id/notes', async (req, reply) => {
    const body = req.body?.body?.trim();
    if (!body) return reply.code(400).send({ error: 'catatan kosong' });
    return repo.addNote(db, await own(req, 'chat', Number(req.params.id)), body);
  });

  app.delete<IdParams>('/api/notes/:id', async (req) => {
    await repo.deleteNote(db, await own(req, 'note', Number(req.params.id)));
    return { ok: true };
  });

  // ---- follow-ups
  app.get<{ Querystring: { includeDone?: string } }>('/api/followups', (req) =>
    repo.listFollowups(db, req.session.shopId, { includeDone: req.query.includeDone === '1' }),
  );

  app.post<IdParams & { Body: { dueAt: string; note?: string } }>('/api/chats/:id/followups', async (req, reply) => {
    const chatId = await own(req, 'chat', Number(req.params.id));
    const dueAt = new Date(req.body?.dueAt);
    if (Number.isNaN(dueAt.getTime())) return reply.code(400).send({ error: 'tanggal tidak valid' });
    const id = await repo.addFollowup(db, chatId, dueAt, req.body.note?.trim() || null);
    bus.publish({ shopId: req.session.shopId, type: 'followups' });
    return { id };
  });

  app.patch<IdParams & { Body: { done: boolean } }>('/api/followups/:id', async (req) => {
    await repo.setFollowupDone(db, await own(req, 'followup', Number(req.params.id)), Boolean(req.body?.done));
    bus.publish({ shopId: req.session.shopId, type: 'followups' });
    return { ok: true };
  });

  app.delete<IdParams>('/api/followups/:id', async (req) => {
    await repo.deleteFollowup(db, await own(req, 'followup', Number(req.params.id)));
    bus.publish({ shopId: req.session.shopId, type: 'followups' });
    return { ok: true };
  });

  return app;
}
