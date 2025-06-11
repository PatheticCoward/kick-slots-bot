// public/leaderboard.js

async function loadLeaderboard() {
  // Fetch only slots marked IN
  const res = await fetch('/api/slots?status=IN');
  if (!res.ok) {
    console.error('Failed to fetch IN slots');
    return;
  }
  const slots = await res.json();

  // Tally counts and badges per user
  const counts = {};
  slots.forEach(s => {
    if (!counts[s.user]) {
      counts[s.user] = {
        count:       0,
        subscriber:  false,
        vip:         false,
        moderator:   false
      };
    }
    counts[s.user].count += 1;
    if (s.subscriber) counts[s.user].subscriber = true;
    if (s.vip)        counts[s.user].vip        = true;
    if (s.moderator)  counts[s.user].moderator  = true;
  });

  // Prepare sorted array
  const data = Object.entries(counts)
    .map(([user, info]) => ({ user, ...info }))
    .sort((a, b) => b.count - a.count);

  // Render table
  const tbody = document.querySelector('#leaderboard tbody');
  tbody.innerHTML = '';
  data.forEach((entry, idx) => {
    const icons = [];
    if (entry.subscriber) icons.push('⭐');
    if (entry.vip)        icons.push('💎');
    if (entry.moderator)  icons.push('🛡️');

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${entry.user}${icons.length ? ' ' + icons.join(' ') : ''}</td>
      <td>${entry.count}</td>
    `;
    tbody.append(tr);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadLeaderboard();
  setInterval(loadLeaderboard, 5000);
});
