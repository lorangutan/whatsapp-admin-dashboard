// "Hari ini": what needs doing today. A strip at the top of the chat list and a panel in the main pane.
import { api, $$, esc, icon, avatar, dur, clock, displayPhone } from './lib.js';
import { t, locale } from './i18n.js';

export const loadToday = () => api('/api/today');

export const isEmpty = (l) => !l || (!l.followups.length && !l.waiting.length && !l.stale.length && !l.offline.length);

/** One-line summary for the strip, e.g. "3 follow-up · 4 belum dibalas · 2 lead diam". */
export function todaySummary(l) {
  return [
    l.offline.length && t('{n} nomor terputus', { n: l.offline.length }),
    l.followups.length && t('{n} follow-up', { n: l.followups.length }),
    l.waiting.length && t('{n} belum dibalas', { n: l.waiting.length }),
    l.stale.length && t('{n} lead diam', { n: l.stale.length }),
  ].filter(Boolean).join(' · ');
}

const name = (x) => x.contactName || displayPhone(x.phone);

function item(x, detail, cls = '') {
  return `<button class="today-item" type="button" data-chat="${x.chatId}">
    ${avatar(name(x))}
    <span class="body"><span class="name">${esc(name(x))}</span><span class="tag">${esc(x.agentName)}</span></span>
    <span class="detail ${cls}">${detail}</span>
  </button>`;
}

function section(title, ico, items) {
  return items.length
    ? `<section class="today-sec"><h2>${icon(ico, 15)} ${title} <span class="count">${items.length}</span></h2>${items.join('')}</section>`
    : '';
}

/** Renders the panel; `onOpen(chatId)` opens a chat, `onBack` (phones) returns to the list. */
export function renderToday(host, l, { onOpen, onBack, footer = '' }) {
  const day = new Date(`${l.day}T00:00:00`).toLocaleDateString(locale(), { weekday: 'long', day: 'numeric', month: 'long' });
  host.innerHTML = `<div class="today">
    <div class="today-head">
      ${onBack ? `<button class="icon-btn only-mobile" id="td-back" aria-label="${t('Kembali')}">${icon('back')}</button>` : ''}
      <div><h1>${icon('sun', 20)} ${t('Hari ini')}</h1><div class="faint small">${esc(day)}</div></div>
    </div>
    ${l.offline.map((o) => `<a class="today-alert" href="#/numbers">${icon('alert', 17)}
      <span>${t('Nomor {name} terputus. Chat baru dari nomor ini tidak masuk.', { name: `<b>${esc(o.agentName)}</b>` })}</span>
      <span class="go">${t('Hubungkan')} ›</span></a>`).join('')}
    ${section(t('Follow-up'), 'clock', l.followups.map((f) =>
      item(f, `${f.overdue ? t('Terlambat') : clock(f.dueAt)}${f.note ? `<small>${esc(f.note)}</small>` : ''}`, f.overdue ? 'bad' : new Date(f.dueAt) < new Date() ? 'mid' : '')))}
    ${section(t('Belum dibalas'), 'chat', l.waiting.map((w) => item(w, t('menunggu {d}', { d: dur(w.waitedMs) }), w.overdue ? 'bad' : 'mid')))}
    ${section(t('Lead diam lebih dari {n} hari', { n: l.staleDays }), 'board', l.stale.map((s) =>
      item(s, `${esc(t(s.stageName))}<small>${t('{n} hari', { n: s.idleDays })}</small>`)))}
    ${isEmpty(l) ? `<div class="today-done">${icon('checkCircle', 28, 'class="good"')}<div>${t('Tidak ada yang tertunda hari ini.')}</div></div>` : ''}
    ${footer}
  </div>`;
  for (const b of $$('[data-chat]', host)) b.onclick = () => onOpen(Number(b.dataset.chat));
  host.querySelector('#td-back')?.addEventListener('click', onBack);
}
