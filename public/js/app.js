// App shell: icon rail, hash router, live events, global keyboard shortcuts.
import {
  $, $$, icon, liveEvents, toast, menuOpen, closeMenu, showMenu, api, applyTheme, getThemePref, setThemePref, THEMES,
  withTransition,
} from './lib.js';
import { store, loadBase, refreshChannels } from './store.js';
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
  return THEMES.find((t) => t.id === getThemePref())?.icon ?? 'monitor';
}

function renderRail() {
  $('#rail').innerHTML = `
    <div class="rail-indicator" id="rail-indicator"></div>
    <div class="logo" title="${store.shop.name}">${icon('chat', 21)}</div>
    ${Object.entries(VIEWS).map(([k, v]) => `<button class="rail-btn" data-view="${k}" data-tip="${v.label}" aria-label="${v.label}">
      ${icon(v.icon, 22)}${k === 'followups' ? '<span class="badge danger hidden" id="due-badge"></span>' : ''}
      ${k === 'numbers' ? '<span class="badge warn hidden" id="offline-badge">!</span>' : ''}</button>`).join('')}
    <div class="spacer"></div>
    <button class="rail-btn cmdk" id="open-palette" data-tip="Cari (Ctrl K)" aria-label="Cari">${icon('search', 21)}</button>
    <button class="rail-btn cmdk" id="theme-btn" data-tip="Tema" aria-label="Tema">${icon(themeIcon(), 21)}</button>`;
  for (const b of $$('.rail-btn[data-view]')) b.onclick = () => navigate(`#/${b.dataset.view}`);
  $('#open-palette').onclick = () => openPalette(navigate);
  $('#theme-btn').onclick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.right + 8, r.top - 110, [
      { section: 'Tema' },
      ...THEMES.map((t) => ({ label: t.label, icon: t.icon, current: getThemePref() === t.id, onClick: () => setThemePref(t.id) })),
    ]);
  };
  addEventListener('themechange', () => {
    $('#theme-btn').innerHTML = icon(themeIcon(), 21);
  });
  addEventListener('resize', moveIndicator);
}

async function refreshBadges() {
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

async function start() {
  applyTheme();
  try {
    await loadBase();
  } catch (err) {
    main.innerHTML = `<div class="empty"><div class="inner"><div class="ttl">Server tidak bisa dihubungi</div><div class="txt">${err.message}</div></div></div>`;
    return;
  }
  document.title = `${store.shop.name} · WA Monitor`;
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
      if (!up && !wasDown) toast('Koneksi ke server terputus, mencoba lagi…', { error: true });
      if (up && wasDown) {
        toast('Tersambung lagi');
        refreshChannels();
        current.view?.onLive?.({ type: 'messages', chatIds: [] });
      }
      wasDown = !up;
    },
  );
  setInterval(refreshBadges, 60_000);
}

start();
