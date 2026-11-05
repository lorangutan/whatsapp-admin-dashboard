// App shell: icon rail, hash router, live events, global keyboard shortcuts.
import {
  $, $$, esc, icon, liveEvents, toast, menuOpen, closeMenu, showMenu, api, applyTheme, getThemePref, setThemePref, THEMES,
  withTransition,
} from './lib.js';
import { store, loadBase, refreshChannels } from './store.js';
import { t, getLang, setLang, LANGS } from './i18n.js';
import { openPalette, closePalette, paletteOpen } from './palette.js';
import { mountInbox } from './inbox.js';
import { mountFollowups } from './followups.js';
import { mountPipeline } from './pipeline.js';
import { mountReports } from './reports.js';
import { mountNumbers } from './numbers.js';
import { mountSettings } from './settings.js';

const VIEWS = {
  inbox: { mount: mountInbox, icon: 'chat', label: 'Chat', split: true },
  pipeline: { mount: mountPipeline, icon: 'board', label: 'Pipeline' },
  followups: { mount: mountFollowups, icon: 'clock', label: 'Follow-up', split: true },
  reports: { mount: mountReports, icon: 'chart', label: 'Laporan' },
  numbers: { mount: mountNumbers, icon: 'phone', label: 'Nomor WA' },
  settings: { mount: mountSettings, icon: 'sliders', label: 'Pengaturan' },
};

const app = $('#app');
const list = $('#list-pane');
const main = $('#main-pane');
let current = { name: null, view: null };

function navigate(hash, { remount = false } = {}) {
  if (remount) current.name = null;
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  const [name = 'inbox', ...params] = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const def = VIEWS[name] ?? VIEWS.inbox;
  const viewName = VIEWS[name] ? name : 'inbox';
  if (current.name !== viewName) {
    const first = current.name === null && !current.view;
    const swap = () => {
      current.view?.destroy?.();
      closeMenu();
      list.innerHTML = '';
      main.innerHTML = '';
      app.classList.toggle('wide', !def.split);
      app.classList.remove('show-main');
      current = { name: viewName, view: def.mount({ app, list, main, navigate }) };
      for (const b of $$('.rail-btn[data-view]')) b.classList.toggle('active', b.dataset.view === viewName);
      current.view.route?.(params);
      moveIndicator();
    };
    if (first) swap();
    else withTransition(swap);
    return;
  }
  current.view.route?.(params);
}

/** Slides the rail highlight to the active view instead of snapping. */
function moveIndicator() {
  const btn = $(`.rail-btn[data-view="${current.name}"]`);
  const ind = $('#rail-indicator');
  if (!btn || !ind) return;
  const horizontal = matchMedia('(max-width: 760px)').matches;
  const x = horizontal ? btn.offsetLeft : btn.offsetLeft - 10;
  const y = horizontal ? 0 : btn.offsetTop;
  ind.style.transform = horizontal ? `translateX(${x}px)` : `translateY(${y}px)`;
  ind.style.opacity = '1';
}

function themeIcon() {
  return THEMES.find((th) => th.id === getThemePref())?.icon ?? 'monitor';
}

function renderRail() {
  $('#rail').innerHTML = `
    <div class="rail-indicator" id="rail-indicator"></div>
    <div class="logo" title="${esc(store.shop.name)}">${icon('chat', 21)}</div>
    ${store.session?.role === 'demo' ? `<div class="demo-badge" title="${t('Akun demo')}">DEMO</div>` : ''}
    ${Object.entries(VIEWS).map(([k, v]) => `<button class="rail-btn" data-view="${k}" data-tip="${t(v.label)}" aria-label="${t(v.label)}">
      ${icon(v.icon, 22)}${k === 'followups' ? '<span class="badge danger hidden" id="due-badge"></span>' : ''}
      ${k === 'numbers' ? '<span class="badge warn hidden" id="offline-badge">!</span>' : ''}</button>`).join('')}
    <div class="spacer"></div>
    <button class="rail-btn cmdk" id="open-palette" data-tip="${t('Cari')} (Ctrl K)" aria-label="${t('Cari')}">${icon('search', 21)}</button>
    <button class="rail-btn cmdk" id="theme-btn" data-tip="${t('Tema')}" aria-label="${t('Tema')}">${icon(themeIcon(), 21)}</button>`;
  for (const b of $$('.rail-btn[data-view]')) b.onclick = () => navigate(`#/${b.dataset.view}`);
  $('#open-palette').onclick = () => openPalette(navigate);
  $('#theme-btn').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.right + 8, r.top - 110, [
      { section: t('Tema') },
      ...THEMES.map((th) => ({ label: th.label, icon: th.icon, current: getThemePref() === th.id, onClick: () => setThemePref(th.id) })),
      'sep',
      { section: t('Bahasa') },
      ...LANGS.map((l) => ({ label: l.label, current: getLang() === l.id, onClick: () => setLang(l.id) })),
    ]);
  };
  addEventListener('themechange', () => {
    $('#theme-btn').innerHTML = icon(themeIcon(), 21);
  });
  addEventListener('resize', moveIndicator);
}

/**
 * Red bar while a linked number is down (offline 5+ minutes, or logged out): new chats from it
 * are not reaching Wamon. Closing it hides it until a different set of numbers is down.
 */
