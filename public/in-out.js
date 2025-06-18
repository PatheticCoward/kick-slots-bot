// public/in-out.js

const periodSelect = document.getElementById('periodSelect');
const startInput   = document.getElementById('startDate');
const endInput     = document.getElementById('endDate');
const filterIn     = document.getElementById('filterIn');
const filterOut    = document.getElementById('filterOut');
const inTbody      = document.querySelector('#inTable tbody');
const outTbody     = document.querySelector('#outTable tbody');

let currentSessionId = null;

async function fetchCurrentSession() {
  try {
    const res = await fetch('/api/sessions');
    const sessions = await res.json();
    if (sessions.length) currentSessionId = sessions[0]._id;
  } catch (e) {
    console.error('Failed to fetch session', e);
  }
}

function fmt(d) {
  return d.toISOString().slice(0,10);
}

function onPeriodChange() {
  const p = periodSelect.value;
  if (p === 'custom') {
    startInput.disabled = endInput.disabled = false;
  } else {
    startInput.disabled = endInput.disabled = true;
    const now = new Date(), sd = new Date(now), ed = new Date(now);
    if      (p==='daily')   sd.setHours(0,0,0,0);
    else if (p==='weekly')  { sd.setDate(now.getDate()-6); sd.setHours(0,0,0,0); }
    else if (p==='monthly') { sd.setDate(now.getDate()-29); sd.setHours(0,0,0,0); }
    startInput.value = (p==='session' ? '' : fmt(sd));
    endInput.value   = (p==='session' ? '' : fmt(ed));
  }
  renderTables();
}

function buildParams() {
  const qs = new URLSearchParams();
  if (periodSelect.value === 'session' && currentSessionId) {
    qs.set('sessionId', currentSessionId);
    return qs.toString();
  }
  const p = periodSelect.value;
  let sd = p==='custom' ? startInput.value : '';
  let ed = p==='custom' ? endInput.value   : '';
  if (p !== 'custom' && p !== 'session') {
    const now = new Date(), from = new Date(now);
    if      (p==='daily')   from.setHours(0,0,0,0);
    else if (p==='weekly')  from.setDate(now.getDate()-6);
    else if (p==='monthly') from.setDate(now.getDate()-29);
    sd = fmt(from);
    ed = fmt(now);
  }
  if (sd) qs.set('startDate', sd);
  if (ed) qs.set('endDate',   ed);
  return qs.toString();
}

function startCooldown(td) {
  let iv;
  function tick() {
    const diff = new Date(td.dataset.expires).getTime() - Date.now();
    if (diff <= 0) {
      td.textContent = 'Ready';
      td.classList.add('ready');
      clearInterval(iv);
    } else {
      const m = Math.floor(diff/60000);
      const s = String(Math.floor((diff%60000)/1000)).padStart(2,'0');
      td.textContent = `${m}:${s}`;
    }
  }
  tick();
  iv = setInterval(tick, 1000);
}

async function renderTables() {
  const params = buildParams();

  // ─── IN TABLE ───────────────────────────────────────────────────────────
  try {
    const inArr = await (await fetch(`/api/slots?status=IN&${params}`)).json();
    inTbody.innerHTML = '';
    const fi = filterIn.value.trim().toLowerCase();
    inArr.forEach(s => {
      if (fi && !(
        s.user.toLowerCase().includes(fi) ||
        s.msg.toLowerCase().includes(fi)
      )) return;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(s.time).toLocaleTimeString()}</td>
        <td>${s.user}</td>
        <td>${s.msg}</td>
        <td>
          <input
            class="payout-input"
            data-id="${s._id}"
            type="number"
            step="0.01"
            value="${s.payout||''}"
            placeholder="0.00"
          />
        </td>
        <td>
          <button class="save-btn payout-btn" data-id="${s._id}">Save</button>
          <button class="delete-btn del-btn" data-id="${s._id}">Delete</button>
        </td>
      `;
      inTbody.append(tr);
    });
  } catch (e) {
    console.error('❌ Failed fetching IN slots:', e);
  }

  // ─── OUT TABLE ──────────────────────────────────────────────────────────
  try {
    const outArr = await (await fetch(`/api/slots?status=OUT&${params}`)).json();
    outTbody.innerHTML = '';
    const fo = filterOut.value.trim().toLowerCase();
    outArr.forEach(s => {
      if (fo && !(
        s.user.toLowerCase().includes(fo) ||
        s.msg.toLowerCase().includes(fo)
      )) return;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${new Date(s.time).toLocaleTimeString()}</td>
        <td>${s.user}</td>
        <td>${s.msg}</td>
        <td class="action-cell" data-expires="${s.cooldownExpiresAt||''}"></td>
        <td><button class="delete-btn del-btn" data-id="${s._id}">Delete</button></td>
      `;
      const td = tr.querySelector('.action-cell');
      if (td && td.dataset.expires) startCooldown(td);
      outTbody.append(tr);
    });
  } catch (e) {
    console.error('❌ Failed fetching OUT slots:', e);
  }
}

document.body.addEventListener('click', async e => {
  const id = e.target.dataset.id;
  if (!id) return;
  if (e.target.matches('.del-btn')) {
    await fetch(`/api/slots/${id}`, { method:'DELETE' });
    renderTables();
  }
  if (e.target.matches('.payout-btn')) {
    const inp = document.querySelector(`input.payout-input[data-id="${id}"]`);
    await fetch(`/api/slots/${id}`, {
      method:'PATCH',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ payout: inp.value })
    });
  }
});

filterIn.addEventListener('input', renderTables);
filterOut.addEventListener('input', renderTables);
periodSelect.addEventListener('change', onPeriodChange);
startInput.addEventListener('change', renderTables);
endInput.addEventListener('change', renderTables);

document.addEventListener('DOMContentLoaded', async () => {
  await fetchCurrentSession();
  onPeriodChange();
  renderTables();
  const es = new EventSource('/events');
  ['slot','update','delete','settings'].forEach(evt =>
    es.addEventListener(evt, renderTables)
  );
});
