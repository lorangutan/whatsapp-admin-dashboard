// The "Demo Toko Emas" shop: fake chats for two counter salespeople and a live-selling host, with
// CRM data, plus a "demo" login (password "demo", demo role) that can only see that shop.
// fresh: true deletes the fake agents (and everything in their chats) first and seeds them again
// relative to now, so the demo always looks like an ordinary working day. Only the fake
// 62812000… numbers are ever touched, never a real linked number.
import type { Db } from './db/index.js';
import {
  addFollowup, addNote, createChannel, deleteChannel, ensureShop, listChannels, saveMessages, setChannelStatus, updateLead,
  upsertUser,
} from './db/repo.js';
import { defaultBusinessHours, defaultQuickReplies, defaultStages } from './db/schema.js';
import { hashPassword } from './auth.js';
import type { InboundMessage } from './channels/types.js';

export const DEMO_SHOP = 'Demo Toko Emas';
/** The demo used to be a motorbike dealer; that shop (and its demo login) is renamed and reseeded. */
const OLD_DEMO_SHOP = 'Demo Bengkel';

export async function seedDemo(db: Db, { fresh = false, log = console.log }: { fresh?: boolean; log?: (msg: string) => void } = {}) {
  const [current] = await db.query('SELECT id FROM shops WHERE name = ?', [DEMO_SHOP]);
  if (!current) {
    const renamed = await db.run('UPDATE shops SET name = ? WHERE name = ?', [DEMO_SHOP, OLD_DEMO_SHOP]);
    if (renamed.affectedRows) {
      log(`Renamed ${OLD_DEMO_SHOP} to ${DEMO_SHOP}`);
      fresh = true; // its chats are about motorbikes
    }
  }
  const shop = { id: await ensureShop(db, DEMO_SHOP, { businessHours: defaultBusinessHours, stages: defaultStages, quickReplies: defaultQuickReplies }) };
  await upsertUser(db, 'demo', hashPassword('demo'), shop.id, 'demo');
  log(`Demo shop #${shop.id}, login demo / demo`);

  if (fresh) {
    const fake = (await listChannels(db, shop.id)).filter((c) => c.phone?.startsWith('62812000'));
    for (const c of fake) await deleteChannel(db, c.id);
    log(`Removed ${fake.length} demo agents to seed them again`);
    // Back to the default stages and quick replies, in case they changed since the last seed.
    await db.run('UPDATE shops SET pipeline_stages = ? WHERE id = ?', [JSON.stringify(defaultStages), shop.id]);
    await db.run('DELETE FROM quick_replies WHERE shop_id = ?', [shop.id]);
    for (const r of defaultQuickReplies) {
      await db.run('INSERT INTO quick_replies (shop_id, shortcut, body) VALUES (?, ?, ?)', [shop.id, r.shortcut, r.body]);
    }
  }

  const customers = ['Bu Lina', 'Ci Melly', 'Pak Hasan', 'Mbak Ayu', 'Bu Ratna', 'Koh Willy', 'Nita', 'Bu Endang', 'Putri', 'Pak Bambang'];
  const counterAsks = [
    'Kak, harga emas 24K hari ini berapa per gram?',
    'Kalung Italy 17K yang 5 gram masih ready?',
    'Kalau jual kembali potongannya berapa?',
    'Bisa tukar tambah gelang lama saya?',
    'Cincin kawin bisa ukir nama?',
    'Toko buka sampai jam berapa?',
  ];
  const liveAsks = [
    'Kak, cincin yang di live tadi masih ada?',
    'Yang nomor 12 di live berapa gram?',
    'Minta foto & video detailnya dong',
    'Bisa kirim ke luar kota? Pakai asuransi?',
    'Bisa keep dulu sampai Sabtu?',
    'Ongkos bikinnya berapa kak?',
  ];
  const replies = [
    'Ready kak 🙏',
    '24K hari ini 2,35jt/gr kak',
    'Ini fotonya kak, beratnya 5,02 gr',
    'Bisa kak, dikirim pakai asuransi',
    'Bisa kak, bawa barang dan suratnya ya',
    'Bisa keep 2 hari kak dengan DP',
  ];

  // Each agent has a typical response speed (minutes) and a chance of leaving a chat unanswered.
  // The live host is the slowest: chats pile up while they are on air.
  const agents = [
    { name: 'Sari · Counter', speed: 4, ignore: 0.05, asks: counterAsks },
    { name: 'Mega · Live', speed: 18, ignore: 0.2, asks: liveAsks },
    { name: 'Dewi · Counter', speed: 9, ignore: 0.1, asks: counterAsks },
  ];

  let rng = 42;
  const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
  const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

  // Earlier versions seeded the fake agents into the owner's shop; move them (only the fake
  // 62812000… numbers, never a real agent with the same name) into the demo shop.
  const moved = await db.run(
    "UPDATE channels SET shop_id = ? WHERE shop_id <> ? AND agent_name IN (?) AND phone LIKE '62812000%'",
    [shop.id, shop.id, agents.map((a) => a.name)],
  );
  if (moved.affectedRows) log(`Moved ${moved.affectedRows} demo agents into ${DEMO_SHOP}`);

  const now = Date.now();
  const existing = await listChannels(db, shop.id);
  for (const [ai, agent] of agents.entries()) {
    if (existing.some((c) => c.agentName === agent.name)) continue; // safe to re-run
    const channel = await createChannel(db, shop.id, agent.name);
    await setChannelStatus(db, channel.id, 'disconnected', `62812000${ai}${ai}${ai}`);
    const messages: InboundMessage[] = [];
    let seq = 0;

    for (let day = 6; day >= 0; day--) {
      for (let c = 0; c < 4 + Math.floor(rand() * 4); c++) {
        // Distinct customers within a day so two fake conversations never interleave in one chat.
        const customer = customers[(c + day * 3) % customers.length];
        const jid = `62857${String(customers.indexOf(customer)).padStart(2, '0')}${ai}1234@s.whatsapp.net`;
        // Inquiry between 08:00 and 16:00 WIB (01:00–09:00 UTC)
        const dayStart = new Date(now - day * 86_400_000);
        dayStart.setUTCHours(1, 0, 0, 0);
        let t = dayStart.getTime() + rand() * 8 * 3_600_000;
        if (t > now) continue;

        for (let turn = 0; turn < 1 + Math.floor(rand() * 3); turn++) {
          const burst = 1 + Math.floor(rand() * 2);
          for (let b = 0; b < burst; b++) {
            messages.push({ waId: `seed-${ai}-${seq++}`, remoteJid: jid, contactName: customer, fromMe: false, kind: 'text', body: pick(agent.asks), sentAt: new Date(t) });
            t += 30_000 + rand() * 60_000;
          }
          if (rand() < agent.ignore) break;
          t += agent.speed * 60_000 * (0.3 + rand() * 1.7);
          if (t > now) break;
          messages.push({ waId: `seed-${ai}-${seq++}`, remoteJid: jid, fromMe: true, kind: 'text', body: pick(replies), sentAt: new Date(t) });
          t += 5 * 60_000 + rand() * 40 * 60_000;
        }
      }
    }
    await saveMessages(db, channel.id, messages);
    log(`${agent.name}: ${messages.length} messages`);
  }

  // CRM demo data on the fake agents' chats only (never on a real linked number).
  const units = ['Cincin 17K 3 gr', 'Kalung Italy 17K 5 gr', 'Gelang rantai 22K 10 gr', 'Liontin huruf 17K 2 gr', 'Anting anak 8K 1,5 gr', 'Logam mulia 24K 5 gr', 'Cincin kawin 18K sepasang'];
  const prices = [4_650_000, 7_900_000, 21_800_000, 3_150_000, 1_350_000, 11_900_000, 9_600_000];
  const tagPool = ['dari live', 'tukar tambah', 'buyback', 'kirim luar kota', 'minta video'];
  const stageCycle = ['new', 'asked', 'asked', 'model', 'nego', 'keep', 'won', 'lost', 'new', 'asked'];
  const demoChannels = (await listChannels(db, shop.id)).filter((c) => agents.some((a) => a.name === c.agentName));
  let enriched = 0;
  for (const ch of demoChannels) {
    const chats = await db.query<{ id: number; lastMessageAt: Date }>(
      'SELECT id, last_message_at AS lastMessageAt FROM chats WHERE channel_id = ? AND stage IS NULL ORDER BY last_message_at DESC',
      [ch.id],
    );
    for (const [i, { id, lastMessageAt }] of chats.entries()) {
      const u = Math.floor(rand() * units.length);
      const stage = stageCycle[(i + ch.id) % stageCycle.length];
      await updateLead(db, id, {
        stage,
        interest: units[u],
        dealValue: stage === 'new' ? null : prices[u],
        tags: rand() < 0.6 ? [tagPool[Math.floor(rand() * tagPool.length)]] : [],
      });
      // A working lead whose customer went silent 3+ days ago, with nothing planned: shows under
      // "lead diam" in Hari ini. Every other lead spreads its "time in stage" over the last few days.
      const quiet = ['asked', 'model', 'nego'].includes(stage) && now - new Date(lastMessageAt).getTime() > 3.2 * 86_400_000;
      if (quiet) {
        await db.run('UPDATE chats SET stage_changed_at = last_message_at + INTERVAL 2 HOUR WHERE id = ?', [id]);
      } else {
        await db.run('UPDATE chats SET stage_changed_at = UTC_TIMESTAMP(3) - INTERVAL ? HOUR WHERE id = ?', [
          Math.floor(rand() * 96),
          id,
        ]);
      }
      if (!quiet && ['asked', 'model', 'nego', 'keep'].includes(stage) && rand() < 0.7) {
        const due = new Date(now + (rand() * 4 - 1.2) * 86_400_000); // some overdue, some upcoming
        due.setUTCHours(2 + Math.floor(rand() * 8), 0, 0, 0); // on the hour, 09:00–16:00 WIB
        await addFollowup(db, id, due, pick(['Kabari harga emas hari ini', 'Kirim video detail', 'Tanya jadi ambil?', 'Ingatkan pelunasan keep']));
      }
      if (rand() < 0.35) await addNote(db, id, pick(['Minta ongkos bikin dipotong', 'Domisili Bekasi, mau ambil di toko', 'Ukuran cincin 14, buat hadiah ulang tahun']));
      enriched++;
    }
  }
  log(`CRM data added to ${enriched} demo chats`);

  // One lead per agent that went quiet days ago with nothing planned, for "lead diam" in Hari ini.
  const quietLeads = [
    { name: 'Bu Wati', stage: 'nego', unit: 'Gelang rantai 22K 10 gr', price: 21_800_000, ask: 'Ongkosnya bisa dikurangi kak?', reply: 'Kami cek dulu ke owner ya kak', last: 'Oke saya tunggu kabarnya' },
    { name: 'Rina', stage: 'model', unit: 'Kalung Italy 17K 5 gr', price: 7_900_000, ask: 'Ada model lain yang lebih tipis?', reply: 'Ada kak, ini 3 pilihannya', last: 'Sip, nanti saya pilih dulu' },
    { name: 'Pak Joko', stage: 'asked', unit: 'Logam mulia 24K 5 gr', price: 11_900_000, ask: 'LM 5 gram harganya berapa?', reply: '11,9jt kak, ready di toko', last: 'Boleh, nanti dulu ya' },
  ];
  let quietAdded = 0;
  for (const [i, ch] of demoChannels.entries()) {
    const q = quietLeads[i % quietLeads.length];
    const jid = `62858${String(i).padStart(2, '0')}9999@s.whatsapp.net`;
    if ((await db.query('SELECT 1 FROM chats WHERE channel_id = ? AND remote_jid = ?', [ch.id, jid])).length) continue;
    const at = now - (4 + i) * 86_400_000 - 5 * 3_600_000;
    await saveMessages(db, ch.id, [
      { waId: `quiet-${ch.id}-1`, remoteJid: jid, contactName: q.name, fromMe: false, kind: 'text', body: q.ask, sentAt: new Date(at) },
      { waId: `quiet-${ch.id}-2`, remoteJid: jid, fromMe: true, kind: 'text', body: q.reply, sentAt: new Date(at + 6 * 60_000) },
      { waId: `quiet-${ch.id}-3`, remoteJid: jid, contactName: q.name, fromMe: false, kind: 'text', body: q.last, sentAt: new Date(at + 20 * 60_000) },
      { waId: `quiet-${ch.id}-4`, remoteJid: jid, fromMe: true, kind: 'text', body: 'Siap kak 🙏', sentAt: new Date(at + 24 * 60_000) },
    ]);
    const [{ id }] = await db.query<{ id: number }>('SELECT id FROM chats WHERE channel_id = ? AND remote_jid = ?', [ch.id, jid]);
    await updateLead(db, id, { stage: q.stage, interest: q.unit, dealValue: q.price, tags: [] });
    await db.run('UPDATE chats SET stage_changed_at = last_message_at + INTERVAL 1 HOUR WHERE id = ?', [id]);
    quietAdded++;
  }
  log(`Quiet leads added: ${quietAdded}`);

  // Tuntas history: on most days where the agent had the last word, the chat was marked solved a little
  // after that reply. Only chats with no resolutions yet, so re-running doesn't stack them.
  const demoMessages = await db.query<{ chatId: number; fromMe: boolean; sentAt: Date }>(
    `SELECT m.chat_id AS chatId, m.from_me AS fromMe, m.sent_at AS sentAt
       FROM messages m JOIN chats c ON c.id = m.chat_id JOIN channels ch ON ch.id = c.channel_id
      WHERE ch.shop_id = ? AND NOT EXISTS (SELECT 1 FROM resolutions r WHERE r.chat_id = c.id)
      ORDER BY m.chat_id, m.sent_at`,
    [shop.id],
  );
  const lastOfDay = new Map<string, { chatId: number; fromMe: boolean; sentAt: Date }>();
  for (const m of demoMessages) {
    const wibDay = new Date(new Date(m.sentAt).getTime() + 7 * 3_600_000).toISOString().slice(0, 10);
    lastOfDay.set(`${m.chatId}:${wibDay}`, m);
  }
  let resolvedDays = 0;
  for (const m of lastOfDay.values()) {
    if (!m.fromMe || rand() > 0.75) continue;
    const at = new Date(new Date(m.sentAt).getTime() + (4 + rand() * 80) * 60_000);
    if (at.getTime() > Date.now()) continue;
    await db.run('INSERT INTO resolutions (chat_id, resolved_at) VALUES (?, ?)', [m.chatId, at]);
    resolvedDays++;
  }
  log(`Tuntas history added for ${resolvedDays} chat-days`);
}
