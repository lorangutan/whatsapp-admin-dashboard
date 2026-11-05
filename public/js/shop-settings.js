// Settings cards for how a shop sells and how it wants its metrics judged:
// the pipeline stage editor and the metric preferences.
import { api, $, $$, esc, icon, toast } from './lib.js';
import { store } from './store.js';
import { t } from './i18n.js';

const OUTCOMES = [
  { id: '', label: 'Proses' },
  { id: 'won', label: 'Deal' },
  { id: 'lost', label: 'Batal' },
];

async function saveShop(patch, done) {
  try {
    store.shop = await api('/api/shop', { method: 'PUT', body: patch });
    toast(done);
    return true;
  } catch (err) {
    toast(err.message, { error: true });
    return false;
  }
}

/**
 * The demo account sees these cards so visitors know what a shop can set, but cannot change them
 * (the server refuses anyway). Buttons listed in `keep` only read, so they stay usable.
 */
function lockForDemo(host, keep = []) {
  if (store.session?.role !== 'demo') return;
  for (const el of host.querySelectorAll('input, select, textarea, button')) {
    if (!keep.includes(el.id)) el.disabled = true;
  }
  if (!host.querySelector('.demo-note')) {
    host.querySelector('h2')?.insertAdjacentHTML('afterend', `<div class="demo-note">${icon('eye', 14)} ${t('Akun demo: hanya bisa dilihat')}</div>`);
  }
}

/** Ids stay fixed when a stage is renamed, so leads keep their stage; new stages get a fresh id. */
function newStageId(name) {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'tahap';
  return `${slug}-${Math.random().toString(36).slice(2, 6)}`;
}

export function mountStageEditor(host) {
  let rows = store.shop.pipelineStages.map((s) => ({ ...s }));

  function render() {
    host.innerHTML = `
      <h2>${t('Tahap pipeline')}</h2>
      <p class="faint small" style="margin:-4px 0 4px">${t('Lead baru masuk ke tahap pertama. Tahap Deal dan Batal menutup lead.')}</p>
      <div class="stage-rows">${rows.map((s, i) => `
        <div class="stage-row" data-i="${i}">
          <div class="stage-move">
            <button class="icon-btn" type="button" data-up="${i}" ${i === 0 ? 'disabled' : ''} aria-label="${t('Naikkan')}">${icon('down', 16, 'style="transform:rotate(180deg)"')}</button>
            <button class="icon-btn" type="button" data-down="${i}" ${i === rows.length - 1 ? 'disabled' : ''} aria-label="${t('Turunkan')}">${icon('down', 16)}</button>
          </div>
          <input class="input" data-name="${i}" value="${esc(s.name)}" maxlength="40" aria-label="${t('Nama tahap')}">
          <select class="input" data-outcome="${i}" aria-label="${t('Jenis tahap')}" ${i === 0 ? 'disabled' : ''}>
            ${OUTCOMES.map((o) => `<option value="${o.id}" ${(s.outcome ?? '') === o.id ? 'selected' : ''}>${t(o.label)}</option>`).join('')}
          </select>
          <button class="icon-btn" type="button" data-del="${i}" ${rows.length <= 2 ? 'disabled' : ''} aria-label="${t('Hapus')}">${icon('trash', 16)}</button>
        </div>`).join('')}
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn ghost" type="button" id="stg-add">${icon('plus', 15)} ${t('Tambah tahap')}</button>
        <button class="btn" type="button" id="stg-save">${t('Simpan tahap')}</button>
      </div>
      <p class="faint small" id="stg-note" hidden></p>`;
    lockForDemo(host);

    for (const inp of $$('[data-name]', host)) inp.oninput = () => (rows[Number(inp.dataset.name)].name = inp.value);
    for (const sel of $$('[data-outcome]', host)) {
      sel.onchange = () => {
        const r = rows[Number(sel.dataset.outcome)];
        if (sel.value) r.outcome = sel.value;
        else delete r.outcome;
      };
    }
    const swap = (a, b) => {
      [rows[a], rows[b]] = [rows[b], rows[a]];
      delete rows[0].outcome; // the first stage must stay a working stage
      render();
    };
    for (const b of $$('[data-up]', host)) b.onclick = () => swap(Number(b.dataset.up), Number(b.dataset.up) - 1);
    for (const b of $$('[data-down]', host)) b.onclick = () => swap(Number(b.dataset.down), Number(b.dataset.down) + 1);
    for (const b of $$('[data-del]', host)) {
      b.onclick = () => {
        rows.splice(Number(b.dataset.del), 1);
        delete rows[0].outcome;
        render();
        const note = $('#stg-note', host);
        note.textContent = t('Lead di tahap yang dihapus akan pindah ke "{stage}" saat disimpan.', { stage: rows[0].name });
        note.hidden = false;
      };
    }
    $('#stg-add', host).onclick = () => {
      // New stages go before the closing stages, where working stages belong.
      const at = rows.findIndex((r) => r.outcome);
      rows.splice(at < 0 ? rows.length : at, 0, { id: '', name: '' });
      render();
      $$('[data-name]', host)[at < 0 ? rows.length - 1 : at]?.focus();
    };
    $('#stg-save', host).onclick = async () => {
      const stages = rows.map((r) => ({ ...r, name: r.name.trim(), id: r.id || newStageId(r.name.trim()) }));
      if (stages.some((s) => !s.name)) return toast(t('Setiap tahap perlu nama'), { error: true });
      if (await saveShop({ pipelineStages: stages }, t('Tahap disimpan'))) {
        rows = store.shop.pipelineStages.map((s) => ({ ...s }));
        render();
      }
    };
  }
  render();
}

