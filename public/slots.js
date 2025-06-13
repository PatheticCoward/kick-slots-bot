// public/slots.js
document.addEventListener('DOMContentLoaded', () => {
  const sessSel   = document.getElementById('sessionSelect');
  const userF     = document.getElementById('userFilter');
  const slotF     = document.getElementById('slotFilter');
  const subBtn    = document.getElementById('sortSubBtn');
  const userBtn   = document.getElementById('sortUserBtn');
  const clearBtn  = document.getElementById('clearBtn');
  const dlBtn     = document.getElementById('downloadBtn');
  const body      = document.getElementById('slots-body');
  const summary   = document.getElementById('summary-body');
  let allSlots = [], display = [];

  // fetch sessions once
  async function loadSessions() {
    const res = await fetch('/api/sessions');
    const arr = await res.json();
    sessSel.innerHTML = arr.map(s => `<option value="${s._id}">${s.label}</option>`).join('');
    if (arr.length) sessSel.value = arr[0]._id;
    await loadSlots();
  }

  // fetch current session's slots
  async function loadSlots() {
    const sid = sessSel.value;
    const res = await fetch(`/api/slots?sessionId=${sid}`);
    allSlots = await res.json();
    display = allSlots.filter(s => !s.status);
    applySortFilter();
    render();
  }

  function applySortFilter() {
    let arr = display.filter(s =>
      s.user.toLowerCase().includes(userF.value.toLowerCase()) &&
      s.msg.toLowerCase().includes(slotF.value.toLowerCase())
    );
    if (subBtn.dataset.active==='true') {
      arr.sort((a,b)=> (b.subscriber?1:0)-(a.subscriber?1:0));
    }
    if (userBtn.dataset.active==='true') {
      arr.sort((a,b)=> a.user.localeCompare(b.user));
    }
    display = arr;
  }

  function render() {
    body.innerHTML = display.map((s,i)=>`
      <tr>
        <td>${i+1}</td>
        <td>${new Date(s.time).toLocaleTimeString()}</td>
        <td>${s.user}${badges(s)}</td>
        <td>${s.msg}</td>
        <td>
          <button onclick="markIn('${s._id}')">IN</button>
          <button onclick="markOut('${s._id}')">OUT</button>
          <button onclick="deleteSlot('${s._id}')">Delete</button>
        </td>
      </tr>
    `).join('');
    const counts = display.reduce((o,s)=>{
      o[s.user]=(o[s.user]||0)+1;return o;
    }, {});
    summary.innerHTML = Object.entries(counts)
      .map(([u,c])=>`<tr><td>${u}</td><td>${c}</td></tr>`)
      .join('');
  }

  function badges(s) {
    const ic=[];
    if(s.subscriber) ic.push('⭐');
    if(s.vip)        ic.push('💎');
    if(s.moderator)  ic.push('🛡️');
    return ic.length?' '+ic.join(''):'';
  }

  window.deleteSlot = async id => {
    await fetch(`/api/slots/${id}`,{method:'DELETE'});
  };
  window.markIn = async id => {
    await fetch(`/api/slots/${id}`,{
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({status:'IN'})
    });
  };
  window.markOut = async id => {
    await fetch(`/api/slots/${id}`,{
      method:'PATCH',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({status:'OUT'})
    });
  };

  // UI
  sessSel.addEventListener('change', loadSlots);
  userF  .addEventListener('input', ()=>{applySortFilter();render();});
  slotF  .addEventListener('input', ()=>{applySortFilter();render();});
  subBtn .addEventListener('click', ()=>{
    subBtn.dataset.active=(subBtn.dataset.active==='true'?'false':'true');
    applySortFilter();render();
  });
  userBtn.addEventListener('click', ()=>{
    userBtn.dataset.active=(userBtn.dataset.active==='true'?'false':'true');
    applySortFilter();render();
  });
  clearBtn.addEventListener('click', ()=>{
    userF.value=slotF.value='';
    subBtn.dataset.active=userBtn.dataset.active='false';
    applySortFilter();render();
  });
  dlBtn.addEventListener('click',()=>{
    const csv=[
      ['#','Time','User','Slot'],
      ...display.map((s,i)=>[
        i+1,
        new Date(s.time).toISOString(),
        s.user,
        `"${s.msg.replace(/"/g,'""')}"`
      ])
    ].map(r=>r.join(',')).join('\n');
    const b=new Blob([csv],{type:'text/csv'});
    const a=document.createElement('a');
    a.href=URL.createObjectURL(b);
    a.download=`slots_${sessSel.value}.csv`;
    a.click();
  });

  // --- SSE subscription ---
  const es = new EventSource('/events');
  es.addEventListener('slot', e=>{
    const slot = JSON.parse(e.data);
    if(slot.sessionId === sessSel.value) {
      allSlots.unshift(slot);
      loadSlots();
    }
  });
  es.addEventListener('update', e=>{
    const upd = JSON.parse(e.data);
    // if a slot got marked IN/OUT, reload so it's filtered out
    if(upd.status) loadSlots();
  });
  es.addEventListener('delete', ()=> loadSlots());

  // start
  loadSessions();
});
