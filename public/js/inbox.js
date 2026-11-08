// Inbox: chat list (middle pane) + conversation (main pane).
import {
  api, $, $$, esc, icon, avatar, listTime, dueLabel, onContext, showMenu, skeletonList, empty, chatName, debounce, flip,
} from './lib.js';
import { store, stages, stageName, stageClass, leadMenu } from './store.js';
import { openConversation } from './convo.js';
import { t } from './i18n.js';
import { loadToday, renderToday, todaySummary, isEmpty } from './today.js';

const PAGE = 60;

export function renderChatItem(c, active) {
  const ch = store.channels.find((x) => x.id === c.channelId);
  const offline = ch && ch.status !== 'connected';
  const due = c.nextFollowupAt ? new Date(c.nextFollowupAt) : null;
  const overdue = due && due < new Date();
  const preview = c.lastBody ?? (c.lastKind ? `[${c.lastKind}]` : '');
  return `<div class="chat-item ${active ? 'active' : ''} ${c.unread ? 'unread' : ''}" data-id="${c.id}" role="option" aria-selected="${active}">
    ${avatar(chatName(c), '', offline ? 'off' : '')}
    <div class="body">
      <div class="row"><span class="name">${esc(chatName(c))}</span><span class="time">${esc(listTime(c.lastMessageAt))}</span></div>
      <div class="row"><span class="preview">${c.lastFromMe ? icon('checks', 15, 'class="faint"') : ''}<span>${esc(preview)}</span></span>
        ${c.unread ? `<span class="badge">${c.unread}</span>` : c.resolved ? `<span title="${t('Tuntas')}">${icon('checkCircle', 16, 'class="good"')}</span>` : c.lastFromMe === false ? `<span title="${t('Belum dibalas')}">${icon('clock', 15, 'class="mid"')}</span>` : ''}</div>
      <div class="meta">
        ${c.stage && c.stage !== 'none' ? `<span class="pill ${stageClass(c.stage)}">${esc(stageName(c.stage))}</span>` : ''}
        ${due ? `<span class="pill ${overdue ? 'bad' : 'warn'}">${icon('clock', 11)} ${esc(dueLabel(due))}</span>` : ''}
        <span class="tag">${esc(c.agentName)}</span>
        ${c.interest ? `<span class="tag">${esc(c.interest)}</span>` : ''}
      </div>
    </div>
  </div>`;
}