export function mountMetricSettings(host) {
  const p = structuredClone(store.shop.prefs);
  const box = (key, label) =>
    `<label class="check"><input type="checkbox" data-metric="${key}" ${p.metrics[key] ? 'checked' : ''}> ${label}</label>`;

  host.innerHTML = `
    <h2>${t('Metrik')}</h2>
    <div class="row2">
      <label class="field">${t('SLA hijau mulai (%)')}<input class="input" type="number" min="1" max="100" id="mt-good" value="${p.slaGoodPct}"></label>
      <label class="field">${t('SLA kuning mulai (%)')}<input class="input" type="number" min="0" max="100" id="mt-warn" value="${p.slaWarnPct}"></label>
    </div>
    <div class="sla-preview" id="mt-preview" aria-live="polite"></div>
    <label class="field">${t('Percakapan baru setelah diam (jam)')}
      <input class="input" type="number" min="1" max="168" id="mt-gap" value="${p.conversationGapHours}" style="max-width:160px">
      <span class="faint small">${t('Dipakai untuk respon pertama dan tuntas. Standarnya 24 jam.')}</span></label>
    <label class="check"><input type="checkbox" id="mt-auto" ${p.autoResolveOnClose ? 'checked' : ''}> ${t('Lead yang masuk Deal atau Batal otomatis tuntas')}</label>
    <div class="field">${t('Tampilkan di Laporan dan laporan harian')}
      <div class="checks">${box('firstResponse', t('Respon pertama'))}${box('median', t('Median balas'))}${box('resolution', t('Tuntas'))}${box('deals', t('Deal'))}</div>
      <span class="faint small">${t('"Dibalas tepat waktu" selalu tampil.')}</span></div>
    <div><button class="btn" type="button" id="mt-save">${t('Simpan metrik')}</button></div>`;
  lockForDemo(host);

  const preview = () => {
    const good = Number($('#mt-good', host).value) || 0;
    const warn = Number($('#mt-warn', host).value) || 0;
    $('#mt-preview', host).innerHTML = `
      <span class="pill good">${t('Hijau')} ≥ ${good}%</span>
      <span class="pill mid">${t('Kuning')} ${warn}–${Math.max(warn, good - 1)}%</span>
      <span class="pill bad">${t('Merah')} &lt; ${warn}%</span>`;
  };
  $('#mt-good', host).oninput = preview;
  $('#mt-warn', host).oninput = preview;
  preview();

  $('#mt-save', host).onclick = () => {
    const good = Number($('#mt-good', host).value);
    const warn = Number($('#mt-warn', host).value);
    if (!(warn < good)) return toast(t('Batas kuning harus lebih kecil dari batas hijau'), { error: true });
    p.slaGoodPct = good;
    p.slaWarnPct = warn;
    p.conversationGapHours = Number($('#mt-gap', host).value);
    p.autoResolveOnClose = $('#mt-auto', host).checked;
    for (const c of $$('[data-metric]', host)) p.metrics[c.dataset.metric] = c.checked;
    saveShop({ prefs: p }, t('Metrik disimpan'));
  };
}

export function mountAlertSettings(host) {
  const p = structuredClone(store.shop.prefs);
  host.innerHTML = `
    <h2>${t('Pengingat & peringatan')}</h2>
    <label class="check"><input type="checkbox" id="al-down" ${p.alertDisconnect ? 'checked' : ''}> ${t('Kirim WA ke owner kalau nomor sales terputus lebih dari 5 menit, dan saat tersambung lagi')}</label>
    <div class="row2">
      <label class="field">${t('Daftar tugas pagi, jam kirim')}
        <input class="input" type="time" id="al-time" value="${esc(p.morningTime ?? '')}">
        <span class="faint small">${t('Kosongkan untuk mematikan. Dikirim ke No. WA owner.')}</span></label>
      <label class="field">${t('Lead dianggap diam setelah (hari)')}
        <input class="input" type="number" min="1" max="60" id="al-stale" value="${p.staleDays}"></label>
    </div>
    <label class="check"><input type="checkbox" id="al-sales" ${p.morningToSales ? 'checked' : ''}> ${t('Kirim juga ke tiap sales, berisi chat mereka sendiri')}</label>
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button class="btn" type="button" id="al-save">${t('Simpan')}</button>
      <button class="btn ghost" type="button" id="al-preview">${t('Lihat daftar pagi')}</button>
      <button class="btn ghost" type="button" id="al-send">${t('Kirim sekarang')}</button>
    </div>
    <pre class="report-preview" id="al-out" hidden></pre>`;
  lockForDemo(host, ['al-preview']);

  $('#al-save', host).onclick = () => {
    p.alertDisconnect = $('#al-down', host).checked;
    p.morningTime = $('#al-time', host).value || null;
    p.morningToSales = $('#al-sales', host).checked;
    p.staleDays = Number($('#al-stale', host).value) || 3;
    saveShop({ prefs: p }, t('Pengaturan disimpan'));
  };
  $('#al-preview', host).onclick = async () => {
    const { text } = await api('/api/today/preview');
    const out = $('#al-out', host);
    out.textContent = text;
    out.hidden = false;
  };
  $('#al-send', host).onclick = async () => {
    try {
      const { sent } = await api('/api/today/send', { method: 'POST' });
      toast(t('Daftar pagi terkirim ({n})', { n: sent.length }));
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
}
