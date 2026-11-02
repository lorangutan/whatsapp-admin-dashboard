// Shared helpers: API, live events, formatting, icons, toasts, context menus, skeletons.

// ---------- API ----------
function token() {
  try {
    return localStorage.getItem('adminToken');
  } catch {
    return null;
  }
}

export async function api(path, opts = {}) {
  const t = token();
  const res = await fetch(path, {
    ...opts,
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    headers: {
      ...(opts.body ? { 'content-type': 'application/json' } : {}),
      ...(t ? { 'x-admin-token': t } : {}),
    },
  });
  if (res.status === 401) {
    const entered = prompt('Admin token');
    if (entered) {
      try {
        localStorage.setItem('adminToken', entered);
      } catch {}
      return api(path, opts);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

/** Server-Sent Events stream; reconnects on its own. */
export function liveEvents(onEvent, onState) {
  const t = token();
  const es = new EventSource(`/api/events${t ? `?token=${encodeURIComponent(t)}` : ''}`);
  es.onmessage = (e) => onEvent(JSON.parse(e.data));
  es.onopen = () => onState?.(true);
  es.onerror = () => onState?.(false);
  return es;
}

// ---------- tiny utils ----------
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

// ---------- formatting ----------
export function dur(ms) {
  if (ms == null) return '–';
  const m = Math.round(ms / 60000);
  if (m < 1) return ms < 60000 && ms >= 1000 ? `${Math.round(ms / 1000)} dtk` : '<1 mnt';
  if (m < 60) return `${m} mnt`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}j ${m % 60}m`;
  return `${Math.floor(h / 24)}h ${h % 24}j`;
}

export function rp(n, compact = true) {
  if (n == null || n === '') return '';
  n = Number(n);
  if (compact && n >= 1e9) return `Rp ${(n / 1e9).toLocaleString('id-ID', { maximumFractionDigits: 1 })} M`;
  if (compact && n >= 1e6) return `Rp ${(n / 1e6).toLocaleString('id-ID', { maximumFractionDigits: 1 })} jt`;
  return `Rp ${n.toLocaleString('id-ID')}`;
}

const sameDay = (a, b) => a.toDateString() === b.toDateString();

export function listTime(d) {
  if (!d) return '';
  d = new Date(d);
  const now = new Date();
  if (sameDay(d, now)) return d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Kemarin';
  if (now - d < 6 * 864e5) return d.toLocaleDateString('id-ID', { weekday: 'long' });
  return d.toLocaleDateString('id-ID', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function dayLabel(d) {
  d = new Date(d);
  const now = new Date();
  if (sameDay(d, now)) return 'Hari ini';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (sameDay(d, y)) return 'Kemarin';
  return d.toLocaleDateString('id-ID', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
}

export const clock = (d) => new Date(d).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

export function dueLabel(d) {
  d = new Date(d);
  const now = new Date();
  const time = clock(d);
  if (d < now && !sameDay(d, now)) return `Terlambat · ${d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}`;
  if (sameDay(d, now)) return `Hari ini ${time}`;
  const t = new Date(now);
  t.setDate(now.getDate() + 1);
  if (sameDay(d, t)) return `Besok ${time}`;
  return `${d.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

export const phoneOf = (jid) => (jid ?? '').split('@')[0];
export const displayPhone = (jid) => {
  const p = phoneOf(jid);
  if (!/^\d+$/.test(p) || (jid ?? '').endsWith('@lid')) return p;
  return p.startsWith('62') ? `+62 ${p.slice(2, 5)}-${p.slice(5, 9)}-${p.slice(9)}` : `+${p}`;
};
export const chatName = (c) => c.contactName || displayPhone(c.remoteJid);

// ---------- theme ----------
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

/** 'system' | 'light' | 'dark' */
export function getThemePref() {
  try {
    return localStorage.getItem('theme') ?? 'system';
  } catch {
    return 'system';
  }
}

function resolveTheme(pref) {
  return pref === 'system' ? (darkQuery.matches ? 'dark' : 'light') : pref;
}

export function applyTheme(pref = getThemePref(), animate = false) {
  const root = document.documentElement;
  const theme = resolveTheme(pref);
  if (root.dataset.theme === theme) return;
  if (animate) {
    root.classList.add('theme-anim');
    setTimeout(() => root.classList.remove('theme-anim'), 350);
  }
  root.dataset.theme = theme;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'dark' ? '#202c33' : '#f0f2f5');
}

export function setThemePref(pref) {
  try {
    localStorage.setItem('theme', pref);
  } catch {}
  applyTheme(pref, true);
  window.dispatchEvent(new CustomEvent('themechange', { detail: pref }));
}

darkQuery.addEventListener('change', () => getThemePref() === 'system' && applyTheme('system', true));

export const THEMES = [
  { id: 'system', label: 'Sistem', icon: 'monitor' },
  { id: 'light', label: 'Terang', icon: 'sun' },
  { id: 'dark', label: 'Gelap', icon: 'moon' },
];

// ---------- motion ----------
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

/**
 * FLIP: remember where `[data-id]` children of `container` are, run `mutate` (which re-renders),
 * then glide each surviving element from its old position to its new one. New ids get `.enter`.
 */
export function flip(container, mutate, selector = '[data-id]') {
  const before = new Map();
  for (const el of container.querySelectorAll(selector)) before.set(el.dataset.id, el.getBoundingClientRect());
  const firstRender = before.size === 0;
  mutate();
  if (firstRender || reducedMotion.matches) return;
  for (const el of container.querySelectorAll(selector)) {
    const old = before.get(el.dataset.id);
    if (!old) {
      el.classList.add('enter');
      continue;
    }
    const now = el.getBoundingClientRect();
    const dx = old.left - now.left;
    const dy = old.top - now.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 320,
      easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    });
  }
}

/** Route changes cross-fade where the View Transitions API exists. */
export function withTransition(fn) {
  if (!document.startViewTransition || reducedMotion.matches) return fn();
  document.startViewTransition(fn);
}

// ---------- avatars ----------
// Soft two-tone gradients, Telegram-style.
const HUES = [152, 199, 222, 262, 328, 14, 32, 174];
export function avatar(name, size = '', presence = '') {
  const clean = (name ?? '?').replace(/[^\p{L}\p{N} ]/gu, '').trim();
  const initials = /^[+\d\s-]+$/.test(name ?? '')
    ? (name.replace(/\D/g, '').slice(-2) || '#')
    : clean.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';
  let h = 0;
  for (const ch of name ?? '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = HUES[h % HUES.length];
  return `<div class="avatar ${size}" style="background:linear-gradient(150deg, hsl(${hue} 70% 66%), hsl(${hue + 8} 58% 50%))">${esc(initials)}${
    presence ? `<span class="presence dot ${presence}"></span>` : ''
  }</div>`;
}

// ---------- icons (24px stroke) ----------
const PATHS = {
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.4L3 20.5l1.6-5.4A8.5 8.5 0 1 1 21 11.5z"/>',
  board: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="10" y="4" width="5" height="11" rx="1.5"/><rect x="17" y="4" width="4" height="14" rx="1.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  chart: '<path d="M4 20V11M10 20V4M16 20v-8M21 20H3"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M11 18h2"/>',
  sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4 20-7z"/>',
  panel: '<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M15 3v18"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checks: '<path d="M17 7 7.5 16.5 3 12M22 7l-9.5 9.5-1-1"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  tag: '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
  cmd: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
  bike: '<circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9.5 9h5l4 7.5M8 9h4M15 5h3l1.5 4"/>',
  money: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>',
  note: '<path d="M4 4h16v12l-4 4H4z"/><path d="M16 20v-4h4M8 9h8M8 13h5"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>',
  arrow: '<path d="M5 12h14M13 5l7 7-7 7"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8M21 3v5h-5"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M2 9a15 15 0 0 1 20 0"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4-2v-4z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11z"/>',
  monitor: '<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
};

export function icon(name, size = 20, extra = '') {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" ${extra}>${PATHS[name] ?? ''}</svg>`;
}

// ---------- toasts ----------
export function toast(message, { error = false, action, onAction, timeout = 3500 } = {}) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast${error ? ' err' : ''}`;
  el.innerHTML = `${error ? icon('alert', 18, 'class="bad"') : ''}<span>${esc(message)}</span>${
    action ? `<button>${esc(action)}</button>` : ''
  }`;
  const leave = () => {
    if (el.classList.contains('leave')) return;
    el.classList.add('leave');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };
  if (action) el.querySelector('button').onclick = () => {
    leave();
    onAction?.();
  };
  host.append(el);
  // At most three at once; the oldest bows out.
  const all = host.querySelectorAll('.toast:not(.leave)');
  if (all.length > 3) all[0].classList.add('leave');
  setTimeout(leave, timeout);
}

// ---------- context menu ----------
let ctxEl = null;
export function closeMenu() {
  ctxEl?.remove();
  ctxEl = null;
}

/** items: { label, icon, onClick, danger, current } | { section: 'Label' } | 'sep' */
export function showMenu(x, y, items) {
  closeMenu();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctx';
  ctxEl.setAttribute('role', 'menu');
  ctxEl.innerHTML = items
    .map((it, i) => {
      if (it === 'sep') return '<div class="sep"></div>';
      if (it.section) return `<div class="label">${esc(it.section)}</div>`;
      return `<div class="item${it.danger ? ' danger' : ''}${it.current ? ' current' : ''}" role="menuitem" data-i="${i}">${
        it.icon ? icon(it.icon, 17) : '<span style="width:17px"></span>'
      }<span>${esc(it.label)}</span>${it.current ? `<span style="margin-left:auto">${icon('check', 15)}</span>` : ''}</div>`;
    })
    .join('');
  document.body.append(ctxEl);
  const { width, height } = ctxEl.getBoundingClientRect();
  const left = Math.min(x, innerWidth - width - 8);
  const top = Math.min(y, innerHeight - height - 8);
  ctxEl.style.left = `${left}px`;
  ctxEl.style.top = `${top}px`;
  // Grow out of the click point, even when the menu had to be nudged back on-screen.
  ctxEl.style.transformOrigin = `${x - left}px ${y - top}px`;
  const options = $$('.item', ctxEl);
  let sel = -1;
  ctxEl.addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (!item) return;
    closeMenu();
    items[Number(item.dataset.i)].onClick?.();
  });
  ctxEl.keyNav = (key) => {
    if (key === 'ArrowDown' || key === 'ArrowUp') {
      sel = (sel + (key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options.forEach((o, i) => o.classList.toggle('sel', i === sel));
      return true;
    }
    if (key === 'Enter' && sel >= 0) {
      options[sel].click();
      return true;
    }
    return false;
  };
}
export const menuOpen = () => ctxEl;

/** Right-click on desktop, long-press on touch. */
export function onContext(el, handler) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    handler(e.clientX, e.clientY, e);
  });
  let timer;
  el.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    timer = setTimeout(() => handler(t.clientX, t.clientY, e), 480);
  }, { passive: true });
  for (const ev of ['touchend', 'touchmove', 'touchcancel']) el.addEventListener(ev, () => clearTimeout(timer));
}

document.addEventListener('pointerdown', (e) => {
  if (ctxEl && !ctxEl.contains(e.target)) closeMenu();
});
addEventListener('blur', closeMenu);
addEventListener('resize', closeMenu);

// ---------- loading & empty states ----------
export function skeletonList(n = 8) {
  return Array.from(
    { length: n },
    (_, i) => `<div class="sk-item"><div class="sk av"></div><div>
      <div class="sk sk-line" style="width:${45 + ((i * 17) % 35)}%"></div>
      <div class="sk sk-line" style="width:${60 + ((i * 23) % 30)}%"></div></div></div>`,
  ).join('');
}

export function skeletonBlocks(n = 4, h = 90) {
  return Array.from({ length: n }, () => `<div class="sk" style="height:${h}px;border-radius:12px"></div>`).join('');
}

export function empty({ ico = 'chat', title, text = '', action = '', actionId = '' }) {
  return `<div class="empty"><div class="inner">
    <div class="ico">${icon(ico, 30)}</div>
    <div class="ttl">${esc(title)}</div>
    ${text ? `<div class="txt">${text}</div>` : ''}
    ${action ? `<button class="btn" id="${actionId}">${esc(action)}</button>` : ''}
  </div></div>`;
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Disalin');
  } catch {
    toast('Tidak bisa menyalin', { error: true });
  }
}