let dismissedDown = '';
function renderDownBar() {
  const down = store.channels.filter((c) => c.down);
  const key = down.map((c) => c.id).join(',');
  let bar = $('#down-bar');
  const show = down.length > 0 && key !== dismissedDown;
  document.body.classList.toggle('has-down', show);
  if (!show) return bar?.remove();
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'down-bar';
    bar.className = 'down-bar';
    bar.setAttribute('role', 'alert');
    document.body.append(bar);
  }
  const names = down.map((c) => `<b>${esc(c.agentName)}</b>`).join(', ');
  bar.innerHTML = `${icon('alert', 17)}
    <span>${t(down.length > 1 ? 'Nomor {names} terputus. Chat baru tidak masuk ke Wamon.' : 'Nomor {names} terputus. Chat baru dari nomor ini tidak masuk ke Wamon.', { names })}</span>
    <button class="btn small" type="button" data-go>${t('Hubungkan ulang')}</button>
    <button class="icon-btn" type="button" data-close aria-label="${t('Tutup')}">${icon('x', 16)}</button>`;
  bar.querySelector('[data-go]').onclick = () => navigate('#/numbers');
  bar.querySelector('[data-close]').onclick = () => {
    dismissedDown = key;
    bar.remove();
    document.body.classList.remove('has-down');
  };
}

async function refreshBadges() {
  renderDownBar();
  const offline = store.channels.filter((c) => c.status !== 'connected' && c.status !== 'qr').length;
  $('#offline-badge')?.classList.toggle('hidden', !offline);
  try {
    const due = (await api('/api/followups')).filter((f) => new Date(f.dueAt) <= new Date()).length;
    const el = $('#due-badge');
    if (el) {
      el.textContent = due;
      el.classList.toggle('hidden', !due);
    }
  } catch {}
}

function onKey(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    return openPalette(navigate);
  }
  if (paletteOpen()) return;
  const menu = menuOpen();
  if (menu) {
    if (e.key === 'Escape') return closeMenu();
    if (menu.keyNav(e.key)) return e.preventDefault();
  }
  const typing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (typing) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  current.view?.onKey?.(e);
}

/** Full-screen login with a language switch; resolves once the session cookie is set. */
function showLogin() {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'login';
    el.innerHTML = `<form class="login-card" autocomplete="on">
      <div class="segmented login-lang" role="radiogroup" aria-label="${t('Bahasa')}">
        ${LANGS.map((l) => `<button type="button" role="radio" data-lang="${l.id}" class="${getLang() === l.id ? 'active' : ''}">${l.short}</button>`).join('')}
      </div>
      <div class="logo">${icon('chat', 26)}</div>
      <h1>Wamon</h1>
      <p class="muted">${t('Masuk untuk melihat chat dan laporan')}</p>
      <input class="input" name="username" placeholder="${t('Username')}" autocomplete="username" autocapitalize="none" spellcheck="false" required>
      <input class="input" type="password" name="password" placeholder="${t('Password')}" autocomplete="current-password" required>
      <div class="login-error bad small" role="alert"></div>
      <button class="btn" type="submit">${t('Masuk')}</button>
      <p class="faint small">${t('Coba dulu? Masuk dengan {cred}', { cred: '<b>demo</b> / <b>demo</b>' })}</p>
    </form>`;
    document.body.append(el);
    const form = $('form', el);
    for (const b of $$('[data-lang]', el)) b.onclick = () => setLang(b.dataset.lang);
    form.username.focus();
    form.onsubmit = async (e) => {
      e.preventDefault();
      const btn = $('button[type=submit]', form);
      btn.disabled = true;
      try {
        await api('/api/login', {
          method: 'POST',
          body: { username: form.username.value.trim(), password: form.password.value },
        });
        el.classList.add('leaving');
        setTimeout(() => el.remove(), 250);
        resolve();
      } catch (err) {
        $('.login-error', form).textContent = err.message;
        form.classList.remove('shake');
        void form.offsetWidth;
        form.classList.add('shake');
        form.password.select();
      } finally {
        btn.disabled = false;
      }
    };
  });
}

export async function logout() {
  await api('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

async function start() {
  applyTheme();
  try {
    let session = await api('/api/session');
    if (session.required && !session.loggedIn) {
      await showLogin();
      session = await api('/api/session');
    }
    store.session = session;
    // Owner-only controls (linking numbers, settings, sending) are hidden for the demo account.
    document.body.classList.toggle('role-demo', session.role === 'demo');
    // A session that expires mid-use sends the user back to the login screen.
    addEventListener('auth-required', () => location.reload(), { once: true });
    addEventListener('wamon-logout', logout);
    await loadBase();
  } catch (err) {
    main.innerHTML = `<div class="empty"><div class="inner"><div class="ttl">${t('Server tidak bisa dihubungi')}</div><div class="txt">${err.message}</div></div></div>`;
    return;
  }
  document.title = `${store.shop.name} · Wamon`;
  renderRail();
  addEventListener('hashchange', route);
  addEventListener('keydown', onKey);
  route();
  refreshBadges();

  let wasDown = false;
  liveEvents(
    async (e) => {
      if (e.type === 'channel') await refreshChannels();
      current.view?.onLive?.(e);
      if (e.type === 'channel' || e.type === 'followups') refreshBadges();
    },
    (up) => {
      if (!up && !wasDown) toast(t('Koneksi ke server terputus, mencoba lagi…'), { error: true });
      if (up && wasDown) {
        toast(t('Tersambung lagi'));
        refreshChannels();
        current.view?.onLive?.({ type: 'messages', chatIds: [] });
      }
      wasDown = !up;
    },
  );
  setInterval(refreshBadges, 60_000);
}

start();
