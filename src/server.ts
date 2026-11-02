import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import type { Db } from './db/index.js';
import * as repo from './db/repo.js';
import { ChannelOfflineError, type ChannelManager } from './channels/manager.js';
import { bus } from './events.js';
import { localDayStart } from './sla/businessHours.js';
import { buildReport, shopClock } from './report/service.js';
import { formatDailyReport, sendDailyReport } from './report/daily.js';

const DAY = 86_400_000;

type IdParams = { Params: { id: string } };

export function buildServer(db: Db, channels: ChannelManager, loggerInstance: FastifyBaseLogger) {
  const app = Fastify({ loggerInstance, disableRequestLogging: true });

  app.register(fastifyStatic, {
    root: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public'),
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!config.adminToken || !req.url.startsWith('/api')) return;
    // EventSource can't send headers, so the live stream takes the token as a query parameter.
    const token = req.headers['x-admin-token'] ?? (req.query as { token?: string }).token;
    if (token !== config.adminToken) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ChannelOfflineError) return reply.code(409).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (!e.statusCode || e.statusCode >= 500) app.log.error(err);
    return reply.code(e.statusCode ?? 500).send({ error: e.message ?? 'error' });
  });

  const shop = () => repo.getShop(db);

  // ---- live updates
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    reply.raw.write('retry: 2000\n\n');
    const unsubscribe = bus.subscribe((e) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`));
    const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    req.raw.on('close', () => {
      clearInterval(ping);
      unsubscribe();
    });
  });

  // ---- shop & settings
  app.get('/api/shop', shop);

  app.put<{ Body: Partial<Omit<repo.Shop, 'id'>> }>('/api/shop', async (req) => {
    await repo.updateShop(db, (await shop()).id, req.body);
    return shop();
  });

  app.get('/api/quick-replies', async () => repo.listQuickReplies(db, (await shop()).id));

  app.post<{ Body: { shortcut: string; body: string } }>('/api/quick-replies', async (req, reply) => {
    const shortcut = req.body?.shortcut?.trim().replace(/^\//, '').toLowerCase();
    const body = req.body?.body?.trim();
    if (!shortcut || !body) return reply.code(400).send({ error: 'shortcut dan isi wajib diisi' });
    return repo.saveQuickReply(db, (await shop()).id, shortcut, body);
  });

  app.delete<IdParams>('/api/quick-replies/:id', async (req) => {
    await repo.deleteQuickReply(db, Number(req.params.id));
    return { ok: true };
  });

  // ---- numbers
  app.get('/api/channels', async () => {
    const s = await shop();
    return (await repo.listChannels(db, s.id)).map((c) => ({ ...c, ...channels.state(c.id) }));
  });

  app.post<{ Body: { agentName: string } }>('/api/channels', async (req, reply) => {
    const agentName = req.body?.agentName?.trim();
    if (!agentName) return reply.code(400).send({ error: 'agentName is required' });
    const channel = await repo.createChannel(db, (await shop()).id, agentName);
    await channels.start(channel.id);
    return channel;
  });

  app.post<IdParams>('/api/channels/:id/reconnect', async (req) => {
    await channels.start(Number(req.params.id));
    return { ok: true };
  });

  app.delete<IdParams>('/api/channels/:id', async (req) => {
    const id = Number(req.params.id);
    await channels.remove(id);
    await repo.deleteChannel(db, id);
    return { ok: true };
  });

  // ---- reports
  // ?days=1 is "today" in shop time, ?days=7 is the last 7 local days including today.
  app.get<{ Querystring: { days?: string } }>('/api/report', async (req) => {
    const s = await shop();
    const days = Math.max(1, Number(req.query.days ?? 1));
    const now = new Date();
    const todayStart = localDayStart(now, shopClock(s));
    return buildReport(db, s, { from: new Date(todayStart.getTime() - (days - 1) * DAY), to: now }, now);
  });

  app.get('/api/report/daily-preview', async () => {
    const s = await shop();
    const now = new Date();
    const from = localDayStart(now, shopClock(s));
    return { text: formatDailyReport(s, await buildReport(db, s, { from, to: now }, now)) };
  });

  app.post('/api/report/send', async (_req, reply) => {
    try {
      await sendDailyReport(db, channels);
      return { ok: true };
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  // ---- chats & leads
  app.get<{
    Querystring: { channelId?: string; q?: string; stage?: string; unreplied?: string; before?: string; limit?: string };
  }>('/api/chats', async (req) => {
    const q = req.query;
    return repo.listChats(db, (await shop()).id, {
      channelId: q.channelId ? Number(q.channelId) : undefined,
      q: q.q || undefined,
      stage: q.stage || undefined,
      unreplied: q.unreplied === '1',
      before: q.before ? new Date(q.before) : undefined,
      limit: q.limit ? Math.min(Number(q.limit), 500) : undefined,
    });
  });

  app.get<IdParams>('/api/chats/:id', async (req, reply) => {
    const s = await shop();
    const id = Number(req.params.id);
    const chat = await repo.getChat(db, s.id, id);
    if (!chat) return reply.code(404).send({ error: 'chat not found' });
    const [notes, followups] = await Promise.all([
      repo.listNotes(db, id),
      repo.listFollowups(db, s.id, { chatId: id, includeDone: true }),
    ]);
    return { ...chat, notes, followups };
  });

  app.patch<IdParams & { Body: repo.LeadPatch }>('/api/chats/:id', async (req) => {
    const id = Number(req.params.id);
    await repo.updateLead(db, id, req.body ?? {});
    bus.publish({ type: 'chat', chatId: id });
    return repo.getChat(db, (await shop()).id, id);
  });

  app.post<IdParams>('/api/chats/:id/read', async (req) => {
    await repo.markRead(db, Number(req.params.id));
    return { ok: true };
  });

  app.get<IdParams & { Querystring: { before?: string } }>('/api/chats/:id/messages', (req) =>
    repo.getMessages(db, Number(req.params.id), req.query.before ? new Date(req.query.before) : undefined),
  );

  app.post<IdParams & { Body: { text: string } }>('/api/chats/:id/messages', async (req, reply) => {
    const text = req.body?.text?.trim();
    if (!text) return reply.code(400).send({ error: 'pesan kosong' });
    const target = await repo.chatTarget(db, Number(req.params.id));
    if (!target) return reply.code(404).send({ error: 'chat not found' });
    return channels.reply(target.channelId, target.remoteJid, text);
  });

  app.post<IdParams & { Body: { body: string } }>('/api/chats/:id/notes', async (req, reply) => {
    const body = req.body?.body?.trim();
    if (!body) return reply.code(400).send({ error: 'catatan kosong' });
    return repo.addNote(db, Number(req.params.id), body);
  });

  app.delete<IdParams>('/api/notes/:id', async (req) => {
    await repo.deleteNote(db, Number(req.params.id));
    return { ok: true };
  });

  // ---- follow-ups
  app.get<{ Querystring: { includeDone?: string } }>('/api/followups', async (req) =>
    repo.listFollowups(db, (await shop()).id, { includeDone: req.query.includeDone === '1' }),
  );

  app.post<IdParams & { Body: { dueAt: string; note?: string } }>('/api/chats/:id/followups', async (req, reply) => {
    const dueAt = new Date(req.body?.dueAt);
    if (Number.isNaN(dueAt.getTime())) return reply.code(400).send({ error: 'tanggal tidak valid' });
    const id = await repo.addFollowup(db, Number(req.params.id), dueAt, req.body.note?.trim() || null);
    bus.publish({ type: 'followups' });
    return { id };
  });

  app.patch<IdParams & { Body: { done: boolean } }>('/api/followups/:id', async (req) => {
    await repo.setFollowupDone(db, Number(req.params.id), Boolean(req.body?.done));
    bus.publish({ type: 'followups' });
    return { ok: true };
  });

  app.delete<IdParams>('/api/followups/:id', async (req) => {
    await repo.deleteFollowup(db, Number(req.params.id));
    bus.publish({ type: 'followups' });
    return { ok: true };
  });

  return app;
}
