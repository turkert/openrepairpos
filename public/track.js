// Public repair-status page. Shows only what the shop chose to share (no internal notes or passcodes).
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n, cur) => { try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'USD' }).format(Number(n) || 0); } catch { return (Number(n) || 0).toFixed(2); } };
const code = location.pathname.split('/').pop();
fetch('/api/track/' + encodeURIComponent(code)).then((r) => r.ok ? r.json() : Promise.reject()).then((t) => {
  document.title = `${t.store.name} – ${t.number}`;
  const idx = t.statuses.indexOf(t.status);
  document.getElementById('app').innerHTML = `
    <h1>${esc(t.store.name)}</h1><p class="muted">Repair ${esc(t.number)} · ${esc(t.device)}</p>
    <div class="card"><h2>Status: ${esc(t.status)}</h2>
      <ul class="steps">${t.statuses.map((s, i) => `<li class="${i < idx ? 'done' : i === idx ? 'now' : ''}"><i></i>${esc(s)}</li>`).join('')}</ul>
      ${t.due_date ? `<p>Estimated ready: <b>${new Date(t.due_date + 'T12:00').toLocaleDateString()}</b></p>` : ''}
      ${t.estimate ? `<p>Estimate: <b>${esc(money(t.estimate, t.currency))}</b></p>` : ''}
    </div>
    ${t.updates.length ? `<div class="card" style="margin-top:12px"><h2>Updates from the technician</h2>${t.updates.map((u) => `<div class="note"><div class="meta">${new Date(u.at.replace(' ', 'T') + 'Z').toLocaleString()}</div>${esc(u.body)}</div>`).join('')}</div>` : ''}
    <div class="card" style="margin-top:12px"><h2>Questions?</h2><p>${[t.store.phone, t.store.address].filter(Boolean).map(esc).join('<br>')}${t.store.hours ? `<br><span class="muted">${esc(t.store.hours)}</span>` : ''}</p></div>
    <p class="small muted" style="text-align:center;margin-top:20px">Powered by <a href="https://openrepairpos.com" target="_blank" rel="noopener">OpenRepairPOS</a></p>`;
}).catch(() => { document.getElementById('app').innerHTML = '<div class="card empty">We couldn\'t find that repair. Please check the link or call the store.</div>'; });
