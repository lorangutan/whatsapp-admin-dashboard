// Conversation pane: header, message stream with upward infinite scroll, composer, lead panel.
import {
  api, $, $$, esc, icon, avatar, dur, rp, clock, dayLabel, dueLabel, toast, copy, showMenu, onContext,
  empty, chatName, displayPhone, phoneOf,
} from './lib.js';
import {
  store, stages, stageName, stageClass, leadMenu, patchLead, markRead, emitChat, tomorrowAt, setResolved,
} from './store.js';
import { t, locale } from './i18n.js';

const PAGE = 80;

function panelPref() {
  try {
    const v = localStorage.getItem('leadPanel');
    return v === null ? innerWidth > 1180 : v === '1';
  } catch {
    return innerWidth > 1180;
  }
}
function setPanelPref(open) {
  try {
    localStorage.setItem('leadPanel', open ? '1' : '0');
  } catch {}
}

export function openConversation(host, chatId, { onBack } = {}) {
  let chat = null;
  let msgs = [];
  let hasOlder = true;
  let loadingOlder = false;
  let panelOpen = panelPref();
  let destroyed = false;
  // Only bubbles that arrive after the first render animate in; history appears instantly.
  const seen = new Set();
  let primed = false;
  let unseenBelow = 0;

  host.innerHTML = `<div class="convo-wrap">
    <div class="convo">
      <div class="convo-head"><div class="sk" style="width:38px;height:38px;border-radius:50%"></div>
        <div style="flex:1"><div class="sk sk-line" style="width:160px"></div><div class="sk sk-line" style="width:110px"></div></div></div>
      <div class="messages">${Array.from({ length: 7 }, (_, i) =>
        `<div class="sk" style="height:${28 + (i % 3) * 12}px;width:${30 + ((i * 19) % 40)}%;align-self:${i % 2 ? 'flex-end' : 'flex-start'};border-radius:9px;margin:5px 0"></div>`).join('')}</div>
    </div></div>`;

  const onChatEvent = (e) => {
    if (e.detail.id !== chatId || e.detail === chat) return;
    Object.assign(chat, e.detail);
    renderHead();
    renderPanel();
  };
  store.events.addEventListener('chat', onChatEvent);

  load();

  async function load() {
    try {
      const [detail, page] = await Promise.all([
        api(`/api/chats/${chatId}`),
        api(`/api/chats/${chatId}/messages`),
      ]);
      if (destroyed) return;
      chat = detail;
      msgs = page;
      hasOlder = page.length >= PAGE;
      render();
      markRead(chat);
    } catch (err) {
      host.innerHTML = empty({ ico: 'alert', title: t('Chat tidak bisa dibuka'), text: esc(err.message) });
    }
  }

  // ---------- layout ----------
  function render() {
    host.innerHTML = `<div class="convo-wrap">
      <div class="convo">
        <div class="convo-head" id="cv-head"></div>
        <div class="messages" id="cv-msgs" tabindex="-1"></div>
        <button class="to-bottom" id="cv-down" aria-label="${t('Ke pesan terbaru')}">${icon('down', 22)}</button>
        <div id="cv-compose"></div>
      </div>
      <aside class="lead-panel ${panelOpen ? '' : 'hidden'}" id="cv-panel"></aside>
    </div>`;
    renderHead();
    renderMessages(true);
    renderComposer();
    renderPanel();
    $('#cv-msgs', host).addEventListener('scroll', onScroll, { passive: true });
    $('#cv-down', host).onclick = () => scrollToEnd(true);
  }

  function scrollToEnd(smooth) {
    const box = $('#cv-msgs', host);
    if (!box) return;
    box.scrollTo({ top: box.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  }

  function updateDownButton() {
    const box = $('#cv-msgs', host);
    const btn = $('#cv-down', host);
    if (!box || !btn) return;
    const away = box.scrollHeight - box.scrollTop - box.clientHeight > 260;
    if (!away) unseenBelow = 0;
    btn.classList.toggle('show', away);
    btn.innerHTML = `${icon('down', 22)}${unseenBelow ? `<span class="badge">${unseenBelow}</span>` : ''}`;
  }

  function channel() {
    return store.channels.find((c) => c.id === chat.channelId);
  }

  function renderHead() {
    const head = $('#cv-head', host);
    if (!head) return;
    const ch = channel();
    const online = ch?.status === 'connected';
    head.innerHTML = `
      ${onBack ? `<button class="icon-btn only-mobile" id="cv-back" aria-label="${t('Kembali')}">${icon('back')}</button>` : ''}
      ${avatar(chatName(chat), 'sm')}
      <div class="who" id="cv-who">
        <div class="name">${esc(chatName(chat))}</div>
        <div class="sub">${esc(chat.contactName ? displayPhone(chat.remoteJid) : '')}
          ${chat.contactName ? '·' : ''} <span class="dot ${online ? 'on' : 'off'}"></span> ${esc(chat.agentName)}</div>
      </div>
      ${chat.stage && chat.stage !== 'none'
        ? `<button class="pill ${stageClass(chat.stage)}" id="cv-stage" style="border:0">${esc(stageName(chat.stage))} ▾</button>`
        : `<button class="btn ghost sm" id="cv-stage">${icon('plus', 14)} ${t('Jadikan lead')}</button>`}
      <button class="${chat.resolved ? 'pill good' : 'btn ghost sm'} resolve-btn" id="cv-resolve" title="${chat.resolved ? t('Tuntas — tekan untuk membuka lagi') : t('Tandai tuntas')}">
        ${icon('checkCircle', 15)}<span class="hide-sm">${chat.resolved ? t('Tuntas') : t('Tandai tuntas')}</span></button>
      <button class="icon-btn" id="cv-fu" title="${t('Jadwalkan follow-up')}">${icon('clock')}</button>
      <button class="icon-btn ${panelOpen ? 'on' : ''}" id="cv-toggle" title="${t('Detail lead')}">${icon('panel')}</button>`;
    $('#cv-back', head)?.addEventListener('click', onBack);
    $('#cv-who', head).onclick = () => togglePanel(true);
    $('#cv-toggle', head).onclick = () => togglePanel();
    $('#cv-stage', head).onclick = (e) => {
      if (!chat.stage || chat.stage === 'none') return patchLead(chat, { stage: 'new' });
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.bottom + 6, leadMenu(chat));
    };
    $('#cv-resolve', head).onclick = () => setResolved(chat, !chat.resolved);
    $('#cv-fu', head).onclick = (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu(r.left - 150, r.bottom + 6, followupPresets());
    };
  }

  function togglePanel(force) {
    const next = force ?? !panelOpen;
    if (next === panelOpen) return;
    panelOpen = next;
    setPanelPref(panelOpen);
    $('#cv-toggle', host)?.classList.toggle('on', panelOpen);
    const panel = $('#cv-panel', host);
    if (!panel) return;
    if (panelOpen) {
      panel.classList.remove('hidden', 'closing');
      return;
    }
    // Slide out, then hide.
    panel.classList.add('closing');
    panel.addEventListener('animationend', () => {
      if (!panelOpen) panel.classList.add('hidden');
      panel.classList.remove('closing');
    }, { once: true });
  }

  function followupPresets() {
    const inDays = (n) => {
      const d = tomorrowAt();
      d.setDate(d.getDate() + n - 1);
      return d;
    };
    const later = new Date(Date.now() + 2 * 3600_000);
    return [
      { section: t('Ingatkan follow-up') },
      { label: t('Nanti, {time}', { time: clock(later) }), icon: 'clock', onClick: () => createFollowup(later) },
      { label: t('Besok 09.00'), icon: 'clock', onClick: () => createFollowup(inDays(1)) },
      { label: t('3 hari lagi'), icon: 'clock', onClick: () => createFollowup(inDays(3)) },
      { label: t('Minggu depan'), icon: 'clock', onClick: () => createFollowup(inDays(7)) },
      'sep',
      { label: t('Pilih tanggal…'), icon: 'plus', onClick: () => { togglePanel(true); $('#fu-date', host)?.focus(); } },
    ];
  }

  // ---------- messages ----------
  function messagesHtml() {
    if (!msgs.length) return `<div class="empty"><div class="inner"><div class="txt">${t('Belum ada pesan di chat ini')}</div></div></div>`;
    const target = (store.shop?.slaTargetMinutes ?? 15) * 60000;
    let out = hasOlder ? `<button class="btn ghost sm load-older" id="cv-older">${t('Muat pesan sebelumnya')}</button>` : '';
    let lastDay = '';
    let prevFromMe = null;
    let waitingSince = null;
    for (const m of msgs) {
      const day = new Date(m.sentAt).toDateString();
      if (day !== lastDay) {
        // Each day is its own group so its sticky label scrolls away with it instead of piling up.
        out += `${lastDay ? '</div>' : ''}<div class="day-group"><div class="day-sep">${esc(dayLabel(m.sentAt))}</div>`;
        lastDay = day;
        prevFromMe = null;
      }
      if (!m.fromMe && waitingSince == null) waitingSince = new Date(m.sentAt);
      if (m.fromMe && waitingSince != null) {
        const gap = new Date(m.sentAt) - waitingSince;
        if (gap >= 60000) out += `<div class="wait-sep ${gap <= target ? 'ok' : ''}">${t('dibalas setelah {d}', { d: dur(gap) })}</div>`;
        waitingSince = null;
      }
      const body = m.body ? esc(m.body) : `<span class="kind">[${esc(m.kind)}]</span>`;
      const status = m.failed ? icon('alert', 14, 'class="bad"') : m.pending ? icon('clock', 13) : m.fromMe ? icon('check', 14) : '';
      const enter = primed && !seen.has(m.waId) ? 'enter' : '';
      out += `<div class="bubble ${m.fromMe ? 'me' : ''} ${prevFromMe !== m.fromMe ? 'first' : ''} ${m.pending ? 'pending' : ''} ${m.failed ? 'failed' : ''} ${enter}"
        data-id="${esc(m.waId)}">${body}<span class="stamp">${clock(m.sentAt)}${status}</span></div>`;
      prevFromMe = m.fromMe;
    }
    return lastDay ? `${out}</div>` : out;
  }

  function renderMessages(toBottom = false) {
    const box = $('#cv-msgs', host);
    if (!box) return;
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    box.innerHTML = messagesHtml();
    for (const m of msgs) seen.add(m.waId);
    primed = true;
    $('#cv-older', box)?.addEventListener('click', loadOlder);
    for (const b of $$('.bubble', box)) {
      onContext(b, (x, y) => {
        const m = msgs.find((mm) => mm.waId === b.dataset.id);
        showMenu(x, y, [
          { label: t('Salin teks'), icon: 'copy', onClick: () => copy(m?.body ?? '') },
          ...(m?.failed ? [{ label: t('Kirim ulang'), icon: 'refresh', onClick: () => retry(m) }] : []),
          { label: t('Simpan sebagai catatan'), icon: 'note', onClick: () => m?.body && addNote(m.body) },
        ]);
      });
    }
    if (toBottom) box.scrollTop = box.scrollHeight;
    else if (nearBottom) scrollToEnd(true);
    updateDownButton();
  }

  function onScroll(e) {
    if (e.target.scrollTop < 80) loadOlder();
    updateDownButton();
  }

  async function loadOlder() {
    if (!hasOlder || loadingOlder || !msgs.length) return;
    loadingOlder = true;
    const box = $('#cv-msgs', host);
    const prevHeight = box.scrollHeight;
    try {
      const older = await api(`/api/chats/${chatId}/messages?before=${encodeURIComponent(msgs[0].sentAt)}`);
      for (const m of older) seen.add(m.waId); // history doesn't animate
      hasOlder = older.length >= PAGE;
      msgs = [...older, ...msgs];
      renderMessages();
      box.scrollTop = box.scrollHeight - prevHeight;
    } finally {
      loadingOlder = false;
    }
  }

  async function refreshLatest() {
    const latest = await api(`/api/chats/${chatId}/messages`);
    if (destroyed) return;
    const known = new Set(msgs.map((m) => m.waId));
    const fresh = latest.filter((m) => !known.has(m.waId));
    if (!fresh.length) return;
    msgs = [...msgs, ...fresh].sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
    const box = $('#cv-msgs', host);
    if (box && box.scrollHeight - box.scrollTop - box.clientHeight >= 120) unseenBelow += fresh.filter((m) => !m.fromMe).length;
    renderMessages();
    if (document.hasFocus()) markRead(chat);
  }

  // ---------- composer ----------
  function renderComposer() {
    const el = $('#cv-compose', host);
    const ch = channel();
    if (store.session?.role === 'demo') {
      el.innerHTML = `<div class="composer-note">${icon('eye', 17)}<span>${t('Mode demo: mengirim pesan WhatsApp dinonaktifkan.')}</span></div>`;
      return;
    }
    if (ch?.status !== 'connected') {
      el.innerHTML = `<div class="composer-note">${icon('wifi', 17)}
        <span>${t('Nomor {name} tidak terhubung, jadi balasan belum bisa dikirim dari sini.', { name: `<b>${esc(chat.agentName)}</b>` })}</span>
        <a href="#/numbers" style="margin-left:auto;color:inherit;font-weight:600">${t('Hubungkan')}</a></div>`;
      return;
    }
    el.innerHTML = `<div class="composer">
      <textarea id="cv-text" rows="1" placeholder="${t('Ketik pesan · / untuk balasan cepat')}"></textarea>
      <button class="btn send" id="cv-send" aria-label="${t('Kirim')}">${icon('send', 19)}</button>
    </div>`;
    const ta = $('#cv-text', el);
    const sendBtn = $('#cv-send', el);
    const autosize = () => {
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
      sendBtn.classList.toggle('ready', ta.value.trim().length > 0);
    };
    let pop = null;
    let popSel = 0;
    const closePop = () => {
      pop?.remove();
      pop = null;
    };
    const matches = () => {
      const m = /^\/(\S*)$/.exec(ta.value);
      if (!m) return null;
      return store.quickReplies.filter((r) => r.shortcut.includes(m[1].toLowerCase()) || r.body.toLowerCase().includes(m[1].toLowerCase()));
    };
    const pick = (r) => {
      ta.value = r.body;
      closePop();
      autosize();
      ta.focus();
    };
    const renderPop = () => {
      const list = matches();
      if (!list) return closePop();
      if (!pop) {
        pop = document.createElement('div');
        pop.className = 'qr-pop';
        $('.composer', el).append(pop);
      }
      popSel = Math.min(popSel, Math.max(list.length - 1, 0));
      pop.innerHTML = list.length
        ? list.map((r, i) => `<div class="qr-item ${i === popSel ? 'sel' : ''}" data-i="${i}"><b>/${esc(r.shortcut)}</b><span>${esc(r.body)}</span></div>`).join('')
        : `<div class="qr-item"><span>${t('Belum ada balasan cepat “{q}”. Tambahkan di Pengaturan.', { q: esc(ta.value.slice(1)) })}</span></div>`;
      pop.onclick = (e) => {
        const it = e.target.closest('[data-i]');
        if (it) pick(list[Number(it.dataset.i)]);
      };
    };
    ta.addEventListener('input', () => {
      autosize();
      renderPop();
    });
    ta.addEventListener('keydown', (e) => {
      const list = pop && matches();
      if (list?.length) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          popSel = (popSel + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length;
          return renderPop();
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          return pick(list[popSel]);
        }
      }
      if (e.key === 'Escape' && pop) {
        e.stopPropagation();
        return closePop();
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    });
    $('#cv-send', el).onclick = send;

    function send() {
      const text = ta.value.trim();
      if (!text) return;
      ta.value = '';
      autosize();
      closePop();
      deliver({ waId: `pending-${Date.now()}`, fromMe: true, kind: 'text', body: text, sentAt: new Date().toISOString(), pending: true });
    }
  }

  async function deliver(m) {
    if (!msgs.includes(m)) msgs.push(m);
    m.pending = true;
    m.failed = false;
    renderMessages(true);
    try {
      const sent = await api(`/api/chats/${chatId}/messages`, { method: 'POST', body: { text: m.body } });
      seen.add(sent.waId); // same bubble, new id: don't animate it twice
      if (msgs.some((x) => x.waId === sent.waId)) msgs = msgs.filter((x) => x !== m); // live echo got here first
      else Object.assign(m, { waId: sent.waId, sentAt: sent.sentAt, pending: false });
      chat.lastBody = m.body;
      chat.lastFromMe = true;
      chat.lastMessageAt = sent.sentAt;
      chat.unread = 0;
      emitChat(chat);
    } catch (err) {
      m.pending = false;
      m.failed = true;
      toast(t('Pesan gagal terkirim: {e}', { e: err.message }), { error: true, action: t('Coba lagi'), onAction: () => retry(m) });
    }
    renderMessages(true);
  }

  function retry(m) {
    msgs = msgs.filter((x) => x !== m);
    m.sentAt = new Date().toISOString();
    deliver(m);
  }

  // ---------- lead panel ----------
  function renderPanel() {
    const el = $('#cv-panel', host);
    if (!el || !chat) return;
    const tags = chat.tags ?? [];
    el.innerHTML = `
      <div class="sec hero">
        ${avatar(chatName(chat))}
        <input class="input" id="lp-name" value="${esc(chat.contactName ?? '')}" placeholder="${esc(displayPhone(chat.remoteJid))}" aria-label="${t('Nama kontak')}">
        <div class="muted small" style="display:flex;gap:6px;justify-content:center;align-items:center">
          ${esc(displayPhone(chat.remoteJid))}
          <button class="icon-btn" id="lp-copy" style="width:26px;height:26px" title="${t('Salin nomor')}">${icon('copy', 14)}</button>
        </div>
        <div class="small faint">${t('Ditangani {name}', { name: esc(chat.agentName) })}</div>
      </div>
      <div class="sec">
        <h2>${t('Tahap')}</h2>
        <div class="stage-track">
          ${stages().map((s) => `<button data-stage="${s.id}" class="${chat.stage === s.id ? 'active' : ''} ${s.outcome ?? ''}">${esc(t(s.name))}</button>`).join('')}
          <button data-stage="none" class="${chat.stage === 'none' ? 'active lost' : ''}">${t('Bukan lead')}</button>
        </div>
      </div>
      <div class="sec">
        <h2>${t('Detail')}</h2>
        <label class="field">${t('Unit diminati')}
          <input class="input" id="lp-interest" value="${esc(chat.interest ?? '')}" placeholder="${t('mis. Vario 125 2019 hitam')}"></label>
        <label class="field">${t('Nilai deal (Rp)')}
          <input class="input num" id="lp-value" inputmode="numeric" value="${chat.dealValue ? Number(chat.dealValue).toLocaleString(locale()) : ''}" placeholder="17.500.000"></label>
        <label class="field">${t('Tag')}
          <div class="tags-input" id="lp-tags">${tags.map((tag, i) => `<span class="t">${esc(tag)}<button data-i="${i}" aria-label="${t('Hapus tag')}">×</button></span>`).join('')}
            <input placeholder="${tags.length ? '' : t('kredit, tukar tambah…')}" id="lp-tag-in"></div></label>
      </div>
      <div class="sec">
        <h2>${t('Follow-up')}</h2>
        <div id="lp-fus">${(chat.followups ?? []).map((f) => `
          <div class="fu-row ${f.doneAt ? 'done' : ''}">
            <input type="checkbox" data-fu="${f.id}" ${f.doneAt ? 'checked' : ''}>
            <div style="flex:1"><div class="${!f.doneAt && new Date(f.dueAt) < new Date() ? 'bad' : ''}">${esc(dueLabel(f.dueAt))}</div>
              ${f.note ? `<div class="muted small">${esc(f.note)}</div>` : ''}</div>
            <button class="icon-btn" data-fu-del="${f.id}" style="width:26px;height:26px">${icon('x', 14)}</button>
          </div>`).join('') || `<div class="muted small">${t('Belum ada follow-up')}</div>`}</div>
        <div class="quick-dates">
          <button class="btn ghost sm" data-in="1">${t('Besok')}</button>
          <button class="btn ghost sm" data-in="3">${t('3 hari')}</button>
          <button class="btn ghost sm" data-in="7">${t('1 minggu')}</button>
        </div>
        <div style="display:grid;gap:6px">
          <input type="datetime-local" class="input" id="fu-date">
          <input class="input" id="fu-note" placeholder="${t('Catatan, mis. kabari harga nett')}">
          <button class="btn sm" id="fu-add">${icon('plus', 14)} ${t('Tambah follow-up')}</button>
        </div>
      </div>
      <div class="sec">
        <h2>${t('Catatan')}</h2>
        <textarea class="input" id="note-in" rows="2" placeholder="${t('Catatan internal, tidak terkirim ke customer')}"></textarea>
        <button class="btn ghost sm" id="note-add" style="justify-self:start">${t('Simpan catatan')}</button>
        <div style="display:grid;gap:6px" id="lp-notes">${(chat.notes ?? []).map((n) => `
          <div class="note-row"><div class="txt">${esc(n.body)}<div class="faint small">${esc(dayLabel(n.createdAt))} ${clock(n.createdAt)}</div></div>
            <button class="icon-btn" data-note-del="${n.id}" style="width:26px;height:26px">${icon('trash', 14)}</button></div>`).join('')}</div>
      </div>`;

    $('#lp-copy', el).onclick = () => copy(phoneOf(chat.remoteJid));
    const nameIn = $('#lp-name', el);
    nameIn.onkeydown = (e) => e.key === 'Enter' && nameIn.blur();
    nameIn.onblur = () => {
      const v = nameIn.value.trim() || null;
      if (v !== chat.contactName) patchLead(chat, { contactName: v });
    };
    for (const b of $$('[data-stage]', el)) {
      b.onclick = () => {
        const s = b.dataset.stage;
        patchLead(chat, { stage: chat.stage === s ? null : s });
      };
    }
    const interest = $('#lp-interest', el);
    interest.onblur = () => {
      const v = interest.value.trim() || null;
      if (v !== chat.interest) patchLead(chat, { interest: v });
    };
    const value = $('#lp-value', el);
    value.oninput = () => {
      const digits = value.value.replace(/\D/g, '');
      value.value = digits ? Number(digits).toLocaleString('id-ID') : '';
    };
    value.onblur = () => {
      const digits = value.value.replace(/\D/g, '');
      const v = digits ? Number(digits) : null;
      if (v !== (chat.dealValue == null ? null : Number(chat.dealValue))) patchLead(chat, { dealValue: v });
    };
    for (const inp of [interest, value]) inp.onkeydown = (e) => e.key === 'Enter' && inp.blur();

    const tagIn = $('#lp-tag-in', el);
    tagIn.onkeydown = (e) => {
      if ((e.key === 'Enter' || e.key === ',') && tagIn.value.trim()) {
        e.preventDefault();
        const tag = tagIn.value.trim().toLowerCase();
        if (!tags.includes(tag)) patchLead(chat, { tags: [...tags, tag] });
        renderPanel();
        $('#lp-tag-in', host)?.focus();
      } else if (e.key === 'Backspace' && !tagIn.value && tags.length) {
        patchLead(chat, { tags: tags.slice(0, -1) });
        renderPanel();
        $('#lp-tag-in', host)?.focus();
      }
    };
    for (const b of $$('#lp-tags [data-i]', el)) {
      b.onclick = () => {
        patchLead(chat, { tags: tags.filter((_, i) => i !== Number(b.dataset.i)) });
        renderPanel();
      };
    }

    for (const cb of $$('[data-fu]', el)) {
      cb.onchange = async () => {
        const f = chat.followups.find((x) => x.id === Number(cb.dataset.fu));
        f.doneAt = cb.checked ? new Date().toISOString() : null;
        renderPanel();
        try {
          await api(`/api/followups/${f.id}`, { method: 'PATCH', body: { done: cb.checked } });
          syncNextFollowup();
        } catch (err) {
          toast(err.message, { error: true });
          reloadDetail();
        }
      };
    }
    for (const b of $$('[data-fu-del]', el)) {
      b.onclick = async () => {
        const id = Number(b.dataset.fuDel);
        chat.followups = chat.followups.filter((f) => f.id !== id);
        renderPanel();
        await api(`/api/followups/${id}`, { method: 'DELETE' }).catch(() => reloadDetail());
        syncNextFollowup();
      };
    }
    for (const b of $$('[data-in]', el)) {
      b.onclick = () => {
        const d = tomorrowAt();
        d.setDate(d.getDate() + Number(b.dataset.in) - 1);
        createFollowup(d, $('#fu-note', el).value.trim());
      };
    }
    $('#fu-add', el).onclick = () => {
      const v = $('#fu-date', el).value;
      if (!v) return $('#fu-date', el).focus();
      createFollowup(new Date(v), $('#fu-note', el).value.trim());
    };

    $('#note-add', el).onclick = () => {
      const text = $('#note-in', el).value.trim();
      if (text) addNote(text);
    };
    for (const b of $$('[data-note-del]', el)) {
      b.onclick = async () => {
        const id = Number(b.dataset.noteDel);
        chat.notes = chat.notes.filter((n) => n.id !== id);
        renderPanel();
        await api(`/api/notes/${id}`, { method: 'DELETE' }).catch(() => reloadDetail());
      };
    }
  }

  function syncNextFollowup() {
    const open = (chat.followups ?? []).filter((f) => !f.doneAt).map((f) => new Date(f.dueAt));
    chat.nextFollowupAt = open.length ? new Date(Math.min(...open)).toISOString() : null;
    emitChat(chat);
  }

  async function createFollowup(dueAt, note = '') {
    const temp = { id: -Date.now(), dueAt: dueAt.toISOString(), note, doneAt: null };
    chat.followups = [...(chat.followups ?? []), temp].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    renderPanel();
    syncNextFollowup();
    try {
      const { id } = await api(`/api/chats/${chatId}/followups`, { method: 'POST', body: { dueAt: dueAt.toISOString(), note } });
      temp.id = id;
      renderPanel();
      toast(`Follow-up: ${dueLabel(dueAt)}`);
    } catch (err) {
      toast(err.message, { error: true });
      reloadDetail();
    }
  }

  async function addNote(body) {
    const temp = { id: -Date.now(), body, createdAt: new Date().toISOString() };
    chat.notes = [temp, ...(chat.notes ?? [])];
    togglePanel(true);
    renderPanel();
    try {
      Object.assign(temp, await api(`/api/chats/${chatId}/notes`, { method: 'POST', body: { body } }));
      renderPanel();
    } catch (err) {
      toast(err.message, { error: true });
      reloadDetail();
    }
  }

  async function reloadDetail() {
    Object.assign(chat, await api(`/api/chats/${chatId}`));
    renderHead();
    renderPanel();
  }

  return {
    chatId,
    onLive(e) {
      if (!chat) return;
      if (e.type === 'messages' && e.chatIds.includes(chatId)) refreshLatest();
      if (e.type === 'chat' && e.chatId === chatId) reloadDetail();
      if (e.type === 'followups') reloadDetail();
      if (e.type === 'channel' && e.channelId === chat.channelId) {
        renderHead();
        // Only swap the composer when online-ness flips, so a half-typed reply survives.
        const online = channel()?.status === 'connected';
        if (online !== Boolean($('#cv-text', host))) renderComposer();
      }
    },
    focusComposer() {
      $('#cv-text', host)?.focus();
    },
    closePanel() {
      if (!panelOpen) return false;
      togglePanel(false);
      return true;
    },
    destroy() {
      destroyed = true;
      store.events.removeEventListener('chat', onChatEvent);
    },
  };
}
