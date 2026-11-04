// Pipeline: kanban of leads by stage, drag & drop to move (optimistic).
import { api, $, $$, esc, icon, rp, dur, dueLabel, showMenu, onContext, empty, chatName, debounce, skeletonBlocks, flip } from './lib.js';
import { store, stages, moveStage, leadMenu } from './store.js';
import { t } from './i18n.js';

export function mountPipeline({ main, navigate }) {
  let leads = [];
  let agent = '';
  let q = '';

  main.innerHTML = `
    <div class="page" style="flex:none;overflow:visible;padding-bottom:12px">
      <div class="page-head" style="margin-bottom:0">
        <div><h1>${t('Pipeline')}</h1><div class="muted small" id="pl-sum"></div></div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="search" style="margin:0;width:220px">${icon('search', 16)}<input id="pl-q" placeholder="${t('Cari lead…')}"></label>
          ${store.channels.length > 1 ? `<select class="input" id="pl-agent" style="width:auto">
            <option value="">${t('Semua sales')}</option>${store.channels.map((c) => `<option value="${c.id}">${esc(c.agentName)}</option>`).join('')}
          </select>` : ''}
        </div>
      </div>
    </div>
    <div class="board" id="pl-board">${stages().map(() => `<div class="column"><div class="column-body" style="padding-top:12px">${skeletonBlocks(3, 76)}</div></div>`).join('')}</div>`;

  $('#pl-q', main).addEventListener('input', debounce((e) => {
    q = e.target.value.trim().toLowerCase();
    render();
  }, 150));
  const agentSel = $('#pl-agent', main);
  if (agentSel) agentSel.onchange = () => {
    agent = agentSel.value;
    render();
  };

  const onChat = (e) => {
    const i = leads.findIndex((l) => l.id === e.detail.id);
    if (i >= 0) leads[i] = e.detail;
    else if (e.detail.stage && e.detail.stage !== 'none') leads.push(e.detail);
    render();
  };
  store.events.addEventListener('chat', onChat);

  load();

  async function load() {
    leads = await api('/api/chats?stage=lead&limit=500');
    render();
  }

  function visible() {
    return leads.filter(
      (l) =>
        l.stage && l.stage !== 'none' &&
        (!agent || String(l.channelId) === agent) &&
        (!q || `${l.contactName ?? ''} ${l.remoteJid} ${l.interest ?? ''} ${(l.tags ?? []).join(' ')}`.toLowerCase().includes(q)),
    );
  }

  function card(l) {
    const days = l.stageChangedAt ? Date.now() - new Date(l.stageChangedAt) : null;
    const due = l.nextFollowupAt ? new Date(l.nextFollowupAt) : null;
    return `<div class="deal" draggable="true" data-id="${l.id}" tabindex="0">
      <div class="top"><span class="nm">${esc(chatName(l))}</span>${l.dealValue ? `<span class="val">${esc(rp(l.dealValue))}</span>` : ''}</div>
      ${l.interest ? `<div class="row">${icon('bike', 14)} ${esc(l.interest)}</div>` : ''}
      <div class="row">
        <span class="tag">${esc(l.agentName)}</span>
        ${days != null ? `<span title="${t('Lama di tahap ini')}">${esc(dur(days))}</span>` : ''}
        ${l.unread ? `<span class="badge">${l.unread}</span>` : l.lastFromMe === false ? `<span class="mid" title="${t('Belum dibalas')}">${icon('clock', 13)}</span>` : ''}
        ${due ? `<span class="pill ${due < new Date() ? 'bad' : 'warn'}">${esc(dueLabel(due))}</span>` : ''}
      </div>
    </div>`;
  }

  function render() {
    const board = $('#pl-board', main);
    const shown = visible();
    const active = shown.filter((l) => !stages().find((s) => s.id === l.stage)?.outcome);
    const activeValue = active.reduce((n, l) => n + Number(l.dealValue ?? 0), 0);
    $('#pl-sum', main).textContent = t('{n} lead aktif · {v} di pipeline', { n: active.length, v: rp(activeValue) || 'Rp 0' });

    if (!leads.length) {
      board.innerHTML = empty({
        ico: 'board',
        title: t('Pipeline masih kosong'),
        text: t('Chat baru dari customer otomatis masuk ke tahap “Baru”. Chat lama bisa dijadikan lead lewat klik kanan di Inbox.'),
        action: t('Buka Inbox'),
        actionId: 'pl-go',
      });
      $('#pl-go', board).onclick = () => navigate('#/inbox');
      return;
    }

    flip(board, () => {
    board.innerHTML = stages()
      .map((s) => {
        const col = shown.filter((l) => l.stage === s.id).sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));
        const value = col.reduce((n, l) => n + Number(l.dealValue ?? 0), 0);
        return `<section class="column" data-stage="${s.id}" aria-label="${esc(t(s.name))}">
          <div class="column-head"><b class="${s.outcome === 'won' ? 'good' : s.outcome === 'lost' ? 'bad' : ''}">${esc(t(s.name))} <span class="faint num">${col.length}</span></b>
            <span class="sum num">${value ? esc(rp(value)) : ''}</span></div>
          <div class="column-body">${col.map(card).join('') || `<div class="faint small" style="text-align:center;padding:18px 0">${t('Tarik lead ke sini')}</div>`}</div>
        </section>`;
      })
      .join('');
    }, '.deal[data-id]');

    for (const el of $$('.deal', board)) {
      const lead = leads.find((l) => l.id === Number(el.dataset.id));
      el.onclick = () => navigate(`#/inbox/${lead.id}`);
      el.onkeydown = (e) => e.key === 'Enter' && navigate(`#/inbox/${lead.id}`);
      onContext(el, (x, y) => showMenu(x, y, leadMenu(lead, { onOpen: () => navigate(`#/inbox/${lead.id}`) })));
      el.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', el.dataset.id);
        e.dataTransfer.effectAllowed = 'move';
        requestAnimationFrame(() => el.classList.add('dragging'));
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
    }
    for (const col of $$('.column', board)) {
      col.addEventListener('dragover', (e) => {
        e.preventDefault();
        col.classList.add('drop');
      });
      col.addEventListener('dragleave', (e) => {
        if (!col.contains(e.relatedTarget)) col.classList.remove('drop');
      });
      col.addEventListener('drop', (e) => {
        e.preventDefault();
        col.classList.remove('drop');
        const lead = leads.find((l) => l.id === Number(e.dataTransfer.getData('text/plain')));
        if (lead && lead.stage !== col.dataset.stage) moveStage(lead, col.dataset.stage);
      });
    }
  }

  const debouncedLoad = debounce(load, 500);

  return {
    onLive(e) {
      if (e.type === 'chat' || e.type === 'messages' || e.type === 'followups') debouncedLoad();
    },
    destroy() {
      store.events.removeEventListener('chat', onChat);
    },
  };
}
