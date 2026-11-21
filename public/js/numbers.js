// Numbers: link each sales agent's WhatsApp by QR, see connection state live.
import { api, $, $$, esc, icon, toast, empty } from './lib.js';
import { store, refreshChannels } from './store.js';
import { t } from './i18n.js';

const STATUS = {
  connected: ['Terhubung', 'on'],
  qr: ['Menunggu scan QR', 'wait'],
  connecting: ['Menghubungkan…', 'wait'],
  disconnected: ['Terputus', 'off'],
  logged_out: ['Logout dari HP', 'off'],
  // labels are translated where they're shown
};

export function mountNumbers({ main }) {
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${t('Nomor WhatsApp')}</h1><div class="muted small">${t('Satu nomor = satu sales. Chat dan laporan dipisah per nomor.')}</div></div></div>
    <form class="card owner-only" id="nb-add" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
      <input class="input" name="agentName" placeholder="${t('Nama sales, mis. Andi')}" required style="flex:1;min-width:180px">
      <button class="btn" type="submit">${icon('plus', 16)} ${t('Hubungkan nomor')}</button>
    </form>
    <p class="faint small owner-only" style="margin:0 0 14px">${t('Di HP sales: WhatsApp → Perangkat tertaut → Tautkan perangkat → scan QR. Pakai untuk membalas customer saja, jangan untuk broadcast massal: nomor bisa diblokir.')}</p>
    <div class="cards" id="nb-cards"></div>
  </div>`;

  $('#nb-add', main).onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    const agentName = form.agentName.value.trim();
    form.reset();
    try {
      await api('/api/channels', { method: 'POST', body: { agentName } });
      await refreshChannels();
    } catch (err) {
      toast(err.message, { error: true });
    }
  };

  const onChannels = () => render();
  store.events.addEventListener('channels', onChannels);
  render();

  function render() {
    const host = $('#nb-cards', main);
    if (!store.channels.length) {
      host.innerHTML = empty({ ico: 'phone', title: t('Belum ada nomor'), text: t('Masukkan nama sales di atas, lalu scan QR dari HP-nya.') });
      return;
    }
    host.innerHTML = store.channels
      .map((c) => {
        const [rawLabel, cls] = STATUS[c.status] ?? [c.status, ''];
        const label = t(rawLabel);
        return `<div class="card channel-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <strong style="font-size:15px">${esc(c.agentName)}</strong>
            <span class="small" style="display:flex;gap:6px;align-items:center"><span class="dot ${cls}"></span>${label}</span>
          </div>
          <div class="muted small">${esc(c.phone ? `+${c.phone}` : t('Nomor belum tertaut'))}</div>
          ${c.qr ? `<img src="${c.qr}" alt="QR ${esc(c.agentName)}">` : ''}
          <div class="owner-only" style="display:flex;gap:6px;margin-top:12px">
            ${c.status !== 'connected' && c.status !== 'qr' ? `<button class="btn ghost sm" data-reconnect="${c.id}">${icon('refresh', 14)} ${t('Hubungkan ulang')}</button>` : ''}
            ${c.status !== 'qr' ? `<button class="btn ghost sm" data-relink="${c.id}" title="${esc(t('QR baru untuk nomor yang sama. Chat, pipeline, dan catatan tetap ada.'))}">${icon('phone', 14)} ${t('Scan ulang QR')}</button>` : ''}
            <button class="btn danger sm" data-remove="${c.id}" style="margin-left:auto">${icon('trash', 14)} ${t('Hapus')}</button>
          </div>
        </div>`;
      })
      .join('');
    for (const b of $$('[data-reconnect]', host)) {
      b.onclick = async () => {
        const c = store.channels.find((x) => x.id === Number(b.dataset.reconnect));
        c.status = 'connecting';
        render();
        await api(`/api/channels/${c.id}/reconnect`, { method: 'POST' }).catch((err) => toast(err.message, { error: true }));
        refreshChannels();
      };
    }
    for (const b of $$('[data-relink]', host)) {
      b.onclick = async () => {
        const c = store.channels.find((x) => x.id === Number(b.dataset.relink));
        if (!confirm(t('Scan ulang QR untuk {name}?\n\nChat, pipeline, dan catatan tetap ada. Setelah ini, scan QR baru dengan HP nomor yang sama: WhatsApp → Perangkat tertaut → Tautkan perangkat.', { name: c.agentName }))) return;
        c.status = 'connecting';
        c.qr = null;
        render();
        await api(`/api/channels/${c.id}/relink`, { method: 'POST' }).catch((err) => toast(err.message, { error: true }));
        refreshChannels();
      };
    }
    for (const b of $$('[data-remove]', host)) {
      b.onclick = async () => {
        const c = store.channels.find((x) => x.id === Number(b.dataset.remove));
        if (!confirm(t('Hapus nomor {name} beserta SEMUA chat, tahap pipeline, catatan, dan follow-up-nya? Ini tidak bisa dibatalkan.\n\nMau menautkan ulang nomor yang sama? Pakai "Scan ulang QR" saja, data tetap aman.', { name: c.agentName }))) return;
        store.channels = store.channels.filter((x) => x !== c);
        render();
        await api(`/api/channels/${c.id}`, { method: 'DELETE' }).catch((err) => toast(err.message, { error: true }));
        refreshChannels();
      };
    }
  }

  return {
    onLive() {},
    destroy() {
      store.events.removeEventListener('channels', onChannels);
    },
  };
}
