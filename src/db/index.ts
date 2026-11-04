import mysql, { type Pool, type PoolOptions, type ResultSetHeader } from 'mysql2/promise';
import { config } from '../config.js';
import { schemaSql, defaultBusinessHours, defaultQuickReplies, defaultStages } from './schema.js';

export interface Db {
  /** SELECT: returns rows. Arrays in params expand for `IN (?)`. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** INSERT/UPDATE/DELETE: returns the insert id and affected row count. */
  run(sql: string, params?: unknown[]): Promise<{ insertId: number; affectedRows: number }>;
  close(): Promise<void>;
}

/** mysql://user:pass@host:port/database — TiDB Cloud Serverless or any MySQL 8 compatible server. */
function poolOptions(url: string): PoolOptions & { database: string } {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'wamon';
  return {
    host: u.hostname,
    port: Number(u.port || 4000),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database,
    // TiDB Cloud only accepts TLS; set DB_SSL=false for a local server without it.
    ssl: process.env.DB_SSL === 'false' ? undefined : { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    // All DATETIME columns hold UTC.
    timezone: 'Z',
    connectionLimit: 5,
    enableKeepAlive: true,
    // BOOLEAN is TINYINT(1) in MySQL; hand it back as a real boolean.
    typeCast(field, next) {
      if (field.type === 'TINY' && field.length === 1) {
        const v = field.string();
        return v === null ? null : v === '1';
      }
      return next();
    },
  };
}

export async function openDb(): Promise<Db> {
  if (!config.databaseUrl) {
    throw new Error('DATABASE_URL is not set. Put your TiDB connection string in .env (see .env.example).');
  }
  const opts = poolOptions(config.databaseUrl);

  // Create the database on first run so a fresh TiDB cluster works without manual steps.
  const bootstrap = await mysql.createConnection({ ...opts, database: undefined });
  await bootstrap.query(`CREATE DATABASE IF NOT EXISTS \`${opts.database.replace(/`/g, '')}\``);
  await bootstrap.end();

  const pool: Pool = mysql.createPool(opts);
  pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00'");
  });

  const db: Db = {
    query: async (sql, params) => (await pool.query(sql, params))[0] as never,
    run: async (sql, params) => {
      const [res] = await pool.query<ResultSetHeader>(sql, params);
      return { insertId: res.insertId, affectedRows: res.affectedRows };
    },
    close: () => pool.end(),
  };

  // Every statement is idempotent, so this doubles as the migration on startup.
  for (const statement of schemaSql.split(';').map((s) => s.trim()).filter(Boolean)) {
    await pool.query(statement);
  }

  const [{ count }] = await db.query<{ count: number }>('SELECT COUNT(*) AS count FROM shops');
  if (Number(count) === 0) {
    await db.run('INSERT INTO shops (name, business_hours, pipeline_stages) VALUES (?, ?, ?)', [
      config.shopName,
      JSON.stringify(defaultBusinessHours),
      JSON.stringify(defaultStages),
    ]);
  }
  const [{ replies }] = await db.query<{ replies: number }>('SELECT COUNT(*) AS replies FROM quick_replies');
  if (Number(replies) === 0) {
    for (const r of defaultQuickReplies) {
      await db.run('INSERT INTO quick_replies (shop_id, shortcut, body) SELECT id, ?, ? FROM shops', [r.shortcut, r.body]);
    }
  }
  return db;
}
