import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { Db } from './db/index.js';
import { findUser, getShop } from './db/repo.js';
import type { Role } from './db/schema.js';

const COOKIE = 'wamon_session';
const MAX_AGE_S = 30 * 24 * 3600;

export interface Session {
  username: string;
  shopId: number;
  role: Role;
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
    return { username: data.username, shopId: data.shopId, role: data.role === 'demo' ? 'demo' : 'owner' };
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

/** Owner login from the environment first, then accounts stored in the database. */
async function authenticate(db: Db, username: string, password: string): Promise<Session | null> {
  if (config.adminPassword && username === config.adminUsername && sameSecret(password, config.adminPassword)) {
    return { username, shopId: (await getShop(db)).id, role: 'owner' };
  }
  const user = await findUser(db, username);
  if (user && verifyPassword(password, user.passwordHash)) {
    return { username: user.username, shopId: user.shopId, role: user.role };
  }
  // Burn similar time for unknown users so response time doesn't reveal which usernames exist.
  if (!user) verifyPassword(password, `scrypt$${'x'.repeat(22)}$${'x'.repeat(43)}`);
  return null;
}

export function registerAuth(app: FastifyInstance, db: Db) {
  app.decorateRequest('session', null as unknown as Session);

  // Without login (local development) everyone acts as the owner of the first shop.
  let devSession: Session | null = null;
  const devLogin = async () => (devSession ??= { username: 'dev', shopId: (await getShop(db)).id, role: 'owner' });

  app.get('/api/session', async (req) => {
    const s = authEnabled() ? readToken(readCookie(req, COOKIE)) : await devLogin();
    if (!s) return { required: true, loggedIn: false };
    const shop = await getShop(db, s.shopId);
    return { required: authEnabled(), loggedIn: true, username: s.username, role: s.role, shopName: shop.name };
  });

  app.post<{ Body: { username?: string; password?: string } }>('/api/login', async (req, reply) => {
    if (!authEnabled()) return { ok: true };
    if (tooManyAttempts(req.ip)) return reply.code(429).send({ error: 'Terlalu banyak percobaan. Coba lagi 15 menit.' });
    const session = await authenticate(
      db,
      String(req.body?.username ?? '').trim().toLowerCase(),
      String(req.body?.password ?? ''),
    );
    if (!session) return reply.code(401).send({ error: 'Username atau password salah' });
    attempts.delete(req.ip);
    setCookie(req, reply, makeToken(session), MAX_AGE_S);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    setCookie(req, reply, '', 0);
    return { ok: true };
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api')) return;
    if (req.url.startsWith('/api/login') || req.url.startsWith('/api/session')) return;
    if (!authEnabled()) {
      req.session = await devLogin();
      return;
    }
    const s = readToken(readCookie(req, COOKIE));
    if (!s) return reply.code(401).send({ error: 'unauthorized' });
    req.session = s;
  });
}
