// Admin (Wamon team only): every account, its shop, free-trial dates, blocking, password resets,
// and "Lihat sebagai" to see the app exactly as a client does.
import { api, $, $$, esc, icon, toast, empty, skeletonBlocks } from './lib.js';
import { t } from './i18n.js';

const DAY = 86_400_000;
/** Today on the shops' calendar (WIB), as YYYY-MM-DD. */
const today = () => new Date(Date.now() + 420 * 60_000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const fmtDate = (ymd) =>
  ymd ? new Date(`${ymd}T00:00:00Z`).toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
const ago = (d) => {
  if (!d) return '–';
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (min < 60) return t('{n} mnt lalu', { n: Math.max(min, 1) });
  if (min < 48 * 60) return t('{n} jam lalu', { n: Math.round(min / 60) });
  return t('{n} hari lalu', { n: Math.round(min / 1440) });
};

/** Where an account stands: trial running / ending / over / not started / no limit, or blocked. */
function standing(u) {
  if (u.disabled) return { cls: 'bad', label: t('Nonaktif'), key: 'off' };
  const d = today();
  if (u.trialFrom && d < u.trialFrom) return { cls: 'stage', label: t('Mulai {date}', { date: fmtDate(u.trialFrom) }), key: 'soon' };
  if (u.trialUntil) {
    const left = daysBetween(d, u.trialUntil) + 1;
    if (left <= 0) return { cls: 'bad', label: t('Trial berakhir'), key: 'over' };
    return { cls: left <= 3 ? 'warn' : 'good', label: t('Sisa {n} hari', { n: left }), key: left <= 3 ? 'ending' : 'trial' };
  }
  return { cls: 'good', label: u.role === 'demo' ? t('Demo') : t('Tanpa batas'), key: 'full' };
}

export function mountAdmin({ main, navigate }) {
  let data = { users: [], shops: [] };
  let query = '';
  let filter = 'all';

  main.innerHTML = `<div class="page admin">
    <div class="page-head">
      <h1>${t('Admin')}</h1>
      <button class="btn" type="button" id="ad-add">${icon('plus', 16)} ${t('Tambah akun')}</button>
    </div>
    <div id="ad-editor"></div>
    <div class="admin-tools">
      <input class="input" id="ad-q" placeholder="${t('Cari akun, toko, catatan…')}" autocomplete="off">
      <div class="chips" style="padding:0" id="ad-filter"></div>
    </div>
    <div id="ad-body">${skeletonBlocks(4, 64)}</div>
  </div>`;

  $('#ad-add', main).onclick = () => openEditor(null);
  $('#ad-q', main).oninput = (e) => {
    query = e.target.value.trim().toLowerCase();
    render();
  };
  load();

  async function load() {
    try {
      data = await api('/api/admin/users');
    } catch (err) {
      $('#ad-body', main).innerHTML = empty({ ico: 'alert', title: t('Gagal memuat akun'), text: esc(err.message) });
      return;
    }
    render();
  }

  function render() {
    const counts = { all: data.users.length, trial: 0, ending: 0, over: 0, off: 0 };
    for (const u of data.users) {
      const k = standing(u).key;
      if (k === 'trial' || k === 'ending') counts.trial++;
      if (k in counts && k !== 'trial') counts[k]++;
    }
    const filters = [
      ['all', t('Semua')],
      ['trial', t('Trial aktif')],
      ['ending', t('Hampir habis')],
      ['over', t('Trial berakhir')],
      ['off', t('Nonaktif')],
    ];
    $('#ad-filter', main).innerHTML = filters
      .map(([k, l]) => `<button class="chip ${filter === k ? 'active' : ''}" data-f="${k}">${l} <span class="faint">${counts[k]}</span></button>`)
      .join('');
    for (const b of $$('[data-f]', main)) {
      b.onclick = () => {
        filter = b.dataset.f;
        render();
      };
    }

    const rows = data.users.filter((u) => {
      const k = standing(u).key;
      if (filter === 'trial' && k !== 'trial' && k !== 'ending') return false;
      if (filter !== 'all' && filter !== 'trial' && k !== filter) return false;
      if (!query) return true;
      return [u.username, u.shopName, u.note].some((v) => String(v ?? '').toLowerCase().includes(query));
    });

    const body = $('#ad-body', main);
    if (!rows.length) {
      body.innerHTML = empty({ ico: 'user', title: t('Tidak ada akun'), text: data.users.length ? t('Coba kata kunci atau filter lain.') : '' });
      return;
    }
    body.innerHTML = `<div class="card" style="padding:0"><div class="table-wrap"><table class="admin-table">
      <thead><tr>
        <th>${t('Akun')}</th><th>${t('Toko')}</th><th>${t('Trial')}</th><th>${t('Nomor WA')}</th><th>${t('Aktivitas')}</th><th></th>
      </tr></thead>
      <tbody>${rows.map(row).join('')}</tbody>
    </table></div></div>`;
    for (const b of $$('[data-edit]', body)) b.onclick = () => openEditor(data.users.find((u) => u.id === Number(b.dataset.edit)));
    for (const b of $$('[data-view-as]', body)) b.onclick = () => viewAs(Number(b.dataset.viewAs));
  }

  function row(u) {
    const st = standing(u);
    const trial = u.trialFrom || u.trialUntil
      ? `<div class="small">${fmtDate(u.trialFrom) || '…'} – ${fmtDate(u.trialUntil) || '…'}</div>`
      : '';
    return `<tr>
      <td><div class="admin-user"><b>${esc(u.username)}</b>${u.role !== 'owner' ? `<span class="pill ${u.role === 'dev' ? 'stage' : 'warn'}">${u.role}</span>` : ''}</div>
        ${u.note ? `<div class="faint small">${esc(u.note)}</div>` : ''}</td>
      <td>${esc(u.shopName ?? '–')}</td>
      <td><span class="pill ${st.cls}">${st.label}</span>${trial}</td>
      <td>${u.numbers ? `${u.connected}/${u.numbers} ${t('terhubung')}` : `<span class="faint">${t('belum ada')}</span>`}</td>
      <td class="small"><div>${t('Login')}: ${ago(u.lastLoginAt)}</div><div class="faint">${t('Chat terakhir')}: ${ago(u.lastMessageAt)}</div></td>
      <td class="admin-actions">
        <button class="btn ghost small" type="button" data-edit="${u.id}">${t('Ubah')}</button>
        ${u.role !== 'dev' ? `<button class="btn ghost small" type="button" data-view-as="${u.id}" title="${t('Buka dashboard persis seperti yang dilihat akun ini')}">${icon('eye', 15)} ${t('Lihat sebagai')}</button>` : ''}
      </td>
    </tr>`;
  }

  async function viewAs(id) {
    try {
      await api(`/api/admin/users/${id}/view-as`, { method: 'POST' });
      location.hash = '#/inbox';
      location.reload();
    } catch (err) {
      toast(err.message, { error: true });
    }
  }

  /** Add (u = null) or edit form, shown above the list. */
  function openEditor(u) {
    const host = $('#ad-editor', main);
    const editing = Boolean(u);
    const from = u?.trialFrom ?? (editing ? '' : today());
    const until = u?.trialUntil ?? (editing ? '' : addDays(today(), 13));
    const shop = data.shops.find((s) => s.id === u?.shopId);
    host.innerHTML = `<form class="card admin-editor" autocomplete="off">
      <h2>${editing ? t('Ubah akun {user}', { user: `<b>${esc(u.username)}</b>` }) : t('Akun baru')}</h2>
      <div class="row2">
        <label class="field">${t('Username')} <input class="input" name="username" value="${esc(u?.username ?? '')}" required autocapitalize="none" spellcheck="false"></label>
        <label class="field">${t('Password')} <input class="input" name="password" type="text" placeholder="${editing ? t('Kosongkan jika tidak diganti') : t('Minimal 6 karakter')}" ${editing ? '' : 'required'} spellcheck="false"></label>
        <label class="field">${t('Role')}
          <select class="input" name="role">
            ${[['owner', t('Owner toko')], ['demo', t('Demo (hanya lihat)')], ['dev', t('Dev (tim Wamon)')]]
              .map(([v, l]) => `<option value="${v}" ${(u?.role ?? 'owner') === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>
      </div>
      <div class="row2">
        <label class="field">${t('Toko')}
          <select class="input" name="shopId">
            ${editing ? '' : `<option value="">${t('+ Toko baru…')}</option>`}
            ${data.shops.map((s) => `<option value="${s.id}" ${s.id === u?.shopId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select></label>
        <label class="field">${editing ? t('Nama toko (ganti nama)') : t('Nama toko baru')}
          <input class="input" name="shopName" value="${esc(shop?.name ?? '')}" placeholder="${t('mis. Toko Emas Sinar Jaya')}"></label>
      </div>
      <div class="field" style="margin-bottom:2px">${t('Free trial')}</div>
      <div class="trial-row">
        <label class="field">${t('Mulai')} <input class="input" type="date" name="trialFrom" value="${from}"></label>
        <label class="field">${t('Lama (hari)')} <input class="input" type="number" min="1" max="3650" name="days" value="${from && until ? daysBetween(from, until) + 1 : ''}"></label>
        <label class="field">${t('Sampai')} <input class="input" type="date" name="trialUntil" value="${until}"></label>
      </div>
      <div class="chips" style="padding:0">
        ${[7, 14, 30].map((n) => `<button class="chip" type="button" data-days="${n}">${t('{n} hari', { n })}</button>`).join('')}
        ${editing ? `<button class="chip" type="button" data-extend="7">${t('Perpanjang +7 hari')}</button>` : ''}
        <button class="chip" type="button" data-nolimit>${t('Tanpa batas (berlangganan)')}</button>
      </div>
      <label class="field">${t('Catatan')} <input class="input" name="note" value="${esc(u?.note ?? '')}" placeholder="${t('mis. Pak Budi, 0812…, pitch 9 Nov')}" maxlength="255"></label>
      ${editing ? `<label class="check"><input type="checkbox" name="disabled" ${u.disabled ? 'checked' : ''}> ${t('Nonaktifkan akun (tidak bisa login, data tetap ada)')}</label>` : ''}
      <div class="trial-hint faint small" id="ad-hint"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" type="submit">${t('Simpan')}</button>
        <button class="btn ghost" type="button" data-cancel>${t('Batal')}</button>
        ${editing ? `<span style="flex:1"></span><button class="btn danger" type="button" data-delete>${icon('trash', 15)} ${t('Hapus akun')}</button>` : ''}
      </div>
    </form>`;
    const form = $('form', host);
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    form.username.focus();

    const hint = () => {
      const f = form.trialFrom.value, un = form.trialUntil.value;
      $('#ad-hint', form).textContent = !f && !un
        ? t('Tanpa tanggal trial: akun bisa dipakai terus.')
        : t('Bisa login dari {from} sampai akhir {until} (WIB). Setelah itu login ditolak, data tetap tersimpan.', {
            from: fmtDate(f) || '…',
            until: fmtDate(un) || '…',
          });
    };
    const syncUntil = () => {
      const n = Number(form.days.value);
      if (form.trialFrom.value && n > 0) form.trialUntil.value = addDays(form.trialFrom.value, n - 1);
      hint();
    };
    const syncDays = () => {
      if (form.trialFrom.value && form.trialUntil.value) form.days.value = daysBetween(form.trialFrom.value, form.trialUntil.value) + 1;
      hint();
    };
    form.days.oninput = syncUntil;
    form.trialFrom.oninput = syncUntil;
    form.trialUntil.oninput = syncDays;
    for (const b of $$('[data-days]', form)) {
      b.onclick = () => {
        if (!form.trialFrom.value) form.trialFrom.value = today();
        form.days.value = b.dataset.days;
        syncUntil();
      };
    }
    $('[data-extend]', form)?.addEventListener('click', () => {
      const base = form.trialUntil.value && form.trialUntil.value >= today() ? form.trialUntil.value : addDays(today(), -1);
      if (!form.trialFrom.value) form.trialFrom.value = today();
      form.trialUntil.value = addDays(base, 7);
      syncDays();
    });
    $('[data-nolimit]', form).onclick = () => {
      form.trialFrom.value = '';
      form.trialUntil.value = '';
      form.days.value = '';
      hint();
    };
    const shopSel = form.shopId;
    shopSel.onchange = () => {
      const s = data.shops.find((x) => x.id === Number(shopSel.value));
      form.shopName.value = s?.name ?? '';
      form.shopName.placeholder = s ? '' : t('mis. Toko Emas Sinar Jaya');
    };
    if (!editing) shopSel.value = '';
    hint();

    $('[data-cancel]', form).onclick = () => (host.innerHTML = '');
    $('[data-delete]', form)?.addEventListener('click', async () => {
      if (!confirm(t('Hapus akun {user}? Toko dan chat-nya tetap ada, hanya login ini yang dihapus.', { user: u.username }))) return;
      try {
        await api(`/api/admin/users/${u.id}`, { method: 'DELETE' });
        toast(t('Akun dihapus'));
        host.innerHTML = '';
        load();
      } catch (err) {
        toast(err.message, { error: true });
      }
    });

    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      const shopId = shopSel.value ? Number(shopSel.value) : null;
      const body = {
        username: form.username.value,
        role: form.role.value,
        trialFrom: form.trialFrom.value || null,
        trialUntil: form.trialUntil.value || null,
        note: form.note.value.trim() || null,
        shopId,
      };
      if (form.password.value) body.password = form.password.value;
      if (editing) body.disabled = form.disabled.checked;
      else if (!shopId) body.shopName = form.shopName.value.trim();
      try {
        if (editing) {
          await api(`/api/admin/users/${u.id}`, { method: 'PATCH', body });
          const s = data.shops.find((x) => x.id === shopId);
          const newName = form.shopName.value.trim();
          if (s && newName && newName !== s.name) await api(`/api/admin/shops/${s.id}`, { method: 'PATCH', body: { name: newName } });
        } else {
          await api('/api/admin/users', { method: 'POST', body });
        }
        toast(editing ? t('Akun disimpan') : t('Akun dibuat'));
        host.innerHTML = '';
        load();
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        btn.disabled = false;
      }
    };
  }

  return {};
}
