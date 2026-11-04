// Follow-ups: reminders grouped by due date (middle pane) + the chat they belong to (main pane).
import { api, $, $$, esc, icon, avatar, dueLabel, toast, skeletonList, empty, chatName, debounce } from './lib.js';
import { stageName, stageClass } from './store.js';
import { openConversation } from './convo.js';
import { t } from './i18n.js';

function bucket(due) {
  const d = new Date(due);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startTomorrow = new Date(startToday.getTime() + 864e5);
  const startDayAfter = new Date(startToday.getTime() + 2 * 864e5);
  if (d < now) return ['overdue', t('Terlambat')];
  if (d < startTomorrow) return ['today', t('Hari ini')];
  if (d < startDayAfter) return ['tomorrow', t('Besok')];
  return ['later', t('Nanti')];
}

/** Filter chips. "today" includes overdue ones: both need doing now. */
const VIEWS = [
  { id: 'today', label: 'Hari ini', match: (f) => !f.doneAt && ['overdue', 'today'].includes(bucket(f.dueAt)[0]) },
  { id: 'tomorrow', label: 'Besok', match: (f) => !f.doneAt && bucket(f.dueAt)[0] === 'tomorrow' },
  { id: 'later', label: 'Nanti', match: (f) => !f.doneAt && bucket(f.dueAt)[0] === 'later' },
  { id: 'all', label: 'Semua', match: (f) => !f.doneAt },
  { id: 'done', label: 'Selesai', match: (f) => Boolean(f.doneAt) },
];

// The last chosen filter is remembered per device: no setting to look for, it stays how you left it.
function savedView() {
  try {
    const v = localStorage.getItem('followupView');
    if (VIEWS.some((x) => x.id === v)) return v;
  } catch {}
  return 'today';
}

