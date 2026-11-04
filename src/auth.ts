import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

const COOKIE = 'wamon_session';
const MAX_AGE_S = 30 * 24 * 3600;

/** Login is required whenever a password is configured; the server refuses to go public without one. */
export const authEnabled = () => Boolean(config.adminPassword);

const sha256 = (s: string) => createHash('sha256').update(s).digest();
const sign = (payload: string) => createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');

function makeToken() {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + MAX_AGE_S * 1000 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function validToken(token: string | undefined) {
  if (!token) return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > Date.now();
  } catch {
    return false;
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
  // Behind Caddy the request arrives as plain HTTP; trust its forwarded proto for the Secure flag.
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

export function registerAuth(app: FastifyInstance) {
  app.get('/api/session', async (req) => ({
    required: authEnabled(),
    loggedIn: !authEnabled() || validToken(readCookie(req, COOKIE)),
  }));

  app.post<{ Body: { password?: string } }>('/api/login', async (req, reply) => {
    if (!authEnabled()) return { ok: true };
    if (tooManyAttempts(req.ip)) return reply.code(429).send({ error: 'Terlalu banyak percobaan. Coba lagi 15 menit.' });
    const given = sha256(String(req.body?.password ?? ''));
    if (!timingSafeEqual(given, sha256(config.adminPassword!))) {
      return reply.code(401).send({ error: 'Password salah' });
    }
    attempts.delete(req.ip);
    setCookie(req, reply, makeToken(), MAX_AGE_S);
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    setCookie(req, reply, '', 0);
    return { ok: true };
  });

  app.addHook('onRequest', async (req, reply) => {
    if (!authEnabled() || !req.url.startsWith('/api')) return;
    if (req.url.startsWith('/api/login') || req.url.startsWith('/api/session')) return;
    if (!validToken(readCookie(req, COOKIE))) return reply.code(401).send({ error: 'unauthorized' });
  });
}
