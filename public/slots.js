// public/slots.js

const periodSelect = document.getElementById('periodSelect');
const startInput   = document.getElementById('startDate');
const endInput     = document.getElementById('endDate');
const searchInput  = document.getElementById('searchInput');
const tableBody    = document.querySelector('#slotsTable tbody');

let currentSessionId = null;
let searchTerm       = '';

// ─── Local date formatter ────────────────────────────────────────────────
function formatLocalDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function fetchCurrentSession() {
  const res      = await fetch('/api/sessions');
  const sessions = await res.json();
  if (sessions.length) currentSessionId = sessions[0]._id;
}

function computeDates() {
  const p   = periodSelect.value;
  const now = new Date();
  let sd = null, ed = null;
  if (p === 'daily') {
    sd = new Date(now); sd.setHours(0,0,0,0); ed = now;
  } else if (p === 'weekly') {
    sd = new Date(now); sd.setDate(now.getDate()-6); sd.setHours(0,0,0,0); ed = now;
  } else if (p === 'monthly') {
    sd = new Date(now); sd.setDate(now.getDate()-29); sd.setHours(0,0,0,0); ed = now;
  } else if (p === 'custom') {
    if (startInput.value) sd = new Date(startInput.value);
    if (endInput.value)   ed = new Date(endInput.value);
  }
  return { sd, ed };
}

async function loadSlots() {
  const { sd, ed } = computeDates();
  const qp = new URLSearchParams();

  if (periodSelect.value === 'session' && currentSessionId) {
    qp.set('sessionId', currentSessionId);
  } else {
    if (sd) qp.set('startDate', formatLocalDate(sd));
    if (ed) qp.set('endDate',   formatLocalDate(ed));
  }

  const url   = `/api/slots?${qp.toString()}`;
  console.log('🔍 Fetching slots:', url);
  const slots = await (await fetch(url)).json();

  tableBody.innerHTML = '';
  slots.forEach(s => {
    const u = s.user.toLowerCase(),
          m = s.msg.toLowerCase();
    if (searchTerm && !u.includes(searchTerm) && !m.includes(searchTerm)) return;

    const outCount = s.outCount || 0;
    const tr = document.createElement('tr');
    tr.dataset.id = s._id;
    tr.innerHTML = `
      <td>${new Date(s.time).toLocaleTimeString()}</td>
      <td class="user-cell">
        ${s.user}
        ${s.moderator   ? '<span class="badge mod">MOD</span>' : ''}
        ${s.vip         ? '<span class="badge vip">VIP</span>' : ''}
        ${s.subscriber  ? '<span class="badge sub">SUB</span>' : ''}
      </td>
      <td class="msg-cell">${s.msg}</td>
      <td>${outCount}</td>
      <td>
        <button class="in-btn">IN</button>
        <button class="out-btn">OUT</button>
        <button class="edit-btn">Edit</button>
        <button class="delete-btn">Delete</button>
      </td>
    `;
    tableBody.append(tr);
  });
}

// event delegation for button clicks…

tableBody.addEventListener('click', async e => {
  const tr = e.target.closest('tr'); if (!tr) return;
  const id = tr.dataset.id;
  if (e.target.matches('.in-btn')) {
    await fetch(`/api/slots/${id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ status:'IN' })});
    tr.remove();
  }
  else if (e.target.matches('.out-btn')) {
    await fetch(`/api/slots/${id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ status:'OUT' })});
    tr.remove();
  }
  else if (e.target.matches('.delete-btn')) {
    await fetch(`/api/slots/${id}`, { method:'DELETE' });
    tr.remove();
  }
  else if (e.target.matches('.edit-btn')) {
    const cell = tr.querySelector('.msg-cell'), old = cell.textContent;
    cell.innerHTML = `
      <input class="edit-input" value="${old}"/>
      <button class="save-btn">Save</button>
      <button class="cancel-btn">Cancel</button>
    `;
  }
  else if (e.target.matches('.save-btn')) {
    const val = tr.querySelector('.edit-input').value.trim();
    if (!val) return alert('Slot cannot be empty');
    await fetch(`/api/slots/${id}`, { method:'PATCH', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ msg: val })});
    tr.querySelector('.msg-cell').textContent = val;
  }
  else if (e.target.matches('.cancel-btn')) {
    loadSlots();
  }
});

searchInput.addEventListener('input', e => { searchTerm = e.target.value.trim().toLowerCase(); loadSlots(); });
periodSelect .addEventListener('change', loadSlots);
startInput   .addEventListener('change', loadSlots);
endInput     .addEventListener('change', loadSlots);

document.addEventListener('DOMContentLoaded', async () => {
  await fetchCurrentSession();
  loadSlots();
  const es = new EventSource('/events');
  ['slot','update','delete','settings'].forEach(evt => es.addEventListener(evt, loadSlots));
});
