// Settings: business hours & SLA, daily report, quick replies.
import { api, $, $$, esc, icon, toast, THEMES, getThemePref, setThemePref } from './lib.js';
import { store } from './store.js';

const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

export function mountSettings({ main }) {
  const s = store.shop;
  main.innerHTML = `<div class="page">
    <div class="page-head"><h1>Pengaturan</h1></div>
    <div class="settings">
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin-bottom:4px">Tampilan</h2><div class="muted small">Sistem mengikuti pengaturan terang/gelap perangkat.</div></div>
        <div class="segmented" id="st-theme" role="radiogroup" aria-label="Tema">
          ${THEMES.map((t) => `<button type="button" role="radio" data-theme-id="${t.id}">${icon(t.icon, 15)} ${t.label}</button>`).join('')}
        </div>
      </div>
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin-bottom:4px">Akun</h2><div class="muted small">Keluar dari dashboard di perangkat ini.</div></div>
        <button class="btn danger" type="button" id="st-logout">Keluar</button>
      </div>
      <form class="card" id="st-form" style="display:grid;gap:12px">
        <h2>Usaha & SLA</h2>
        <div class="row2">
          <label class="field">Nama usaha <input class="input" name="name" value="${esc(s.name)}"></label>
          <label class="field">Zona waktu
            <select class="input" name="utcOffsetMinutes">
              ${[[420, 'WIB (UTC+7)'], [480, 'WITA (UTC+8)'], [540, 'WIT (UTC+9)']].map(([v, l]) => `<option value="${v}" ${s.utcOffsetMinutes === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
          <label class="field">Target balas (menit) <input class="input" name="slaTargetMinutes" type="number" min="1" value="${s.slaTargetMinutes}"></label>
        </div>
        <div>
          <div class="field" style="margin-bottom:4px">Jam buka (dipakai untuk menghitung SLA)</div>
          ${DAYS.map((d, i) => {
            const [open, close] = s.businessHours[i]?.[0] ?? ['08:00', '17:00'];
            return `<div class="day-row">
              <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-day="${i}" ${s.businessHours[i]?.length ? 'checked' : ''} style="accent-color:var(--accent)"> ${d}</label>
              <input class="input" type="time" data-open="${i}" value="${open}">
              <input class="input" type="time" data-close="${i}" value="${close}">
            </div>`;
          }).join('')}
        </div>
        <h2 style="margin-top:6px">Laporan harian ke owner</h2>
        <div class="row2">
          <label class="field">No. WA owner <input class="input" name="ownerWa" value="${esc(s.ownerWa ?? '')}" placeholder="62812…"></label>
          <label class="field">Jam kirim <input class="input" name="reportTime" type="time" value="${esc(s.reportTime ?? '')}"></label>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" type="submit">Simpan</button>
          <button class="btn ghost" type="button" id="st-preview">Lihat laporan</button>
          <button class="btn ghost" type="button" id="st-send">Kirim sekarang</button>
        </div>
        <pre class="report-preview" id="st-out" hidden></pre>
      </form>

      <div class="card" style="display:grid;gap:8px">
        <h2>Balasan cepat</h2>
        <div class="faint small">Ketik <kbd>/</kbd> di kolom chat untuk memakainya.</div>
        <div id="st-qr"></div>
        <form id="st-qr-add" class="qr-row" style="border:0">
          <input class="input" name="shortcut" placeholder="/shortcut" required>
          <textarea class="input" name="body" rows="2" placeholder="Isi pesan" required></textarea>
          <button class="btn" type="submit">${icon('plus', 16)}</button>
        </form>
      </div>

      <div class="card">
        <h2>Tahap pipeline</h2>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${s.pipelineStages.map((st) => `<span class="pill ${st.outcome === 'won' ? 'won' : st.outcome === 'lost' ? 'lost' : 'stage'}">${esc(st.name)}</span>`).join('')}</div>
      </div>
    </div>
  </div>`;

  const markTheme = () => {
    for (const b of $$('[data-theme-id]', main)) {
      const on = b.dataset.themeId === getThemePref();
      b.classList.toggle('active', on);
      b.setAttribute('aria-checked', on);
    }
  };
  for (const b of $$('[data-theme-id]', main)) b.onclick = () => setThemePref(b.dataset.themeId);
  addEventListener('themechange', markTheme);
  markTheme();
  $('#st-logout', main).onclick = () => window.dispatchEvent(new Event('wamon-logout'));

  const form = $('#st-form', main);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const businessHours = {};
    DAYS.forEach((_, i) => {
      if ($(`[data-day="${i}"]`, form).checked) businessHours[i] = [[$(`[data-open="${i}"]`, form).value, $(`[data-close="${i}"]`, form).value]];
    });
    try {
      store.shop = await api('/api/shop', {
        method: 'PUT',
        body: {
          name: form.name.value.trim(),
          utcOffsetMinutes: Number(form.utcOffsetMinutes.value),
          slaTargetMinutes: Number(form.slaTargetMinutes.value),
          ownerWa: form.ownerWa.value.replace(/\D/g, '') || null,
          reportTime: form.reportTime.value || null,
          businessHours,
        },
      });
      document.title = `${store.shop.name} · Wamon`;
      toast('Pengaturan disimpan');
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
  $('#st-preview', main).onclick = async () => {
    const { text } = await api('/api/report/daily-preview');
    const out = $('#st-out', main);
    out.textContent = text;
    out.hidden = false;
  };
  $('#st-send', main).onclick = async () => {
    try {
      await api('/api/report/send', { method: 'POST' });
      toast('Laporan terkirim ke WA owner');
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  renderReplies();
  $('#st-qr-add', main).onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget;
    try {
      const saved = await api('/api/quick-replies', { method: 'POST', body: { shortcut: f.shortcut.value, body: f.body.value } });
      store.quickReplies = [...store.quickReplies.filter((r) => r.id !== saved.id), saved].sort((a, b) => a.shortcut.localeCompare(b.shortcut));
      f.reset();
      renderReplies();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  function renderReplies() {
    const host = $('#st-qr', main);
    host.innerHTML = store.quickReplies.map((r) => `<div class="qr-row">
      <b class="good">/${esc(r.shortcut)}</b><span class="small">${esc(r.body)}</span>
      <button class="icon-btn" data-del="${r.id}" aria-label="Hapus">${icon('trash', 16)}</button></div>`).join('')
      || '<div class="muted small">Belum ada balasan cepat.</div>';
    for (const b of $$('[data-del]', host)) {
      b.onclick = async () => {
        const id = Number(b.dataset.del);
        const removed = store.quickReplies.find((r) => r.id === id);
        store.quickReplies = store.quickReplies.filter((r) => r.id !== id);
        renderReplies();
        try {
          await api(`/api/quick-replies/${id}`, { method: 'DELETE' });
        } catch (err) {
          store.quickReplies.push(removed);
          renderReplies();
          toast(err.message, { error: true });
        }
      };
    }
  }

  return {
    onLive() {},
    destroy() {
      removeEventListener('themechange', markTheme);
    },
  };
}
