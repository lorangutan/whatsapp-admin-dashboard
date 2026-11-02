// Fills the database with fake chats for 3 sales agents, so the dashboard can be explored
// without linking a real phone. Run: npm run seed
import { openDb } from './db/index.js';
import {
  addFollowup, addNote, createChannel, getShop, listChannels, saveMessages, setChannelStatus, updateLead,
} from './db/repo.js';
import type { InboundMessage } from './channels/types.js';

const db = await openDb();
const shop = await getShop(db);

const customers = ['Pak Rudi', 'Mas Dimas', 'Bu Sari', 'Agus', 'Rizky', 'Hendra', 'Yoga', 'Fajar', 'Dewi', 'Bayu'];
const asks = [
  'Gan, Vario 2019 masih ada?',
  'Harga nett berapa ya?',
  'Bisa kredit? DP minimal berapa',
  'Surat lengkap? Pajak hidup?',
  'Bisa tukar tambah Beat lama saya?',
  'Servis CVT berapa ongkosnya',
  'Besok bisa lihat unit jam berapa?',
];
const replies = ['Masih ada kak 🙏', 'Nett 17,5jt kak', 'Bisa, DP mulai 2jt', 'Lengkap kak, pajak panjang', 'Bisa kak, kirim foto unitnya ya', 'Mulai 150rb kak'];

// Each agent has a typical response speed (minutes) and a chance of leaving a chat unanswered.
const agents = [
  { name: 'Andi', speed: 4, ignore: 0.05 },
  { name: 'Budi', speed: 18, ignore: 0.2 },
  { name: 'Citra', speed: 9, ignore: 0.1 },
];

let rng = 42;
const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647);
const pick = <T>(a: T[]) => a[Math.floor(rand() * a.length)];

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
          messages.push({ waId: `seed-${ai}-${seq++}`, remoteJid: jid, contactName: customer, fromMe: false, kind: 'text', body: pick(asks), sentAt: new Date(t) });
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
  console.log(`${agent.name}: ${messages.length} messages`);
}

// CRM demo data on the fake agents' chats only (never on a real linked number).
const units = ['Vario 125 2019', 'Beat Street 2021', 'NMAX 2020', 'Scoopy 2022', 'Aerox 155 2019', 'PCX 160 2021', 'CBR150R 2018'];
const prices = [17_500_000, 14_200_000, 24_900_000, 18_300_000, 19_750_000, 27_000_000, 21_500_000];
const tagPool = ['kredit', 'cash', 'tukar tambah', 'luar kota', 'minta video'];
const stageCycle = ['new', 'asked', 'asked', 'visit', 'nego', 'dp', 'won', 'lost', 'new', 'asked'];
const demoChannels = (await listChannels(db, shop.id)).filter((c) => agents.some((a) => a.name === c.agentName));
let enriched = 0;
for (const ch of demoChannels) {
  const chats = await db.query<{ id: number }>(
    'SELECT id FROM chats WHERE channel_id = $1 AND stage IS NULL ORDER BY last_message_at DESC',
    [ch.id],
  );
  for (const [i, { id }] of chats.entries()) {
    const u = Math.floor(rand() * units.length);
    const stage = stageCycle[(i + ch.id) % stageCycle.length];
    await updateLead(db, id, {
      stage,
      interest: units[u],
      dealValue: stage === 'new' ? null : prices[u],
      tags: rand() < 0.6 ? [tagPool[Math.floor(rand() * tagPool.length)]] : [],
    });
    // Spread "time in stage" over the last few days.
    await db.query(`UPDATE chats SET stage_changed_at = now() - ($2 || ' hours')::interval WHERE id = $1`, [
      id,
      String(Math.floor(rand() * 96)),
    ]);
    if (['asked', 'visit', 'nego', 'dp'].includes(stage) && rand() < 0.7) {
      const due = new Date(now + (rand() * 4 - 1.2) * 86_400_000); // some overdue, some upcoming
      due.setMinutes(0, 0, 0);
      await addFollowup(db, id, due, pick(['Kabari harga nett', 'Tanya jadi survey?', 'Kirim simulasi kredit', 'Konfirmasi DP']));
    }
    if (rand() < 0.35) await addNote(db, id, pick(['Minta harga nett, nego di 17jt', 'Domisili Bekasi, mau COD', 'Kerja karyawan swasta, slip gaji ada']));
    enriched++;
  }
}
console.log(`CRM data added to ${enriched} demo chats`);

await db.close();
