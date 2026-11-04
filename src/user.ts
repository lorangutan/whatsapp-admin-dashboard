// Create or reset a dashboard login.
//   npm run user -- <username> <password> [--shop "Shop name"] [--role owner|demo]
// The shop is created if it doesn't exist yet; without --shop the account joins the first shop.
import { openDb } from './db/index.js';
import { ensureShop, getShop, upsertUser } from './db/repo.js';
import { defaultBusinessHours, defaultQuickReplies, defaultStages, type Role } from './db/schema.js';
import { hashPassword } from './auth.js';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.splice(i, 2)[1] : undefined;
};
const shopName = flag('shop');
const role = (flag('role') ?? 'owner') as Role;
const [username, password] = args;

if (!username || !password || !['owner', 'demo'].includes(role)) {
  console.error('Usage: npm run user -- <username> <password> [--shop "Shop name"] [--role owner|demo]');
  process.exit(1);
}
if (password.length < 4) {
  console.error('Password is too short.');
  process.exit(1);
}

const db = await openDb();
const shopId = shopName
  ? await ensureShop(db, shopName, { businessHours: defaultBusinessHours, stages: defaultStages, quickReplies: defaultQuickReplies })
  : (await getShop(db)).id;
await upsertUser(db, username.toLowerCase(), hashPassword(password), shopId, role);
console.log(`Saved login "${username.toLowerCase()}" (${role}) for shop #${shopId} ${(await getShop(db, shopId)).name}`);
await db.close();
