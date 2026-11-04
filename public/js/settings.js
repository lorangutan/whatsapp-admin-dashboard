// Settings: business hours & SLA, daily report, quick replies.
import { api, $, $$, esc, icon, toast, THEMES, getThemePref, setThemePref } from './lib.js';
import { store } from './store.js';
import { t, getLang, setLang, LANGS } from './i18n.js';

const DAYS = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];

export function mountSettings({ main }) {
  const s = store.shop;
  main.innerHTML = `<div class="page">
    <div class="page-head"><h1>${t('Pengaturan')}</h1></div>
    <div class="settings">
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin-bottom:4px">${t('Tampilan')}</h2><div class="muted small">${t('Sistem mengikuti pengaturan terang/gelap perangkat.')}</div></div>
        <div class="segmented" id="st-theme" role="radiogroup" aria-label="${t('Tema')}">
          ${THEMES.map((th) => `<button type="button" role="radio" data-theme-id="${th.id}">${icon(th.icon, 15)} ${th.label}</button>`).join('')}
        </div>
      </div>
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin-bottom:4px">${t('Bahasa')}</h2><div class="muted small">${t('Bahasa tampilan dashboard di perangkat ini.')}</div></div>
        <div class="segmented" role="radiogroup" aria-label="${t('Bahasa')}">
          ${LANGS.map((l) => `<button type="button" role="radio" data-lang="${l.id}" class="${getLang() === l.id ? 'active' : ''}">${l.label}</button>`).join('')}
        </div>
      </div>
      <div class="card" style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <div><h2 style="margin-bottom:4px">${t('Akun')}</h2><div class="muted small">${t('Masuk sebagai {user}', { user: `<b>${esc(store.session?.username ?? '')}</b>` })} · ${t('Keluar dari dashboard di perangkat ini.')}</div></div>
        <button class="btn danger" type="button" id="st-logout">${t('Keluar')}</button>
      </div>
      <form class="card owner-only" id="st-form" style="display:grid;gap:12px">
        <h2>${t('Usaha & SLA')}</h2>
        <div class="row2">
          <label class="field">${t('Nama usaha')} <input class="input" name="name" value="${esc(s.name)}"></label>
          <label class="field">${t('Zona waktu')}
            <select class="input" name="utcOffsetMinutes">
              ${[[420, 'WIB (UTC+7)'], [480, 'WITA (UTC+8)'], [540, 'WIT (UTC+9)']].map(([v, l]) => `<option value="${v}" ${s.utcOffsetMinutes === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select></label>
          <label class="field">${t('Target balas (menit)')} <input class="input" name="slaTargetMinutes" type="number" min="1" value="${s.slaTargetMinutes}"></label>
        </div>
        <div>
          <div class="field" style="margin-bottom:4px">${t('Jam buka (dipakai untuk menghitung SLA)')}</div>
          ${DAYS.map((d, i) => {
            const [open, close] = s.businessHours[i]?.[0] ?? ['08:00', '17:00'];
            return `<div class="day-row">
              <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-day="${i}" ${s.businessHours[i]?.length ? 'checked' : ''} style="accent-color:var(--accent)"> ${t(d)}</label>
              <input class="input" type="time" data-open="${i}" value="${open}">
              <input class="input" type="time" data-close="${i}" value="${close}">
            </div>`;
          }).join('')}
        </div>
        <h2 style="margin-top:6px">${t('Laporan harian ke owner')}</h2>
        <div class="row2">
          <label class="field">${t('No. WA owner')} <input class="input" name="ownerWa" value="${esc(s.ownerWa ?? '')}" placeholder="62812…"></label>
          <label class="field">${t('Jam kirim')} <input class="input" name="reportTime" type="time" value="${esc(s.reportTime ?? '')}"></label>
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn" type="submit">${t('Simpan')}</button>
          <button class="btn ghost" type="button" id="st-preview">${t('Lihat laporan')}</button>
          <button class="btn ghost" type="button" id="st-send">${t('Kirim sekarang')}</button>
        </div>
        <pre class="report-preview" id="st-out" hidden></pre>
      </form>

      <div class="card owner-only" style="display:grid;gap:8px">
        <h2>${t('Balasan cepat')}</h2>
        <div class="faint small">${t('Ketik / di kolom chat untuk memakainya.')}</div>
        <div id="st-qr"></div>
        <form id="st-qr-add" class="qr-row" style="border:0">
          <input class="input" name="shortcut" placeholder="/shortcut" required>
          <textarea class="input" name="body" rows="2" placeholder="${t('Isi pesan')}" required></textarea>
          <button class="btn" type="submit">${icon('plus', 16)}</button>
        </form>
      </div>

      <div class="card">
        <h2>${t('Tahap pipeline')}</h2>
        <div style="display:flex;gap:6px;flex-wrap:wrap">${s.pipelineStages.map((st) => `<span class="pill ${st.outcome === 'won' ? 'won' : st.outcome === 'lost' ? 'lost' : 'stage'}">${esc(t(st.name))}</span>`).join('')}</div>
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
  for (const b of $$('[data-lang]', main)) b.onclick = () => setLang(b.dataset.lang);
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
      toast(t('Pengaturan disimpan'));
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
      toast(t('Laporan terkirim ke WA owner'));
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
      <button class="icon-btn" data-del="${r.id}" aria-label="${t('Hapus')}">${icon('trash', 16)}</button></div>`).join('')
      || `<div class="muted small">${t('Belum ada balasan cepat.')}</div>`;
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
