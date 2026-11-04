// Interface language. Texts are written in Indonesian in the code; t() returns the English
// version when English is selected. {name} placeholders are filled from `vars`.
// Unknown texts (e.g. custom stage names) are shown as they are.

export const LANGS = [
  { id: 'id', label: 'Bahasa Indonesia', short: 'ID' },
  { id: 'en', label: 'English', short: 'EN' },
];

function readLang() {
  try {
    const v = localStorage.getItem('lang');
    if (v === 'id' || v === 'en') return v;
  } catch {}
  return 'id';
}

let lang = readLang();
document.documentElement.lang = lang;

export const getLang = () => lang;
export const locale = () => (lang === 'en' ? 'en-GB' : 'id-ID');

/** Saves the choice and reloads, so every view renders in the new language. */
export function setLang(next) {
  if (next === lang) return;
  try {
    localStorage.setItem('lang', next);
  } catch {}
  location.reload();
}

export function t(text, vars) {
  let out = lang === 'en' ? (EN[text] ?? text) : text;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v));
  return out;
}

const EN = {
  // navigation & shell
  Chat: 'Chats',
  chat: 'chats',
  Pipeline: 'Pipeline',
  'Follow-up': 'Follow-ups',
  Laporan: 'Reports',
  'Nomor WA': 'Numbers',
  'Nomor WhatsApp': 'WhatsApp numbers',
  Pengaturan: 'Settings',
  Inbox: 'Inbox',
  Cari: 'Search',
  Tema: 'Theme',
  Sistem: 'System',
  Terang: 'Light',
  Gelap: 'Dark',
  Bahasa: 'Language',
  'Akun demo': 'Demo account',
  'Server tidak bisa dihubungi': "Can't reach the server",
  'Koneksi ke server terputus, mencoba lagi…': 'Lost connection to the server, retrying…',
  'Tersambung lagi': 'Reconnected',

  // login
  'Masuk untuk melihat chat dan laporan': 'Sign in to see chats and reports',
  Username: 'Username',
  Password: 'Password',
  Masuk: 'Sign in',
  'Coba dulu? Masuk dengan {cred}': 'Just looking? Sign in with {cred}',
  'Username atau password salah': 'Wrong username or password',
  'Terlalu banyak percobaan. Coba lagi 15 menit.': 'Too many attempts. Try again in 15 minutes.',

  // time & dates
  'Hari ini': 'Today',
  Kemarin: 'Yesterday',
  Besok: 'Tomorrow',
  Nanti: 'Later',
  Terlambat: 'Overdue',
  '7 hari': '7 days',
  '30 hari': '30 days',
  '3 hari': '3 days',
  '1 minggu': '1 week',
  '3 hari lagi': 'In 3 days',
  'Minggu depan': 'Next week',
  'Besok 09.00': 'Tomorrow 09:00',
  'Nanti, {time}': 'Later, {time}',
  'Pilih tanggal…': 'Pick a date…',
  Minggu: 'Sunday',
  Senin: 'Monday',
  Selasa: 'Tuesday',
  Rabu: 'Wednesday',
  Kamis: 'Thursday',
  Jumat: 'Friday',
  Sabtu: 'Saturday',

  // pipeline stages (default names)
  Baru: 'New',
  'Tanya harga': 'Asked price',
  'Survey / test ride': 'Visit / test ride',
  Nego: 'Negotiation',
  DP: 'Down payment',
  Deal: 'Won',
  Batal: 'Lost',
  'Bukan lead': 'Not a lead',
  'tanpa tahap': 'no stage',

  // inbox
  Semua: 'All',
  'Belum dibalas': 'Unreplied',
  Leads: 'Leads',
  'Semua sales': 'All agents',
  'Cari nama, nomor, unit…': 'Search name, number, bike…',
  'Daftar chat': 'Chat list',
  'Belum ada nomor WhatsApp': 'No WhatsApp numbers yet',
  'Hubungkan nomor sales untuk mulai memantau chat.': 'Link a sales number to start monitoring chats.',
  'Hubungkan nomor': 'Link number',
  'Tidak ada chat yang cocok': 'No matching chats',
  'Coba kata kunci lain atau hapus filter.': 'Try another keyword or clear the filters.',
  'Hapus filter': 'Clear filters',
  'Belum ada chat': 'No chats yet',
  'Chat baru akan muncul di sini begitu customer mengirim pesan.': 'New chats appear here as soon as a customer sends a message.',
  'Pilih chat untuk mulai': 'Pick a chat to start',
  'Klik kanan chat untuk pindah tahap atau jadwalkan follow-up.': 'Right-click a chat to change its stage or schedule a follow-up.',
  cari: 'search',
  'pindah chat': 'switch chat',
  'balasan cepat': 'quick replies',
  tutup: 'close',

  // conversation
  'Chat tidak bisa dibuka': "This chat can't be opened",
  'Ke pesan terbaru': 'Jump to latest',
  Kembali: 'Back',
  'Jadikan lead': 'Make it a lead',
  'Jadwalkan follow-up': 'Schedule follow-up',
  'Detail lead': 'Lead details',
  'Ingatkan follow-up': 'Remind me to follow up',
  'Belum ada pesan di chat ini': 'No messages in this chat yet',
  'Muat pesan sebelumnya': 'Load earlier messages',
  'dibalas setelah {d}': 'replied after {d}',
  'Salin teks': 'Copy text',
  'Kirim ulang': 'Resend',
  'Simpan sebagai catatan': 'Save as note',
  'Mode demo: mengirim pesan WhatsApp dinonaktifkan.': 'Demo mode: sending WhatsApp messages is turned off.',
  'Nomor {name} tidak terhubung, jadi balasan belum bisa dikirim dari sini.':
    "{name}'s number isn't connected, so replies can't be sent from here yet.",
  Hubungkan: 'Connect',
  'Ketik pesan · / untuk balasan cepat': 'Type a message · / for quick replies',
  Kirim: 'Send',
  'Belum ada balasan cepat “{q}”. Tambahkan di Pengaturan.': 'No quick reply “{q}” yet. Add one in Settings.',
  'Pesan gagal terkirim: {e}': 'Message not sent: {e}',
  'Coba lagi': 'Retry',
  'Nama kontak': 'Contact name',
  'Salin nomor': 'Copy number',
  'Ditangani {name}': 'Handled by {name}',
  Tahap: 'Stage',
  Detail: 'Details',
  'Unit diminati': 'Bike of interest',
  'mis. Vario 125 2019 hitam': 'e.g. black Vario 125 2019',
  'Nilai deal (Rp)': 'Deal value (Rp)',
  Tag: 'Tags',
  'Hapus tag': 'Remove tag',
  'kredit, tukar tambah…': 'credit, trade-in…',
  'Belum ada follow-up': 'No follow-ups yet',
  'Catatan, mis. kabari harga nett': 'Note, e.g. send final price',
  'Tambah follow-up': 'Add follow-up',
  Catatan: 'Notes',
  'Catatan internal, tidak terkirim ke customer': "Internal note, not sent to the customer",
  'Simpan catatan': 'Save note',

  // lead actions
  'Buka chat': 'Open chat',
  'Pindahkan ke tahap': 'Move to stage',
  'Follow-up besok 09.00': 'Follow up tomorrow 09:00',
  'Tandai sudah dibaca': 'Mark as read',
  'Gagal menyimpan: {e}': "Couldn't save: {e}",
  Urungkan: 'Undo',
  'Follow-up dijadwalkan': 'Follow-up scheduled',
  Disalin: 'Copied',
  'Tidak bisa menyalin': "Couldn't copy",

  // follow-ups view
  'Belum selesai': 'To do',
  'Tidak ada follow-up di sini': 'No follow-ups here',
  'Coba filter lain untuk melihat pengingat yang lain.': 'Try another filter to see other reminders.',
  'Lihat semua': 'See all',
  '{n} belum selesai': '{n} to do',
  '{n} terlambat': '{n} overdue',
  'Tidak ada follow-up': 'No follow-ups',
  'Jadwalkan dari chat lewat tombol jam, atau klik kanan chat → Follow-up besok.':
    'Schedule one from a chat with the clock button, or right-click a chat → Follow up tomorrow.',
  Selesai: 'Done',
  'Tandai selesai': 'Mark done',
  'Follow-up selesai': 'Follow-up done',
  'Pilih follow-up': 'Pick a follow-up',
  'Chat-nya terbuka di sini, lengkap dengan catatan dan tahap lead.': 'Its chat opens here, with notes and the lead stage.',

  // pipeline
  'Cari lead…': 'Search leads…',
  'Lama di tahap ini': 'Time in this stage',
  '{n} lead aktif · {v} di pipeline': '{n} active leads · {v} in pipeline',
  'Pipeline masih kosong': 'The pipeline is empty',
  'Chat baru dari customer otomatis masuk ke tahap “Baru”. Chat lama bisa dijadikan lead lewat klik kanan di Inbox.':
    'New customer chats land in “New” automatically. Older chats can be made leads by right-clicking them in the Inbox.',
  'Buka Inbox': 'Open Inbox',
  'Tarik lead ke sini': 'Drag leads here',

  // reports
  'Belum ada data': 'No data yet',
  'Hubungkan nomor sales untuk mulai mengukur kecepatan balas.': 'Link a sales number to start measuring reply times.',
  'Dibalas ≤{m} mnt': 'Replied ≤{m} min',
  '{a} dari {b}': '{a} of {b}',
  'Respon pertama': 'First response',
  'rata-rata, jam buka': 'average, opening hours',
  'Median balas': 'Median reply',
  '{n} balasan jam buka': '{n} replies in opening hours',
  '{n} di luar jam': '{n} after hours',
  'Menunggu balasan': 'Waiting for reply',
  '{n} lewat target': '{n} past target',
  '{n} percakapan baru': '{n} new conversations',
  'Performa per sales': 'Performance per agent',
  Sales: 'Agent',
  Median: 'Median',
  Telat: 'Late',
  'belum terhubung': 'not linked',
  'Semua chat sudah dibalas 👍': 'Every chat has been answered 👍',
  'Pipeline saat ini': 'Current pipeline',
  'Waktu balas dihitung hanya selama jam buka. Chat yang ditanya dan dibalas saat tutup dihitung tepat waktu, tapi tidak masuk median.':
    'Reply times only count opening hours. Chats asked and answered while closed count as on time but are left out of the median.',

  // numbers
  'Satu nomor = satu sales. Chat dan laporan dipisah per nomor.': 'One number = one agent. Chats and reports are split per number.',
  'Nama sales, mis. Andi': 'Agent name, e.g. Andi',
  'Di HP sales: WhatsApp → Perangkat tertaut → Tautkan perangkat → scan QR. Pakai untuk membalas customer saja, jangan untuk broadcast massal: nomor bisa diblokir.':
    "On the agent's phone: WhatsApp → Linked devices → Link a device → scan the QR. Use it to reply to customers only, never for bulk broadcasts: the number can get banned.",
  'Belum ada nomor': 'No numbers yet',
  'Masukkan nama sales di atas, lalu scan QR dari HP-nya.': "Enter the agent's name above, then scan the QR with their phone.",
  Terhubung: 'Connected',
  'Menunggu scan QR': 'Waiting for QR scan',
  'Menghubungkan…': 'Connecting…',
  Terputus: 'Disconnected',
  'Logout dari HP': 'Logged out on phone',
  'Nomor belum tertaut': 'Number not linked yet',
  'Hubungkan ulang': 'Reconnect',
  Hapus: 'Remove',
  'Putuskan nomor {name} dan hapus semua chat-nya dari dashboard?': "Disconnect {name}'s number and remove all its chats from the dashboard?",

  // settings
  Tampilan: 'Appearance',
  'Sistem mengikuti pengaturan terang/gelap perangkat.': "System follows your device's light/dark setting.",
  'Bahasa tampilan dashboard di perangkat ini.': 'Dashboard language on this device.',
  Akun: 'Account',
  'Masuk sebagai {user}': 'Signed in as {user}',
  'Keluar dari dashboard di perangkat ini.': 'Sign out of the dashboard on this device.',
  Keluar: 'Sign out',
  'Usaha & SLA': 'Business & SLA',
  'Nama usaha': 'Business name',
  'Zona waktu': 'Time zone',
  'Target balas (menit)': 'Reply target (minutes)',
  'Jam buka (dipakai untuk menghitung SLA)': 'Opening hours (used to calculate SLA)',
  'Laporan harian ke owner': 'Daily report to the owner',
  'No. WA owner': "Owner's WhatsApp number",
  'Jam kirim': 'Send at',
  Simpan: 'Save',
  'Lihat laporan': 'Preview report',
  'Kirim sekarang': 'Send now',
  'Balasan cepat': 'Quick replies',
  'Ketik / di kolom chat untuk memakainya.': 'Type / in the chat box to use them.',
  'Isi pesan': 'Message',
  'Tahap pipeline': 'Pipeline stages',
  'Pengaturan disimpan': 'Settings saved',
  'Laporan terkirim ke WA owner': "Report sent to the owner's WhatsApp",
  'Belum ada balasan cepat.': 'No quick replies yet.',

  // command palette
  'Chat belum dibalas': 'Unreplied chats',
  'Cari chat, nomor, atau perintah…': 'Search chats, numbers or commands…',
  pilih: 'select',
  buka: 'open',
  Perintah: 'Commands',
  'Chat terbaru': 'Recent chats',
  'Tidak ada hasil untuk “{q}”': 'No results for “{q}”',

  // tuntas (problem solved)
  Tuntas: 'Resolved',
  'Tandai tuntas': 'Mark resolved',
  'Belum tuntas': 'Unresolved',
  'Buka lagi': 'Reopen',
  'Ditandai tuntas': 'Marked resolved',
  'Tuntas — tekan untuk membuka lagi': 'Resolved — tap to reopen',
  'median {d}': 'median {d}',

  // server messages
  'Akun demo tidak bisa melakukan ini': "The demo account can't do this",
  'tidak ditemukan': 'not found',
  'Nomor WhatsApp untuk chat ini sedang tidak terhubung': "This chat's WhatsApp number isn't connected",
  'pesan kosong': 'empty message',
  'catatan kosong': 'empty note',
  'tanggal tidak valid': 'invalid date',
  'shortcut dan isi wajib diisi': 'shortcut and message are required',
  'Nomor WA owner belum diisi': "The owner's WhatsApp number isn't set",
};