export function mountFollowups({ app, list, main, navigate }) {
  let items = [];
  let view = savedView();
  let activeChat = null;
  let convo = null;

  list.innerHTML = `
    <div class="pane-head"><h1>${t('Follow-up')}</h1><span class="count" id="fu-count"></span></div>
    <div class="chips" id="fu-chips"></div>
    <div class="list" id="fu-list"></div>`;
  const listEl = $('#fu-list', list);
  welcome();
  load();

  function setView(next) {
    view = next;
    try {
      localStorage.setItem('followupView', next);
    } catch {}
    render();
  }

  async function load({ quiet = false } = {}) {
    if (!quiet) listEl.innerHTML = skeletonList(6);
    items = await api('/api/followups?includeDone=1');
    render();
  }

  function renderChips() {
    $('#fu-chips', list).innerHTML = VIEWS.map((v) => {
      const n = items.filter(v.match).length;
      const late = v.id === 'today' && items.some((f) => !f.doneAt && bucket(f.dueAt)[0] === 'overdue');
      return `<button class="chip ${view === v.id ? 'active' : ''}" data-view="${v.id}">${t(v.label)}${
        n ? ` <span class="chip-n ${late ? 'bad' : ''}">${n}</span>` : ''}</button>`;
    }).join('');
    for (const b of $$('[data-view]', list)) b.onclick = () => setView(b.dataset.view);
  }

  function render() {
    const open = items.filter((f) => !f.doneAt);
    const overdue = open.filter((f) => new Date(f.dueAt) < new Date()).length;
    $('#fu-count', list).textContent = `${t('{n} belum selesai', { n: open.length })}${overdue ? ` · ${t('{n} terlambat', { n: overdue })}` : ''}`;
    renderChips();
    const shown = items.filter(VIEWS.find((v) => v.id === view).match);
    if (items.length && !shown.length) {
      listEl.innerHTML = empty({
        ico: 'clock',
        title: t('Tidak ada follow-up di sini'),
        text: t('Coba filter lain untuk melihat pengingat yang lain.'),
        action: t('Lihat semua'),
        actionId: 'fu-all',
      });
      $('#fu-all', listEl).onclick = () => setView('all');
      return;
    }
    if (!items.length) {
      listEl.innerHTML = empty({
        ico: 'clock',
        title: t('Tidak ada follow-up'),
        text: t('Jadwalkan dari chat lewat tombol jam, atau klik kanan chat → Follow-up besok.'),
        action: t('Buka chat'),
        actionId: 'fu-go',
      });
      $('#fu-go', listEl).onclick = () => navigate('#/inbox');
      return;
    }
    let html = '';
    let lastGroup = '';
    for (const f of shown) {
      const [key, label] = f.doneAt ? ['done', t('Selesai')] : bucket(f.dueAt);
      if (key !== lastGroup) {
        html += `<div class="list-section ${key === 'overdue' ? 'bad' : ''}">${label}</div>`;
        lastGroup = key;
      }
      html += `<div class="chat-item ${f.chatId === activeChat ? 'active' : ''}" data-chat="${f.chatId}" data-id="${f.id}">
        ${avatar(chatName(f))}
        <div class="body">
          <div class="row"><span class="name" style="${f.doneAt ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(chatName(f))}</span>
            <input type="checkbox" data-check="${f.id}" ${f.doneAt ? 'checked' : ''} title="${t('Tandai selesai')}" style="accent-color:var(--accent);width:17px;height:17px"></div>
          <div class="preview"><span class="${key === 'overdue' ? 'bad' : ''}">${esc(dueLabel(f.dueAt))}</span>${f.note ? `<span>· ${esc(f.note)}</span>` : ''}</div>
          <div class="meta">${f.stage && f.stage !== 'none' ? `<span class="pill ${stageClass(f.stage)}">${esc(stageName(f.stage))}</span>` : ''}<span class="tag">${esc(f.agentName)}</span></div>
        </div></div>`;
    }
    listEl.innerHTML = html;
    for (const el of $$('.chat-item', listEl)) {
      el.onclick = (e) => {
        if (e.target.matches('input')) return;
        navigate(`#/followups/${el.dataset.chat}`);
      };
    }
    for (const cb of $$('[data-check]', listEl)) cb.onchange = () => setDone(Number(cb.dataset.check), cb.checked);
  }

  async function setDone(id, done) {
    const f = items.find((x) => x.id === id);
    f.doneAt = done ? new Date().toISOString() : null;
    render();
    try {
      await api(`/api/followups/${id}`, { method: 'PATCH', body: { done } });
      if (done) {
        toast(t('Follow-up selesai'), {
          action: t('Urungkan'),
          onAction: async () => {
            await api(`/api/followups/${id}`, { method: 'PATCH', body: { done: false } });
            load({ quiet: true });
          },
        });
      }
    } catch (err) {
      toast(err.message, { error: true });
      load({ quiet: true });
    }
  }

  function welcome() {
    main.innerHTML = empty({ ico: 'clock', title: t('Pilih follow-up'), text: t('Chat-nya terbuka di sini, lengkap dengan catatan dan tahap lead.') });
  }

  const quiet = debounce(() => load({ quiet: true }), 300);

  return {
    route(params) {
      const id = params[0] ? Number(params[0]) : null;
      activeChat = id;
      $$('.chat-item', listEl).forEach((el) => el.classList.toggle('active', Number(el.dataset.chat) === id));
      convo?.destroy();
      convo = null;
      if (!id) {
        app.classList.remove('show-main');
        return welcome();
      }
      app.classList.add('show-main');
      convo = openConversation(main, id, { onBack: () => navigate('#/followups') });
    },
    onLive(e) {
      convo?.onLive(e);
      if (e.type === 'followups' || e.type === 'chat') quiet();
    },
    onKey(e) {
      if (e.key === 'Escape') {
        if (convo?.closePanel()) return true;
        if (activeChat) {
          navigate('#/followups');
          return true;
        }
      }
      return false;
    },
    destroy() {
      convo?.destroy();
    },
  };
}
