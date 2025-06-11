// public/in-out.js

async function fetchByStatus(st) {
  const res = await fetch(`/api/slots?status=${st}`);
  if (!res.ok) throw new Error(`Failed to fetch ${st}`);
  return res.json();
}

function renderBadges(slot) {
  const icons = [];
  if (slot.subscriber) icons.push('⭐');
  if (slot.vip)        icons.push('💎');
  if (slot.moderator)  icons.push('🛡️');
  return icons.length ? ' ' + icons.join(' ') : '';
}

async function renderInOut() {
  const inSlots  = await fetchByStatus('IN');
  const outSlots = await fetchByStatus('OUT');

  const inT    = document.querySelector('#in-table tbody');
  const outT   = document.querySelector('#out-table tbody');
  inT.innerHTML = '';
  outT.innerHTML= '';

  inSlots.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.user}${renderBadges(s)}</td>
      <td>${s.msg}</td>
    `;
    inT.append(tr);
  });

  outSlots.forEach(s => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${s.user}${renderBadges(s)}</td>
      <td>${s.msg}</td>
    `;
    outT.append(tr);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  renderInOut();
  setInterval(renderInOut, 5000);
});
