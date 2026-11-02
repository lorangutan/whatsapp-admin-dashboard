import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { schemaSql, defaultBusinessHours, defaultQuickReplies } from './schema.js';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export async function openDb(): Promise<Db> {
  const db = config.databaseUrl ? await openPostgres(config.databaseUrl) : await openPglite(config.dataDir);
  await db.exec(schemaSql);
  const [{ count }] = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM shops');
  if (count === 0) {
    await db.query('INSERT INTO shops (name, business_hours) VALUES ($1, $2)', [
      config.shopName,
      JSON.stringify(defaultBusinessHours),
    ]);
  }
  const [{ replies }] = await db.query<{ replies: number }>('SELECT count(*)::int AS replies FROM quick_replies');
  if (replies === 0) {
    for (const r of defaultQuickReplies) {
      await db.query('INSERT INTO quick_replies (shop_id, shortcut, body) SELECT id, $1, $2 FROM shops', [
        r.shortcut,
        r.body,
      ]);
    }
  }
  return db;
}

async function openPostgres(connectionString: string): Promise<Db> {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString });
  return {
    query: async (sql, params) => (await pool.query(sql, params)).rows,
    exec: async (sql) => {
      await pool.query(sql);
    },
    close: () => pool.end(),
  };
}

async function openPglite(dataDir: string): Promise<Db> {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = path.resolve(dataDir, 'pglite');
  mkdirSync(dir, { recursive: true });
  const db = new PGlite(dir);
  return {
    query: async <T>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows,
    exec: async (sql) => {
      await db.exec(sql);
    },
    close: () => db.close(),
  };
}
