// public/leaderboard.js
document.addEventListener('DOMContentLoaded', () => {
  const sessSel = document.getElementById('sessionSelect');
  const countB  = document.querySelector('#count-table tbody');
  const payB    = document.querySelector('#payout-table tbody');

  async function loadSessions() {
    const res      = await fetch('/api/sessions');
    const sessions = await res.json();
    sessSel.innerHTML = sessions
      .map(s=>`<option value="${s._id}">${s.label}</option>`)
      .join('');
    if(sessions.length) sessSel.value=sessions[0]._id;
    renderLeaderboard();
  }

  async function renderLeaderboard() {
    const sid   = sessSel.value;
    const res   = await fetch(`/api/slots?sessionId=${sid}&status=IN`);
    const slots = await res.json();

    const cm={}, pm={};
    slots.forEach(s=>{
      cm[s.user]=(cm[s.user]||0)+1;
      pm[s.user]=(pm[s.user]||0)+(parseFloat(s.payout)||0);
    });

    countB.innerHTML = Object.entries(cm)
      .map(([u,c])=>`<tr><td>${u}</td><td>${c}</td></tr>`).join('');
    payB.innerHTML   = Object.entries(pm)
      .map(([u,t])=>`<tr><td>${u}</td><td>${t.toFixed(2)}</td></tr>`).join('');
  }

  sessSel.addEventListener('change', renderLeaderboard);

  // SSE
  const es = new EventSource('/events');
  es.addEventListener('slot',        () => renderLeaderboard());
  es.addEventListener('update',      () => renderLeaderboard());
  es.addEventListener('delete',      () => renderLeaderboard());

  loadSessions();
});
