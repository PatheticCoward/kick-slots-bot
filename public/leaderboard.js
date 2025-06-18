// public/leaderboard.js
const periodSelect = document.getElementById('periodSelect');
const startInput   = document.getElementById('startDate');
const endInput     = document.getElementById('endDate');
const countBody    = document.querySelector('#countTable tbody');
const payoutBody   = document.querySelector('#payoutTable tbody');

function computeDates() {
  const now = new Date();
  let start, end = now;
  switch (periodSelect.value) {
    case 'daily':
      start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      break;
    case 'weekly':
      start = new Date(now - 7*24*60*60*1000);
      break;
    case 'monthly':
      start = new Date(now - 30*24*60*60*1000);
      break;
    case 'custom':
      start = startInput.value ? new Date(startInput.value) : null;
      end   = endInput.value   ? new Date(endInput.value)   : now;
      break;
    default:
      return { start:null, end:null };
  }
  return {
    start: start.toISOString().slice(0,10),
    end:   end.toISOString().slice(0,10)
  };
}

async function loadLeaderboard() {
  const { start, end } = computeDates();
  const qp = new URLSearchParams({ status:'IN' });
  if (periodSelect.value !== 'daily' &&
      periodSelect.value !== 'weekly' &&
      periodSelect.value !== 'monthly') {
    if (start) qp.set('startDate', start);
    if (end)   qp.set('endDate',   end);
  } else {
    if (start) qp.set('startDate', start);
    if (end)   qp.set('endDate',   end);
  }

  const res = await fetch(`/api/slots?${qp}`);
  const slots = await res.json();

  const counts = {}, sums = {};
  slots.forEach(s => {
    counts[s.user] = (counts[s.user]||0) + 1;
    sums[s.user]   = (sums[s.user]  ||0) + (s.payout||0);
  });

  countBody.innerHTML = '';
  Object.entries(counts)
    .sort((a,b)=>b[1]-a[1])
    .forEach(([u,c])=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${u}</td><td>${c}</td>`;
      countBody.append(tr);
    });

  payoutBody.innerHTML = '';
  Object.entries(sums)
    .sort((a,b)=>b[1]-a[1])
    .forEach(([u,total])=>{
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${u}</td><td>$${total.toFixed(2)}</td>`;
      payoutBody.append(tr);
    });
}

document.addEventListener('DOMContentLoaded', () => {
  periodSelect.addEventListener('change', ()=>{
    const custom = periodSelect.value==='custom';
    startInput.disabled = !custom;
    endInput.disabled   = !custom;
    loadLeaderboard();
  });
  startInput.addEventListener('change', loadLeaderboard);
  endInput  .addEventListener('change', loadLeaderboard);

  loadLeaderboard();

  const es = new EventSource('/events');
  ['slot','update','delete'].forEach(evt=>
    es.addEventListener(evt, loadLeaderboard)
  );
});
