// Numbers: link each sales agent's WhatsApp by QR, see connection state live.
import { api, $, $$, esc, icon, toast, empty } from './lib.js';
import { store, refreshChannels } from './store.js';

const STATUS = {
  connected: ['Terhubung', 'on'],
  qr: ['Menunggu scan QR', 'wait'],
  connecting: ['Menghubungkan…', 'wait'],
  disconnected: ['Terputus', 'off'],
  logged_out: ['Logout dari HP', 'off'],
};

export function mountNumbers({ main }) {
  main.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Nomor WhatsApp</h1><div class="muted small">Satu nomor = satu sales. Chat dan laporan dipisah per nomor.</div></div></div>
    <form class="card" id="nb-add" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;align-items:center">
      <input class="input" name="agentName" placeholder="Nama sales, mis. Andi" required style="flex:1;min-width:180px">
      <button class="btn" type="submit">${icon('plus', 16)} Hubungkan nomor</button>
    </form>
    <p class="faint small" style="margin:0 0 14px">Di HP sales: WhatsApp → Perangkat tertaut → Tautkan perangkat → scan QR. Pakai untuk membalas customer saja, jangan untuk broadcast massal: nomor bisa diblokir.</p>
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
      host.innerHTML = empty({ ico: 'phone', title: 'Belum ada nomor', text: 'Masukkan nama sales di atas, lalu scan QR dari HP-nya.' });
      return;
    }
    host.innerHTML = store.channels
      .map((c) => {
        const [label, cls] = STATUS[c.status] ?? [c.status, ''];
        return `<div class="card channel-card">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
            <strong style="font-size:15px">${esc(c.agentName)}</strong>
            <span class="small" style="display:flex;gap:6px;align-items:center"><span class="dot ${cls}"></span>${label}</span>
          </div>
          <div class="muted small">${esc(c.phone ? `+${c.phone}` : 'Nomor belum tertaut')}</div>
          ${c.qr ? `<img src="${c.qr}" alt="QR untuk ${esc(c.agentName)}">` : ''}
          <div style="display:flex;gap:6px;margin-top:12px">
            ${c.status !== 'connected' ? `<button class="btn ghost sm" data-reconnect="${c.id}">${icon('refresh', 14)} Hubungkan ulang</button>` : ''}
            <button class="btn danger sm" data-remove="${c.id}">${icon('trash', 14)} Hapus</button>
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
    for (const b of $$('[data-remove]', host)) {
      b.onclick = async () => {
        const c = store.channels.find((x) => x.id === Number(b.dataset.remove));
        if (!confirm(`Putuskan nomor ${c.agentName} dan hapus semua chat-nya dari dashboard?`)) return;
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
