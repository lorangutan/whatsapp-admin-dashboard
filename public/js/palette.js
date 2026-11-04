// Ctrl/Cmd+K command palette: jump to views, run actions, search chats.
import { api, $, $$, esc, icon, avatar, listTime, chatName, debounce, displayPhone, THEMES, setThemePref } from './lib.js';
import { stageName } from './store.js';
import { t, getLang, setLang, LANGS } from './i18n.js';

let backdrop = null;

export const paletteOpen = () => Boolean(backdrop);

export function closePalette() {
  backdrop?.remove();
  backdrop = null;
}

export function openPalette(navigate) {
  if (backdrop) return closePalette();
  const commands = [
    { label: t('Inbox'), icon: 'chat', run: () => navigate('#/inbox'), kw: 'chat pesan' },
    { label: t('Chat belum dibalas'), icon: 'clock', run: () => setInbox('unreplied'), kw: 'unreplied waiting menunggu' },
    { label: t('Pipeline'), icon: 'board', run: () => navigate('#/pipeline'), kw: 'kanban deal lead' },
    { label: t('Follow-up'), icon: 'clock', run: () => navigate('#/followups'), kw: 'reminder pengingat tugas' },
    { label: t('Laporan'), icon: 'chart', run: () => navigate('#/reports'), kw: 'sla report statistik' },
    { label: t('Nomor WhatsApp'), icon: 'phone', run: () => navigate('#/numbers'), kw: 'qr hubungkan sales' },
    { label: t('Pengaturan'), icon: 'sliders', run: () => navigate('#/settings'), kw: 'jam buka balasan cepat' },
    { label: t('Keluar'), icon: 'back', run: () => window.dispatchEvent(new Event('wamon-logout')), kw: 'logout sign out' },
    ...THEMES.map((th) => ({
      label: `${t('Tema')}: ${th.label}`,
      icon: th.icon,
      run: () => setThemePref(th.id),
      kw: `theme tampilan mode ${th.id} ${th.id === 'dark' ? 'gelap malam' : th.id === 'light' ? 'terang lite siang' : 'otomatis'}`,
    })),
    ...LANGS.filter((l) => l.id !== getLang()).map((l) => ({
      label: `${t('Bahasa')}: ${l.label}`,
      icon: 'chat',
      run: () => setLang(l.id),
      kw: 'language bahasa english indonesia',
    })),
  ];
  function setInbox(mode) {
    try {
      const f = JSON.parse(sessionStorage.getItem('inboxFilter') ?? '{}');
      sessionStorage.setItem('inboxFilter', JSON.stringify({ ...f, mode }));
    } catch {}
    navigate('#/inbox', { remount: true });
  }

  backdrop = document.createElement('div');
  backdrop.className = 'palette-backdrop';
  backdrop.innerHTML = `<div class="palette" role="dialog" aria-label="${t('Cari')}">
    <div class="q">${icon('search', 19)}<input id="pal-q" placeholder="${t('Cari chat, nomor, atau perintah…')}" autocomplete="off"><kbd>Esc</kbd></div>
    <div class="res" id="pal-res"></div>
    <div class="foot"><span><kbd>↑</kbd><kbd>↓</kbd> ${t('pilih')}</span><span><kbd>Enter</kbd> ${t('buka')}</span><span><kbd>Esc</kbd> ${t('tutup')}</span></div>
  </div>`;
  document.body.append(backdrop);
  backdrop.addEventListener('pointerdown', (e) => e.target === backdrop && closePalette());

  const input = $('#pal-q', backdrop);
  const res = $('#pal-res', backdrop);
  let options = [];
  let sel = 0;
  let chats = [];

  const searchChats = debounce(async (q) => {
    const found = await api(`/api/chats?limit=8${q ? `&q=${encodeURIComponent(q)}` : ''}`).catch(() => []);
    if (!backdrop || input.value.trim() !== q) return;
    chats = found;
    render();
  }, 150);

  input.focus();
  render();
  searchChats('');

  input.addEventListener('input', () => {
    sel = 0;
    render();
    searchChats(input.value.trim());
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(options.length, 1);
      highlight();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(sel);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      closePalette();
    }
  });

  function render() {
    const q = input.value.trim().toLowerCase();
    const cmds = commands.filter((c) => !q || `${c.label} ${c.kw}`.toLowerCase().includes(q));
    options = [
      ...cmds.map((c) => ({ ...c, kind: 'cmd' })),
      ...chats.map((c) => ({ kind: 'chat', chat: c, run: () => navigate(`#/inbox/${c.id}`) })),
    ];
    sel = Math.min(sel, Math.max(options.length - 1, 0));
    let html = '';
    if (cmds.length) {
      html += `<div class="grp">${t('Perintah')}</div>`;
      html += cmds.map((c, i) => `<div class="opt" data-i="${i}">${icon(c.icon, 18)}<span>${esc(c.label)}</span></div>`).join('');
    }
    if (chats.length) {
      html += `<div class="grp">${q ? t('Chat') : t('Chat terbaru')}</div>`;
      html += chats.map((c, j) => `<div class="opt" data-i="${cmds.length + j}">${avatar(chatName(c), 'xs')}
        <span>${esc(chatName(c))} <span class="faint small">${esc(c.contactName ? displayPhone(c.remoteJid) : '')}</span></span>
        <span class="meta">${esc([stageName(c.stage), c.agentName, listTime(c.lastMessageAt)].filter(Boolean).join(' · '))}</span></div>`).join('');
    }
    res.innerHTML = html || `<div class="muted" style="padding:18px;text-align:center">${t('Tidak ada hasil untuk “{q}”', { q: esc(input.value) })}</div>`;
    for (const o of $$('.opt', res)) {
      o.onclick = () => choose(Number(o.dataset.i));
      o.onmousemove = () => {
        sel = Number(o.dataset.i);
        highlight();
      };
    }
    highlight();
  }

  function highlight() {
    $$('.opt', res).forEach((o) => {
      const on = Number(o.dataset.i) === sel;
      o.classList.toggle('sel', on);
      if (on) o.scrollIntoView({ block: 'nearest' });
    });
  }

  function choose(i) {
    const o = options[i];
    if (!o) return;
    closePalette();
    o.run();
  }
}
