// Pengaturan cards for logins: change your own password, and (owners) the Tim card with staff logins.
import { api, $, $$, esc, icon, toast, listTime } from './lib.js';
import { store } from './store.js';
import { t } from './i18n.js';

const canChangePassword = () => store.session?.required && store.session.role !== 'demo' && !store.session.via;
const isOwner = () => ['owner', 'dev'].includes(store.session?.role) && store.session?.required;

export function accountCards() {
  return `${canChangePassword() ? `<form class="card" id="st-pw" style="display:grid;gap:10px" autocomplete="on">
      <h2>${t('Ganti password')}</h2>
      <input type="text" name="username" value="${esc(store.session.username)}" autocomplete="username" hidden>
      <div class="pw-form">
        <label class="field">${t('Password lama')} <input class="input" type="password" name="current" autocomplete="current-password" required></label>
        <label class="field">${t('Password baru')} <input class="input" type="password" name="next" autocomplete="new-password" minlength="8" required></label>
        <label class="field">${t('Ulangi password baru')} <input class="input" type="password" name="again" autocomplete="new-password" minlength="8" required></label>
      </div>
      <div><button class="btn" type="submit">${t('Simpan password')}</button></div>
    </form>` : ''}
    ${isOwner() ? `<div class="card owner-only" id="st-team" style="display:grid;gap:8px">
      <h2>${t('Tim')}</h2>
      <div class="faint small">${t('Login untuk sales / admin. Mereka bisa membalas chat, mengatur lead, follow-up dan pipeline, tapi tidak bisa melihat laporan, mengubah nomor WA atau pengaturan.')}</div>
      <div id="st-team-list"></div>
      <form id="st-team-add" class="pw-form" autocomplete="off">
        <label class="field">${t('Username')} <input class="input" name="username" placeholder="${t('mis. rizky')}" autocapitalize="none" spellcheck="false" required></label>
        <label class="field">${t('Password')} <input class="input" type="text" name="password" minlength="8" placeholder="${t('min. 8 karakter')}" autocomplete="new-password" required></label>
        <div><button class="btn" type="submit">${icon('plus', 16)} ${t('Tambah login sales')}</button></div>
      </form>
    </div>` : ''}`;
}

export function mountAccount(main) {
  const pw = $('#st-pw', main);
  if (pw) {
    pw.onsubmit = async (e) => {
      e.preventDefault();
      if (pw.next.value !== pw.again.value) return toast(t('Password baru tidak sama'), { error: true });
      const btn = $('button[type=submit]', pw);
      btn.disabled = true;
      try {
        await api('/api/account/password', { method: 'POST', body: { current: pw.current.value, next: pw.next.value } });
        pw.reset();
        toast(t('Password diganti'));
      } catch (err) {
        toast(err.message, { error: true });
      } finally {
        btn.disabled = false;
      }
    };
  }

  const team = $('#st-team', main);
  if (!team) return;
  const listEl = $('#st-team-list', team);
  const render = (rows) => {
    listEl.innerHTML = rows.length
      ? rows.map((u) => `<div class="team-row" data-id="${u.id}">
          <div class="who"><b>${esc(u.username)}</b> ${u.disabled ? `<span class="small bad">· ${t('nonaktif')}</span>` : ''}
            <div class="faint small">${u.lastLoginAt ? t('Terakhir masuk {when}', { when: listTime(u.lastLoginAt) }) : t('Belum pernah masuk')}</div></div>
          <div class="acts">
            <button class="btn ghost" type="button" data-act="reset">${t('Reset password')}</button>
            <button class="btn ghost" type="button" data-act="toggle">${u.disabled ? t('Aktifkan') : t('Nonaktifkan')}</button>
            <button class="icon-btn" type="button" data-act="delete" aria-label="${t('Hapus')}">${icon('trash', 16)}</button>
          </div></div>`).join('')
      : `<div class="muted small">${t('Belum ada login sales.')}</div>`;
    for (const row of $$('.team-row', listEl)) {
      const id = Number(row.dataset.id);
      const u = rows.find((r) => r.id === id);
      for (const b of $$('[data-act]', row)) {
        b.onclick = async () => {
          try {
            if (b.dataset.act === 'reset') {
              const password = prompt(t('Password baru untuk {user} (min. 8 karakter):', { user: u.username }));
              if (!password) return;
              render(await api(`/api/team/${id}`, { method: 'PATCH', body: { password } }));
              toast(t('Password {user} diganti', { user: u.username }));
            } else if (b.dataset.act === 'toggle') {
              render(await api(`/api/team/${id}`, { method: 'PATCH', body: { disabled: !u.disabled } }));
            } else if (confirm(t('Hapus login {user}? Chat dan lead tidak ikut terhapus.', { user: u.username }))) {
              render(await api(`/api/team/${id}`, { method: 'DELETE' }));
            }
          } catch (err) {
            toast(err.message, { error: true });
          }
        };
      }
    }
  };
  api('/api/team').then(render, (err) => (listEl.innerHTML = `<div class="bad small">${esc(err.message)}</div>`));

  const add = $('#st-team-add', team);
  add.onsubmit = async (e) => {
    e.preventDefault();
    try {
      render(await api('/api/team', { method: 'POST', body: { username: add.username.value, password: add.password.value } }));
      toast(t('Login {user} dibuat', { user: add.username.value.trim().toLowerCase() }));
      add.reset();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };
}