export function mountInbox({ app, list, main, navigate }) {
  let filter = loadFilter();
  let chats = [];
  let hasMore = true;
  let loading = false;
  let activeId = null;
  let convo = null;
  let today = null;

  list.innerHTML = `
    <div class="pane-head"><h1>${t('Chat')}</h1><span class="count" id="ib-count"></span></div>
    <button class="today-strip" type="button" id="ib-today" hidden></button>
    <label class="search">${icon('search', 17)}<input id="ib-q" placeholder="${t('Cari nama, nomor, barang…')}" value="${esc(filter.q)}" autocomplete="off"><kbd>Ctrl K</kbd></label>
    <div class="chips" id="ib-chips"></div>
    <div class="list" id="ib-list" role="listbox" aria-label="${t('Daftar chat')}"></div>`;
  const listEl = $('#ib-list', list);

  renderChips();
  welcome();
  reload();
  refreshToday();
  $('#ib-today', list).onclick = () => {
    // With a chat open (desktop), closing it brings the panel back; otherwise slide it in (phones).
    if (activeId) return navigate('#/inbox');
    app.classList.add('show-main');
    showToday(true);
  };

  $('#ib-q', list).addEventListener('input', debounce((e) => {
    filter.q = e.target.value.trim();
    saveFilter();
    reload();
  }, 220));
  $('#ib-q', list).addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.target.blur();
      step(1);
    }
  });
  listEl.addEventListener('scroll', () => {
    if (listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - 300) loadMore();
  });

  const onChat = (e) => {
    const i = chats.findIndex((c) => c.id === e.detail.id);
    if (i < 0) return;
    chats[i] = e.detail;
    const el = listEl.querySelector(`[data-id="${e.detail.id}"]`);
    if (el) {
      el.outerHTML = renderChatItem(e.detail, e.detail.id === activeId);
      bindItem(listEl.querySelector(`[data-id="${e.detail.id}"]`));
    }
  };
  store.events.addEventListener('chat', onChat);
  const onChannels = () => {
    renderChips();
    renderList();
  };
  store.events.addEventListener('channels', onChannels);

  function loadFilter() {
    try {
      return { mode: 'all', channelId: '', q: '', ...JSON.parse(sessionStorage.getItem('inboxFilter') ?? '{}') };
    } catch {
      return { mode: 'all', channelId: '', q: '' };
    }
  }
  function saveFilter() {
    try {
      sessionStorage.setItem('inboxFilter', JSON.stringify(filter));
    } catch {}
  }

  function renderChips() {
    const modes = [
      ['all', t('Semua')],
      ['unreplied', t('Belum dibalas')],
      ['unresolved', t('Belum tuntas')],
      ['lead', t('Leads')],
      ...stages().filter((s) => !s.outcome).map((s) => [s.id, t(s.name)]),
    ];
    $('#ib-chips', list).innerHTML = `
      ${modes.map(([k, label]) => `<button class="chip ${filter.mode === k ? 'active' : ''}" data-mode="${k}">${esc(label)}</button>`).join('')}
      ${store.channels.length > 1 ? `<span class="chip ${filter.channelId ? 'active' : ''}"><select id="ib-agent" aria-label="Sales">
        <option value="">${t('Semua sales')}</option>
        ${store.channels.map((c) => `<option value="${c.id}" ${String(c.id) === String(filter.channelId) ? 'selected' : ''}>${esc(c.agentName)}</option>`).join('')}
      </select></span>` : ''}`;
    for (const b of $$('[data-mode]', list)) {
      b.onclick = () => {
        filter.mode = b.dataset.mode;
        saveFilter();
        renderChips();
        reload();
      };
    }
    const sel = $('#ib-agent', list);
    if (sel) sel.onchange = () => {
      filter.channelId = sel.value;
      saveFilter();
      renderChips();
      reload();
    };
  }

  function query(extra = {}) {
    const p = new URLSearchParams({ limit: String(PAGE), ...extra });
    if (filter.q) p.set('q', filter.q);
    if (filter.channelId) p.set('channelId', filter.channelId);
    if (filter.mode === 'unreplied') p.set('unreplied', '1');
    else if (filter.mode === 'unresolved') p.set('unresolved', '1');
    else if (filter.mode !== 'all') p.set('stage', filter.mode);
    return `/api/chats?${p}`;
  }

  async function reload({ quiet = false } = {}) {
    if (!quiet) listEl.innerHTML = skeletonList(10);
    const limit = quiet ? Math.min(Math.max(chats.length, PAGE), 300) : PAGE;
    const fetched = await api(query({ limit: String(limit) }));
    chats = fetched;
    hasMore = fetched.length >= limit;
    renderList();
  }

  async function loadMore() {
    if (!hasMore || loading || !chats.length) return;
    loading = true;
    try {
      const more = await api(query({ before: chats.at(-1).lastMessageAt }));
      hasMore = more.length >= PAGE;
      chats = [...chats, ...more.filter((m) => !chats.some((c) => c.id === m.id))];
      renderList();
    } finally {
      loading = false;
    }
  }

  function renderList() {
    $('#ib-count', list).textContent = chats.length ? `${chats.length}${hasMore ? '+' : ''} ${t('chat')}` : '';
    if (!chats.length) {
      if (!store.channels.length) {
        listEl.innerHTML = empty({ ico: 'phone', title: t('Belum ada nomor WhatsApp'), text: t('Hubungkan nomor sales untuk mulai memantau chat.'), action: t('Hubungkan nomor'), actionId: 'ib-go-numbers' });
        $('#ib-go-numbers', listEl).onclick = () => navigate('#/numbers');
      } else if (filter.q || filter.mode !== 'all' || filter.channelId) {
        listEl.innerHTML = empty({ ico: 'filter', title: t('Tidak ada chat yang cocok'), text: t('Coba kata kunci lain atau hapus filter.'), action: t('Hapus filter'), actionId: 'ib-clear' });
        $('#ib-clear', listEl).onclick = () => {
          filter = { mode: 'all', channelId: '', q: '' };
          $('#ib-q', list).value = '';
          saveFilter();
          renderChips();
          reload();
        };
      } else {
        listEl.innerHTML = empty({ ico: 'chat', title: t('Belum ada chat'), text: t('Chat baru akan muncul di sini begitu customer mengirim pesan.') });
      }
      return;
    }
    const scroll = listEl.scrollTop;
    // Chats that jump to the top on a new message glide there; brand-new chats fade in.
    flip(listEl, () => {
      listEl.innerHTML = chats.map((c) => renderChatItem(c, c.id === activeId)).join('');
      $$('.chat-item', listEl).forEach(bindItem);
      listEl.scrollTop = scroll;
    }, '.chat-item[data-id]');
  }

  function bindItem(el) {
    const id = Number(el.dataset.id);
    el.onclick = () => navigate(`#/inbox/${id}`);
    onContext(el, (x, y) => {
      const c = chats.find((cc) => cc.id === id);
      showMenu(x, y, leadMenu(c, { onOpen: () => navigate(`#/inbox/${id}`) }));
    });
  }

  async function refreshToday() {
    try {
      today = await loadToday();
    } catch {
      return;
    }
    const strip = $('#ib-today', list);
    if (!strip) return; // left the chat list before this arrived
    strip.hidden = isEmpty(today);
    strip.classList.toggle('alarm', today.offline.length > 0);
    strip.innerHTML = `${icon(today.offline.length ? 'alert' : 'sun', 16)}<b>${t('Hari ini')}</b><span>${esc(todaySummary(today))}</span>${icon('arrow', 15, 'class="go"')}`;
    // Keep the panel current when nothing else is open in the main pane.
    if (!activeId) showToday(app.classList.contains('show-main'));
  }

  function showToday(withBack) {
    if (!today || isEmpty(today)) return welcomeHint();
    renderToday(main, today, {
      onOpen: (id) => navigate(`#/inbox/${id}`),
      onBack: withBack ? () => app.classList.remove('show-main') : null,
      footer: `<div class="faint small today-keys">${keysHint()}</div>`,
    });
  }

  const keysHint = () =>
    `<kbd>Ctrl K</kbd> ${t('cari')} &nbsp; <kbd>↑</kbd><kbd>↓</kbd> ${t('pindah chat')} &nbsp; <kbd>/</kbd> ${t('balasan cepat')} &nbsp; <kbd>Esc</kbd> ${t('tutup')}`;

  function welcome() {
    if (today && !isEmpty(today)) return showToday(false);
    welcomeHint();
  }

  function welcomeHint() {
    main.innerHTML = `<div class="empty welcome"><div class="inner">
      <div class="ico">${icon('chat', 30)}</div>
      <div class="ttl">${t('Pilih chat untuk mulai')}</div>
      <div class="txt">${t('Klik kanan chat untuk pindah tahap atau jadwalkan follow-up.')}</div>
      <div class="txt" style="margin-top:8px"><kbd>Ctrl K</kbd> ${t('cari')} &nbsp; <kbd>↑</kbd><kbd>↓</kbd> ${t('pindah chat')} &nbsp; <kbd>/</kbd> ${t('balasan cepat')} &nbsp; <kbd>Esc</kbd> ${t('tutup')}</div>
    </div></div>`;
  }

  const refreshTodaySoon = debounce(refreshToday, 1500);

  function open(id) {
    if (id === activeId && convo) return;
    activeId = id;
    for (const el of $$('.chat-item', listEl)) {
      const on = Number(el.dataset.id) === id;
      el.classList.toggle('active', on);
      el.setAttribute('aria-selected', on);
      if (on) el.scrollIntoView({ block: 'nearest' });
    }
    convo?.destroy();
    convo = null;
    if (!id) {
      app.classList.remove('show-main');
      return welcome();
    }
    app.classList.add('show-main');
    convo = openConversation(main, id, { onBack: () => navigate('#/inbox') });
  }

  function step(dir) {
    if (!chats.length) return;
    const i = chats.findIndex((c) => c.id === activeId);
    const next = chats[Math.max(0, Math.min(chats.length - 1, i < 0 ? 0 : i + dir))];
    if (next) navigate(`#/inbox/${next.id}`);
  }

  const refreshQuiet = debounce(() => reload({ quiet: true }), 400);

  return {
    route(params) {
      open(params[0] ? Number(params[0]) : null);
    },
    onLive(e) {
      convo?.onLive(e);
      if (e.type === 'messages' || e.type === 'chat' || e.type === 'followups') refreshQuiet();
      if (['messages', 'chat', 'followups', 'channel'].includes(e.type)) refreshTodaySoon();
    },
    onKey(e) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        step(e.key === 'ArrowDown' ? 1 : -1);
        return true;
      }
      if (e.key === 'Enter' && convo) {
        e.preventDefault();
        convo.focusComposer();
        return true;
      }
      if (e.key === 'Escape') {
        if (convo?.closePanel()) return true;
        if (activeId) {
          navigate('#/inbox');
          return true;
        }
      }
      return false;
    },
    destroy() {
      convo?.destroy();
      store.events.removeEventListener('chat', onChat);
      store.events.removeEventListener('channels', onChannels);
    },
  };
}
