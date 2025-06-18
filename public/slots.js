// public/slots.js

// ─── Element refs ───────────────────────────────────────────────────────
const periodSelect = document.getElementById('periodSelect');
const startInput   = document.getElementById('startDate');
const endInput     = document.getElementById('endDate');
const searchInput  = document.getElementById('searchInput');
const tableBody    = document.querySelector('#slotsTable tbody');

let currentSessionId = null;
let searchTerm       = '';

// ─── 1) Fetch current session ───────────────────────────────────────────
async function fetchCurrentSession() {
  const res      = await fetch('/api/sessions');
  const sessions = await res.json();
  if (sessions.length) currentSessionId = sessions[0]._id;
}

// ─── 2) Compute date filters ─────────────────────────────────────────────
function computeDates() {
  const p   = periodSelect.value;
  const now = new Date();
  let sd = null, ed = null;

  if (p === 'daily') {
    sd = new Date(now); sd.setHours(0,0,0,0);
    ed = now;
  } else if (p === 'weekly') {
    sd = new Date(now); sd.setDate(now.getDate()-6); sd.setHours(0,0,0,0);
    ed = now;
  } else if (p === 'monthly') {
    sd = new Date(now); sd.setDate(now.getDate()-29); sd.setHours(0,0,0,0);
    ed = now;
  } else if (p === 'custom') {
    if (startInput.value) sd = new Date(startInput.value);
    if (endInput.value)   ed = new Date(endInput.value);
  }

  return { sd, ed };
}

// ─── 3) Load & render slots ─────────────────────────────────────────────
async function loadSlots() {
  const { sd, ed } = computeDates();
  const qp = new URLSearchParams();

  if (periodSelect.value === 'session' && currentSessionId) {
    qp.set('sessionId', currentSessionId);
  } else {
    if (sd) qp.set('startDate', sd.toISOString().slice(0,10));
    if (ed) qp.set('endDate',   ed.toISOString().slice(0,10));
  }

  const url   = `/api/slots?${qp.toString()}`;
  console.log('🔍 Fetching slots:', url);
  const slots = await (await fetch(url)).json();

  // clear table
  tableBody.innerHTML = '';

  // render each slot
  slots.forEach(s => {
    // live search filter
    const u = s.user.toLowerCase();
    const m = s.msg.toLowerCase();
    if (searchTerm && !u.includes(searchTerm) && !m.includes(searchTerm)) {
      return;
    }

    // ← use the persisted outCount field
    const outCount = s.outCount || 0;

    const tr = document.createElement('tr');
    tr.dataset.id = s._id;
    tr.innerHTML = `
      <td>${new Date(s.time).toLocaleTimeString()}</td>
      <td class="user-cell">${s.user}</td>
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

// ─── 4) Button handlers ─────────────────────────────────────────────────
tableBody.addEventListener('click', async e => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const id = tr.dataset.id;

  if (e.target.matches('.in-btn')) {
    await fetch(`/api/slots/${id}`, {
      method:'PATCH',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ status:'IN' })
    });
    tr.remove();
  }
  else if (e.target.matches('.out-btn')) {
    await fetch(`/api/slots/${id}`, {
      method:'PATCH',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ status:'OUT' })
    });
    tr.remove();
  }
  else if (e.target.matches('.delete-btn')) {
    await fetch(`/api/slots/${id}`, { method:'DELETE' });
    tr.remove();
  }
  else if (e.target.matches('.edit-btn')) {
    const cell = tr.querySelector('.msg-cell');
    const old  = cell.textContent;
    cell.innerHTML = `
      <input class="edit-input" value="${old}"/>
      <button class="save-btn">Save</button>
      <button class="cancel-btn">Cancel</button>
    `;
  }
  else if (e.target.matches('.save-btn')) {
    const val = tr.querySelector('.edit-input').value.trim();
    if (!val) return alert('Slot cannot be empty');
    await fetch(`/api/slots/${id}`, {
      method:'PATCH',
      headers:{ 'Content-Type':'application/json' },
      body: JSON.stringify({ msg: val })
    });
    tr.querySelector('.msg-cell').textContent = val;
  }
  else if (e.target.matches('.cancel-btn')) {
    loadSlots();
  }
});

// ─── 5) Search & filters ─────────────────────────────────────────────────
searchInput.addEventListener('input', e => {
  searchTerm = e.target.value.trim().toLowerCase();
  loadSlots();
});
periodSelect.addEventListener('change', loadSlots);
startInput .addEventListener('change', loadSlots);
endInput   .addEventListener('change', loadSlots);

// ─── 6) Init & SSE ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await fetchCurrentSession();
  loadSlots();

  // SSE for instant updates
  const es = new EventSource('/events');
  ['slot','update','delete','settings'].forEach(evt =>
    es.addEventListener(evt, loadSlots)
  );
});
