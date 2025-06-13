// public/in-out.js
document.addEventListener('DOMContentLoaded', () => {
  const sessSel = document.getElementById('sessionSelect');
  const inB     = document.querySelector('#in-table tbody');
  const outB    = document.querySelector('#out-table tbody');

  async function loadSessions() {
    const res      = await fetch('/api/sessions');
    const sessions = await res.json();
    sessSel.innerHTML = sessions
      .map(s=>`<option value="${s._id}">${s.label}</option>`)
      .join('');
    if(sessions.length) sessSel.value=sessions[0]._id;
    renderInOut();
  }

  async function renderInOut() {
    const sid      = sessSel.value;
    const [inRes,outRes] = await Promise.all([
      fetch(`/api/slots?sessionId=${sid}&status=IN`),
      fetch(`/api/slots?sessionId=${sid}&status=OUT`)
    ]);
    const [inSlots,outSlots] = await Promise.all([inRes.json(),outRes.json()]);

    const badge = s=>{
      const ic=[];
      if(s.subscriber) ic.push('⭐');
      if(s.vip)        ic.push('💎');
      if(s.moderator)  ic.push('🛡️');
      return ic.length?' '+ic.join(''):'';
    };

    inB.innerHTML = inSlots.map(s=>`
      <tr>
        <td>${s.user}${badge(s)}</td>
        <td>${s.msg}</td>
        <td>
          <input type="number" step="0.01" id="payout-${s._id}"
                 class="payout-input" value="${s.payout||''}" placeholder="0.00">
          <button onclick="savePayout('${s._id}')">Save</button>
        </td>
      </tr>
    `).join('');

    outB.innerHTML = outSlots.map(s=>`
      <tr>
        <td>${s.user}${badge(s)}</td>
        <td>${s.msg}</td>
      </tr>
    `).join('');
  }

  window.savePayout = async id => {
    const val=document.getElementById(`payout-${id}`).value;
    await fetch(`/api/slots/${id}`,{
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({payout: val})
    });
  };

  sessSel.addEventListener('change', renderInOut);

  // SSE
  const es = new EventSource('/events');
  es.addEventListener('slot', e => {
    const s = JSON.parse(e.data);
    if(s.sessionId===sessSel.value && s.status==='IN') renderInOut();
    if(s.sessionId===sessSel.value && s.status==='OUT') renderInOut();
  });
  es.addEventListener('update', e => {
    const u = JSON.parse(e.data);
    if(u.id && sessSel.value) renderInOut();
  });
  es.addEventListener('delete', renderInOut);

  loadSessions();
});
