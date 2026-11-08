import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { Db } from './db/index.js';
import { findUser, getShop, touchLogin, type User } from './db/repo.js';
import { ROLES, type Role } from './db/schema.js';
import { accessProblem } from './trial.js';

const COOKIE = 'wamon_session';
const MAX_AGE_S = 30 * 24 * 3600;

export interface Session {
  username: string;
  shopId: number;
  role: Role;
  /** Set when a dev is looking at the app as this account: the dev's username, to switch back. */
  via?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    session: Session;
  }
}

/** Login is required whenever an owner password is configured; production refuses to start without one. */
export const authEnabled = () => Boolean(config.adminPassword);

// ---- passwords: scrypt$<salt>$<hash>

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('base64url');
  return `scrypt$${salt}$${scryptSync(password, salt, 32).toString('base64url')}`;
}

function verifyPassword(password: string, stored: string) {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const given = scryptSync(password, salt, expected.length);
  return timingSafeEqual(expected, given);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const sameSecret = (a: string, b: string) => timingSafeEqual(sha256(a), sha256(b));

// ---- signed session cookie: base64url(json).hmac

const sign = (payload: string) => createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

function makeToken(s: Session) {
  const payload = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + MAX_AGE_S * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token: string | undefined): Session | null {
  if (!token) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!(data.exp > Date.now()) || typeof data.shopId !== 'number') return null;
    const role: Role = ROLES.includes(data.role) ? data.role : 'owner';
    return { username: data.username, shopId: data.shopId, role, ...(typeof data.via === 'string' ? { via: data.via } : {}) };
  } catch {
    return null;
  }
}

function readCookie(req: FastifyRequest, name: string) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

