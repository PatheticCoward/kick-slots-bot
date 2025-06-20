// public/leaderboard.js

const periodSelect = document.getElementById('periodSelect');
const startInput   = document.getElementById('startDate');
const endInput     = document.getElementById('endDate');
const countBody    = document.querySelector('#countTable tbody');
const payoutBody   = document.querySelector('#payoutTable tbody');

// ─── Helper: format Date as local YYYY-MM-DD in Eastern ────────────────
function formatLocalDate(d) {
  return d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function computeDates() {
  const p   = periodSelect.value;
  const now = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
  let sd = new Date(now), ed = new Date(now);

  if (p === 'weekly')  sd.setDate(sd.getDate() - 6);
  if (p === 'monthly') sd.setDate(sd.getDate() - 29);
  if (p === 'custom') {
    if (startInput.value) sd = new Date(`${startInput.value}T00:00:00`);
    if (endInput.value)   ed = new Date(`${endInput.value}T00:00:00`);
  }

  return { sd, ed };
}

async function loadLeaderboard() {
  const { sd, ed } = computeDates();
  const qp = new URLSearchParams();

  if (periodSelect.value === 'custom') {
    if (startInput.value) qp.set('startDate', startInput.value);
    if (endInput.value)   qp.set('endDate',   endInput.value);
  } else {
    qp.set('startDate', formatLocalDate(sd));
    qp.set('endDate',   formatLocalDate(ed));
  }

  console.log('🔍 [leaderboard] Params:', qp.toString());

  // — Slot Counts —
  const urlCount = `/api/slots?status=IN&${qp.toString()}`;
  console.log('→ Fetch Count:', urlCount);
  const res1 = await fetch(urlCount);
  const data1 = await res1.json();

  // tally and sort descending
  const counts = data1.reduce((acc, s) => {
    acc[s.user] = (acc[s.user] || 0) + 1;
    return acc;
  }, {});

  const sortedCounts = Object.entries(counts)
    .sort(([,a], [,b]) => b - a);

  countBody.innerHTML = '';
  sortedCounts.forEach(([user, count]) => {
    // find one record for badges
    const rec = data1.find(s => s.user === user);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        ${user}
        ${rec.moderator  ? '<span class="badge mod">MOD</span>' : ''}
        ${rec.vip        ? '<span class="badge vip">VIP</span>' : ''}
        ${rec.subscriber ? '<span class="badge sub">SUB</span>' : ''}
      </td>
      <td>${count}</td>
    `;
    countBody.append(tr);
  });

  // — Total Payouts —
  console.log('→ Fetch Payout:', urlCount);
  const res2 = await fetch(urlCount);
  const data2 = await res2.json();

  const payouts = data2.reduce((acc, s) => {
    acc[s.user] = (acc[s.user] || 0) + (s.payout || 0);
    return acc;
  }, {});

  const sortedPayouts = Object.entries(payouts)
    .sort(([,a], [,b]) => b - a);

  payoutBody.innerHTML = '';
  sortedPayouts.forEach(([user, total]) => {
    const rec = data2.find(s => s.user === user);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>
        ${user}
        ${rec.moderator  ? '<span class="badge mod">MOD</span>' : ''}
        ${rec.vip        ? '<span class="badge vip">VIP</span>' : ''}
        ${rec.subscriber ? '<span class="badge sub">SUB</span>' : ''}
      </td>
      <td>${total.toFixed(2)}</td>
    `;
    payoutBody.append(tr);
  });
}

periodSelect.addEventListener('change', loadLeaderboard);
startInput .addEventListener('change', loadLeaderboard);
endInput   .addEventListener('change', loadLeaderboard);

document.addEventListener('DOMContentLoaded', loadLeaderboard);
