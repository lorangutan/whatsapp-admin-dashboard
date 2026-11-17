// The owner's Tim card: staff (sales) logins for their own shop. Each sees only the chats of the one
// WhatsApp number picked for it, and can't see reports or change numbers and settings (server.ts).
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from './db/index.js';
import { createUser, deleteUser, findUser, findUserById, listTeam, shopOf, updateUser } from './db/repo.js';
import { forgetUsers, hashPassword, passwordProblem } from './auth.js';

const fail = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,29}$/;

export function registerTeam(app: FastifyInstance, db: Db) {
  const ownerOnly = async (req: FastifyRequest) => {
    if (req.session.role !== 'owner' && req.session.role !== 'dev') throw fail(403, 'Hanya owner yang bisa mengatur tim');
  };

  /** A sales account in the caller's shop, or a 404 (other shops' accounts reveal nothing). */
  async function member(req: FastifyRequest, id: number) {
    const u = Number.isInteger(id) ? await findUserById(db, id) : undefined;
    if (!u || u.shopId !== req.session.shopId || u.role !== 'sales') throw fail(404, 'tidak ditemukan');
    return u;
  }

  /** The number a sales login sees: one of this shop's, or null for none yet. */
  async function channelOf(req: FastifyRequest, value: unknown) {
    if (value === null || value === undefined || value === '') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || (await shopOf(db, 'channel', id)) !== req.session.shopId) throw fail(400, 'Nomor WA tidak ditemukan');
    return id;
  }

  app.get('/api/team', { preHandler: ownerOnly }, (req) => listTeam(db, req.session.shopId));

  app.post<{ Body: { username?: string; password?: string; channelId?: number | null } }>('/api/team', { preHandler: ownerOnly }, async (req) => {
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    if (!USERNAME.test(username)) throw fail(400, 'Username 3–30 huruf kecil, angka, titik, - atau _');
    const problem = passwordProblem(req.body?.password);
    if (problem) throw fail(400, problem);
    if (await findUser(db, username)) throw fail(409, 'Username sudah dipakai');
    const channelId = await channelOf(req, req.body?.channelId);
    await createUser(db, {
      username,
      passwordHash: hashPassword(req.body!.password!),
      role: 'sales',
      shopId: req.session.shopId,
      trialFrom: null,
      trialUntil: null,
      note: `Dibuat oleh ${req.session.username}`,
      channelId,
    });
    forgetUsers();
    return listTeam(db, req.session.shopId);
  });

  app.patch<{ Params: { id: string }; Body: { password?: string; disabled?: boolean; channelId?: number | null } }>(
    '/api/team/:id',
    { preHandler: ownerOnly },
    async (req) => {
      const u = await member(req, Number(req.params.id));
      const patch: { passwordHash?: string; disabled?: boolean; channelId?: number | null } = {};
      if (req.body && 'channelId' in req.body) patch.channelId = await channelOf(req, req.body.channelId);
      if (req.body?.password !== undefined) {
        const problem = passwordProblem(req.body.password);
        if (problem) throw fail(400, problem);
        patch.passwordHash = hashPassword(req.body.password);
      }
      if (typeof req.body?.disabled === 'boolean') patch.disabled = req.body.disabled;
      await updateUser(db, u.id, patch);
      forgetUsers();
      return listTeam(db, req.session.shopId);
    },
  );

  app.delete<{ Params: { id: string } }>('/api/team/:id', { preHandler: ownerOnly }, async (req) => {
    const u = await member(req, Number(req.params.id));
    await deleteUser(db, u.id);
    forgetUsers();
    return listTeam(db, req.session.shopId);
  });
}
