// Reports: response-time SLA per sales, deals, pipeline funnel, leads still waiting.
import { api, $, $$, esc, icon, dur, rp, skeletonBlocks, empty, debounce } from './lib.js';
import { store } from './store.js';

const slaClass = (p) => (p == null ? '' : p >= 85 ? 'good' : p >= 60 ? 'mid' : 'bad');

export function mountReports({ main, navigate }) {
  let days = '1';
  try {
    days = sessionStorage.getItem('reportDays') ?? '1';
  } catch {}

  main.innerHTML = `<div class="page">
    <div class="page-head">
      <h1>Laporan</h1>
      <div class="chips" style="padding:0" id="rp-period">
        ${[['1', 'Hari ini'], ['7', '7 hari'], ['30', '30 hari']].map(([v, l]) => `<button class="chip ${v === days ? 'active' : ''}" data-d="${v}">${l}</button>`).join('')}
      </div>
    </div>
    <div id="rp-body"><div class="kpis">${skeletonBlocks(5, 92)}</div><div class="grid2">${skeletonBlocks(2, 260)}</div></div>
  </div>`;

  for (const b of $$('[data-d]', main)) {
    b.onclick = () => {
      days = b.dataset.d;
      try {
        sessionStorage.setItem('reportDays', days);
      } catch {}
      $$('[data-d]', main).forEach((x) => x.classList.toggle('active', x === b));
      load();
    };
  }
  load();

  async function load() {
    const r = await api(`/api/report?days=${days}`);
    render(r);
  }

  function kpi(label, value, sub, cls = '') {
    return `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="sub">${sub}</div></div>`;
  }

  function render(r) {
    const body = $('#rp-body', main);
    if (!store.channels.length) {
      body.innerHTML = empty({ ico: 'chart', title: 'Belum ada data', text: 'Hubungkan nomor sales untuk mulai mengukur kecepatan balas.', action: 'Hubungkan nomor', actionId: 'rp-go' });
      $('#rp-go', body).onclick = () => navigate('#/numbers');
      return;
    }
    const t = r.totals;
    const overdue = r.waiting.filter((w) => w.overdue).length;
    const p = r.pipeline;
    const maxCount = Math.max(1, ...p.stages.map((s) => s.count));
    const agents = [...r.agents].sort((a, b) => (b.slaPct ?? -1) - (a.slaPct ?? -1));

    body.innerHTML = `
      <div class="kpis">
        ${kpi(`Dibalas ≤${r.targetMinutes} mnt`, t.slaPct == null ? '–' : `${t.slaPct}%`, `${t.withinTarget} dari ${t.answered + t.overdue}`, slaClass(t.slaPct))}
        ${kpi('Respon pertama', dur(t.avgFirstResponseMs), 'rata-rata, jam buka')}
        ${kpi('Median balas', dur(t.medianResponseMs), `${t.answered - t.offHours} balasan jam buka${t.offHours ? ` · ${t.offHours} di luar jam` : ''}`)}
        ${kpi('Menunggu balasan', r.waiting.length, `${overdue} lewat target`, overdue ? 'bad' : '')}
        ${kpi('Deal', p.wonCount, p.wonValue ? rp(p.wonValue) : `${t.conversations} percakapan baru`, p.wonCount ? 'good' : '')}
      </div>
      <div class="grid2">
        <div class="card">
          <h2>Performa per sales</h2>
          <div class="table-wrap"><table>
            <thead><tr><th>Sales</th><th>Chat</th><th>SLA</th><th>Median</th><th>Respon pertama</th><th>Telat</th><th>Deal</th></tr></thead>
            <tbody>${agents.map((a) => `<tr>
              <td><strong>${esc(a.agentName)}</strong><div class="faint small">${esc(a.phone ?? 'belum terhubung')}</div></td>
              <td>${a.chats}</td>
              <td>${a.slaPct == null ? '–' : `<span class="pill ${slaClass(a.slaPct)}">${a.slaPct}%</span>`}</td>
              <td>${dur(a.medianResponseMs)}</td>
              <td>${dur(a.avgFirstResponseMs)}</td>
              <td class="${a.overdue ? 'bad' : ''}">${a.overdue}</td>
              <td>${a.wonCount ? `${a.wonCount}${a.wonValue ? ` <span class="faint small">${esc(rp(a.wonValue))}</span>` : ''}` : '–'}</td>
            </tr>`).join('')}</tbody>
          </table></div>
        </div>
        <div class="card">
          <h2>Menunggu balasan</h2>
          ${r.waiting.length ? `<ul class="waiting-list">${r.waiting.map((w) => `<li data-chat="${w.chatId}">
            <span><strong>${esc(w.contactName ?? w.phone)}</strong> <span class="tag">${esc(w.agentName)}</span></span>
            <span class="${w.overdue ? 'bad' : 'muted'} num">${dur(w.waitedMs)}</span></li>`).join('')}</ul>`
            : `<div class="muted" style="padding:20px 0;text-align:center">Semua chat sudah dibalas 👍</div>`}
        </div>
      </div>
      <div class="card" style="margin-top:14px">
        <h2>Pipeline saat ini</h2>
        <div class="funnel">${p.stages.map((s) => `<div class="funnel-row">
          <span>${esc(s.name)}</span>
          <div class="funnel-bar"><i class="${s.outcome ?? ''}" style="width:${(s.count / maxCount) * 100}%"></i></div>
          <span class="num muted" style="text-align:right">${s.count}${s.value ? ` · ${esc(rp(s.value))}` : ''}</span>
        </div>`).join('')}</div>
      </div>
      <p class="faint small" style="margin-top:12px">Waktu balas dihitung hanya selama jam buka. Chat yang ditanya dan dibalas saat tutup dihitung tepat waktu, tapi tidak masuk median.</p>`;

    for (const li of $$('[data-chat]', body)) li.onclick = () => navigate(`#/inbox/${li.dataset.chat}`);
  }

  const quiet = debounce(load, 1500);
  return {
    onLive(e) {
      if (e.type !== 'channel') quiet();
    },
    destroy() {},
  };
}
