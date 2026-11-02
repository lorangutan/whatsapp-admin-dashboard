try {
  process.loadEnvFile();
} catch {
  // .env is optional
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  /** Set to use a real Postgres; otherwise an embedded PGlite database lives in DATA_DIR. */
  databaseUrl: process.env.DATABASE_URL,
  dataDir: process.env.DATA_DIR ?? './data',
  /** When set, every /api request must send it in the x-admin-token header. */
  adminToken: process.env.ADMIN_TOKEN,
  shopName: process.env.SHOP_NAME ?? 'Bengkel Saya',
};
