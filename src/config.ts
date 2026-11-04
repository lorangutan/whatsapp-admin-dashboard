import { randomBytes } from 'node:crypto';

try {
  // ENV_FILE lets a production install keep its secrets outside the code folder.
  process.loadEnvFile(process.env.ENV_FILE ?? '.env');
} catch {
  // the env file is optional; variables may come from the environment instead
}

const host = process.env.HOST ?? '127.0.0.1';

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host,
  /** mysql://… for TiDB Cloud Serverless (or any MySQL 8 compatible server). */
  databaseUrl: process.env.DATABASE_URL,
  /** WhatsApp login sessions live here; it must survive restarts. */
  dataDir: process.env.DATA_DIR ?? './data',
  /** Dashboard password. Without it the dashboard is open, which is only allowed on localhost. */
  adminPassword: process.env.ADMIN_PASSWORD || undefined,
  /** Signs session cookies. A random fallback works but logs everyone out on every restart. */
  sessionSecret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
  /** Behind a reverse proxy (Caddy) the client IP and protocol come from X-Forwarded-* headers. */
  trustProxy: process.env.TRUST_PROXY === 'true',
  shopName: process.env.SHOP_NAME ?? 'Bengkel Saya',
};

// In production Caddy proxies to 127.0.0.1, so "loopback" alone doesn't mean private.
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
if ((!loopback || process.env.NODE_ENV === 'production') && !config.adminPassword) {
  throw new Error('Refusing to start without ADMIN_PASSWORD: customer chats would be public.');
}
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  throw new Error('Set SESSION_SECRET in production so logins survive restarts.');
}
