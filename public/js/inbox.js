// Inbox: chat list (middle pane) + conversation (main pane).
import {
  api, $, $$, esc, icon, avatar, listTime, dueLabel, onContext, showMenu, skeletonList, empty, chatName, debounce, flip,
} from './lib.js';
import { store, stages, stageName, stageClass, leadMenu } from './store.js';
import { openConversation } from './convo.js';

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
        ${c.unread ? `<span class="badge">${c.unread}</span>` : c.lastFromMe === false ? `<span title="Belum dibalas">${icon('clock', 15, 'class="mid"')}</span>` : ''}</div>
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

  list.innerHTML = `
    <div class="pane-head"><h1>Chat</h1><span class="count" id="ib-count"></span></div>
    <label class="search">${icon('search', 17)}<input id="ib-q" placeholder="Cari nama, nomor, unit…" value="${esc(filter.q)}" autocomplete="off"><kbd>Ctrl K</kbd></label>
    <div class="chips" id="ib-chips"></div>
    <div class="list" id="ib-list" role="listbox" aria-label="Daftar chat"></div>`;
  const listEl = $('#ib-list', list);

  renderChips();
  welcome();
  reload();

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
      ['all', 'Semua'],
      ['unreplied', 'Belum dibalas'],
      ['lead', 'Leads'],
      ...stages().filter((s) => !s.outcome).map((s) => [s.id, s.name]),
    ];
    $('#ib-chips', list).innerHTML = `
      ${modes.map(([k, label]) => `<button class="chip ${filter.mode === k ? 'active' : ''}" data-mode="${k}">${esc(label)}</button>`).join('')}
      ${store.channels.length > 1 ? `<span class="chip ${filter.channelId ? 'active' : ''}"><select id="ib-agent" aria-label="Sales">
        <option value="">Semua sales</option>
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
    $('#ib-count', list).textContent = chats.length ? `${chats.length}${hasMore ? '+' : ''} chat` : '';
    if (!chats.length) {
      if (!store.channels.length) {
        listEl.innerHTML = empty({ ico: 'phone', title: 'Belum ada nomor WhatsApp', text: 'Hubungkan nomor sales untuk mulai memantau chat.', action: 'Hubungkan nomor', actionId: 'ib-go-numbers' });
        $('#ib-go-numbers', listEl).onclick = () => navigate('#/numbers');
      } else if (filter.q || filter.mode !== 'all' || filter.channelId) {
        listEl.innerHTML = empty({ ico: 'filter', title: 'Tidak ada chat yang cocok', text: 'Coba kata kunci lain atau hapus filter.', action: 'Hapus filter', actionId: 'ib-clear' });
        $('#ib-clear', listEl).onclick = () => {
          filter = { mode: 'all', channelId: '', q: '' };
          $('#ib-q', list).value = '';
          saveFilter();
          renderChips();
          reload();
        };
      } else {
        listEl.innerHTML = empty({ ico: 'chat', title: 'Belum ada chat', text: 'Chat baru akan muncul di sini begitu customer mengirim pesan.' });
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

  function welcome() {
    main.innerHTML = `<div class="empty welcome"><div class="inner">
      <div class="ico">${icon('chat', 30)}</div>
      <div class="ttl">Pilih chat untuk mulai</div>
      <div class="txt">Klik kanan chat untuk pindah tahap atau jadwalkan follow-up.</div>
      <div class="txt" style="margin-top:8px"><kbd>Ctrl K</kbd> cari &nbsp; <kbd>↑</kbd><kbd>↓</kbd> pindah chat &nbsp; <kbd>/</kbd> balasan cepat &nbsp; <kbd>Esc</kbd> tutup</div>
    </div></div>`;
  }

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
