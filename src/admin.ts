// Admin screen API, for the Wamon team (role "dev") only: every account, its shop, trial dates,
// blocking, password resets, and looking at the app as a given account.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from './db/index.js';
import * as repo from './db/repo.js';
import { defaultBusinessHours, defaultQuickReplies, defaultStages, ROLES, type Role } from './db/schema.js';
import { forgetUsers, hashPassword, issueSession } from './auth.js';
import { isYmd } from './trial.js';

const bad = (message: string) => Object.assign(new Error(message), { statusCode: 400 });
const forbidden = () => Object.assign(new Error('Khusus tim Wamon'), { statusCode: 403 });
const notFound = () => Object.assign(new Error('Akun tidak ditemukan'), { statusCode: 404 });

const USERNAME = /^[a-z0-9._-]{3,60}$/;

interface UserBody {
  username?: string;
  password?: string;
  role?: Role;
  shopId?: number | null;
  shopName?: string;
  trialFrom?: string | null;
  trialUntil?: string | null;
  disabled?: boolean;
  note?: string | null;
}

/** Checks and normalises the fields that were sent; fields left out stay undefined (unchanged). */
function readBody(b: UserBody, creating: boolean) {
  const out: repo.UserPatch & { password?: string } = {};
  if (b.username !== undefined || creating) {
    const u = String(b.username ?? '').trim().toLowerCase();
    if (!USERNAME.test(u)) throw bad('Username 3–60 karakter: huruf kecil, angka, titik, minus atau garis bawah');
    out.username = u;
  }
  if (b.password !== undefined && b.password !== '') {
    if (String(b.password).length < 6) throw bad('Password minimal 6 karakter');
    out.passwordHash = hashPassword(String(b.password));
  } else if (creating) {
    throw bad('Password wajib diisi');
  }
  if (b.role !== undefined) {
    if (!ROLES.includes(b.role)) throw bad('Role tidak dikenal');
    out.role = b.role;
  }
  for (const key of ['trialFrom', 'trialUntil'] as const) {
    if (b[key] === undefined) continue;
    const v = b[key] || null;
    if (v !== null && !isYmd(v)) throw bad('Tanggal trial tidak valid');
    out[key] = v;
  }
  const from = out.trialFrom, until = out.trialUntil;
  if (from && until && from > until) throw bad('Tanggal mulai trial harus sebelum tanggal selesai');
  if (b.disabled !== undefined) out.disabled = Boolean(b.disabled);
  if (b.note !== undefined) out.note = b.note ? String(b.note).slice(0, 255) : null;
  return out;
}

const isDuplicate = (err: unknown) => (err as { code?: string }).code === 'ER_DUP_ENTRY';

export function registerAdmin(app: FastifyInstance, db: Db) {
  // Only a dev's own login; not while looking at the app as someone else.
  const devOnly = async (req: FastifyRequest) => {
    if (req.session.role !== 'dev' || req.session.via) throw forbidden();
  };

  app.get('/api/admin/users', { preHandler: devOnly }, async () => ({
    users: await repo.listUsersForAdmin(db),
    shops: await repo.listShopsForAdmin(db),
  }));

  app.post<{ Body: UserBody }>('/api/admin/users', { preHandler: devOnly }, async (req, reply) => {
    const b = req.body ?? {};
    const fields = readBody(b, true);
    let shopId = b.shopId ?? null;
    if (shopId === null) {
      const name = String(b.shopName ?? '').trim();
      if (!name) throw bad('Pilih toko atau isi nama toko baru');
      shopId = await repo.ensureShop(db, name, { businessHours: defaultBusinessHours, stages: defaultStages, quickReplies: defaultQuickReplies });
    } else {
      await repo.getShop(db, shopId); // 404 if it doesn't exist
    }
    try {
      const id = await repo.createUser(db, {
        username: fields.username!,
        passwordHash: fields.passwordHash!,
        role: fields.role ?? 'owner',
        shopId,
        trialFrom: fields.trialFrom ?? null,
        trialUntil: fields.trialUntil ?? null,
        note: fields.note ?? null,
      });
      return reply.code(201).send({ id });
    } catch (err) {
      if (isDuplicate(err)) throw bad('Username sudah dipakai');
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: UserBody }>('/api/admin/users/:id', { preHandler: devOnly }, async (req) => {
    const user = await repo.findUserById(db, Number(req.params.id));
    if (!user) throw notFound();
    const b = req.body ?? {};
    const patch = readBody(b, false);
    // Judge "from before until" against what is already stored when only one date is sent.
    const from = patch.trialFrom !== undefined ? patch.trialFrom : user.trialFrom;
    const until = patch.trialUntil !== undefined ? patch.trialUntil : user.trialUntil;
    if (from && until && from > until) throw bad('Tanggal mulai trial harus sebelum tanggal selesai');
    if (user.username === req.session.username && (patch.disabled || (patch.role && patch.role !== 'dev'))) {
      throw bad('Tidak bisa menonaktifkan atau menurunkan akun sendiri');
    }
    if (b.shopId !== undefined && b.shopId !== null) {
      await repo.getShop(db, b.shopId);
      patch.shopId = b.shopId;
    }
    try {
      await repo.updateUser(db, user.id, patch);
    } catch (err) {
      if (isDuplicate(err)) throw bad('Username sudah dipakai');
      throw err;
    }
    forgetUsers();
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/users/:id', { preHandler: devOnly }, async (req) => {
    const user = await repo.findUserById(db, Number(req.params.id));
    if (!user) throw notFound();
    if (user.username === req.session.username) throw bad('Tidak bisa menghapus akun sendiri');
    await repo.deleteUser(db, user.id); // the shop and its chats stay
    forgetUsers();
    return { ok: true };
  });

  app.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/admin/shops/:id', { preHandler: devOnly }, async (req) => {
    const name = String(req.body?.name ?? '').trim();
    if (!name || name.length > 100) throw bad('Nama toko 1–100 karakter');
    const shop = await repo.getShop(db, Number(req.params.id));
    await repo.updateShop(db, shop.id, { name });
    return { ok: true };
  });

  // Look at the app exactly as this account sees it; "Kembali ke Admin" switches back.
  app.post<{ Params: { id: string } }>('/api/admin/users/:id/view-as', { preHandler: devOnly }, async (req, reply) => {
    const user = await repo.findUserById(db, Number(req.params.id));
    if (!user) throw notFound();
    if (user.role === 'dev') throw bad('Akun dev bisa langsung masuk sendiri');
    issueSession(req, reply, { username: user.username, shopId: user.shopId, role: user.role, via: req.session.username });
    return { ok: true };
  });
}