function setCookie(req: FastifyRequest, reply: FastifyReply, value: string, maxAge: number) {
  // Behind a proxy (Tailscale, Cloudflare, Caddy) the request arrives as plain HTTP; trust its forwarded proto.
  const secure = req.protocol === 'https' || req.headers['x-forwarded-proto'] === 'https';
  reply.header(
    'set-cookie',
    `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
  );
}

// Brute-force guard: 10 attempts per IP per 15 minutes.
const attempts = new Map<string, { n: number; until: number }>();
function tooManyAttempts(ip: string) {
  const now = Date.now();
  const a = attempts.get(ip);
  if (!a || a.until < now) {
    attempts.set(ip, { n: 1, until: now + 15 * 60_000 });
    return false;
  }
  a.n++;
  return a.n > 10;
}

/** Login refused for a reason the user should see: a blocked account, or a trial outside its dates. */
class Refused extends Error {}

/** Owner login from the environment first, then accounts stored in the database. */
async function authenticate(db: Db, username: string, password: string): Promise<Session | null> {
  if (config.adminPassword && username === config.adminUsername && sameSecret(password, config.adminPassword)) {
    return { username, shopId: (await getShop(db)).id, role: 'owner' };
  }
  const user = await findUser(db, username);
  if (user && verifyPassword(password, user.passwordHash)) {
    // Only after the password matches, so these messages never reveal that an account exists.
    const problem = user.role === 'dev' ? null : accessProblem(user);
    if (problem) throw new Refused(problem);
    await touchLogin(db, user.id).catch(() => {});
    return { username: user.username, shopId: user.shopId, role: user.role };
  }
  // Burn similar time for unknown users so response time doesn't reveal which usernames exist.
  if (!user) verifyPassword(password, `scrypt$${'x'.repeat(22)}$${'x'.repeat(43)}`);
  return null;
}

// Each API request re-checks the account (deleted, blocked, trial over, moved to another shop or
// role) so changes made in Admin apply within seconds, not when the 30-day cookie runs out.
const userCache = new Map<string, { user: User | undefined; at: number }>();
const CACHE_MS = 15_000;
async function currentUser(db: Db, username: string) {
  const hit = userCache.get(username);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.user;
  const user = await findUser(db, username);
  userCache.set(username, { user, at: Date.now() });
  return user;
}
/** Admin calls this after changing accounts so the change applies on their next request. */
export const forgetUsers = () => userCache.clear();

/** The stored account behind a cookie, checked again; null means the cookie is no longer good. */
async function recheck(db: Db, s: Session): Promise<Session | null> {
  if (config.adminPassword && s.username === config.adminUsername && !s.via) return s; // the env owner login
  const user = await currentUser(db, s.username);
  if (!user) return null;
  if (s.via) {
    // A dev looking at the app as this account: the dev must still be an active dev.
    const dev = await currentUser(db, s.via);
    return dev?.role === 'dev' && !dev.disabled ? { ...s, shopId: user.shopId } : null;
  }
  if (user.role !== 'dev' && accessProblem(user)) return null;
  return { ...s, shopId: user.shopId, role: user.role };
}

/** Logs this browser in as `session` (Admin uses it to look at the app as another account). */
export function issueSession(req: FastifyRequest, reply: FastifyReply, session: Session) {
  setCookie(req, reply, makeToken(session), MAX_AGE_S);
}

export function registerAuth(app: FastifyInstance, db: Db) {
  app.decorateRequest('session', null as unknown as Session);

  // Without login (local development) everyone acts as the owner of the first shop.
  let devSession: Session | null = null;
  const devLogin = async () => (devSession ??= { username: 'dev', shopId: (await getShop(db)).id, role: 'owner' });

  app.get('/api/session', async (req) => {
    const s = authEnabled() ? readToken(readCookie(req, COOKIE)) : await devLogin();
    if (!s) return { required: true, loggedIn: false };
    const live = authEnabled() ? await recheck(db, s) : s;
    if (!live) return { required: true, loggedIn: false };
    const shop = await getShop(db, live.shopId);
    const user = authEnabled() ? await currentUser(db, live.username) : undefined;
    return {
      required: authEnabled(),
      loggedIn: true,
      username: live.username,
      role: live.role,
      shopName: shop.name,
      via: live.via ?? null,
      trialFrom: user?.trialFrom ?? null,
      trialUntil: user?.trialUntil ?? null,
    };
  });

  app.post<{ Body: { username?: string; password?: string } }>('/api/login', async (req, reply) => {
    if (!authEnabled()) return { ok: true };
    if (tooManyAttempts(req.ip)) return reply.code(429).send({ error: 'Terlalu banyak percobaan. Coba lagi 15 menit.' });
    let session: Session | null;
    try {
      session = await authenticate(db, String(req.body?.username ?? '').trim().toLowerCase(), String(req.body?.password ?? ''));
    } catch (err) {
      if (err instanceof Refused) return reply.code(403).send({ error: err.message });
      throw err;
    }
    if (!session) return reply.code(401).send({ error: 'Username atau password salah' });
    attempts.delete(req.ip);
    setCookie(req, reply, makeToken(session), MAX_AGE_S);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    setCookie(req, reply, '', 0);
    return { ok: true };
  });

  // Back from "look as this account" to the dev's own login.
  app.post('/api/admin/return', async (req, reply) => {
    const s = readToken(readCookie(req, COOKIE));
    const dev = s?.via ? await findUser(db, s.via) : undefined;
    if (!dev || dev.role !== 'dev' || dev.disabled) return reply.code(403).send({ error: 'forbidden' });
    issueSession(req, reply, { username: dev.username, shopId: dev.shopId, role: 'dev' });
    return { ok: true };
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return;
    if (req.url.startsWith('/api/login') || req.url.startsWith('/api/session') || req.url.startsWith('/api/admin/return')) return;
    if (!authEnabled()) {
      req.session = await devLogin();
      return;
    }
    const token = readToken(readCookie(req, COOKIE));
    const s = token && (await recheck(db, token));
    if (!s) return reply.code(401).send({ error: 'unauthorized' });
    req.session = s;
  });
}
