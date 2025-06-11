let sortBySubscriber = false;
let sortByUsername   = false;

function getFilters() {
  return {
    userVal: document.getElementById('userFilter').value.toLowerCase().trim(),
    slotVal: document.getElementById('slotFilter').value.toLowerCase().trim()
  };
}

async function fetchSlotsFromServer() {
  const res = await fetch('/api/slots');
  if (!res.ok) throw new Error('Failed to fetch slots');
  return res.json();
}

async function fetchAndUpdateTable() {
  let slots = await fetchSlotsFromServer();

  // hide any with status IN/OUT
  slots = slots.filter(s => !s.status);

  const { userVal, slotVal } = getFilters();
  if (userVal || slotVal) {
    slots = slots.filter(s =>
      s.user.toLowerCase().includes(userVal) &&
      s.msg.toLowerCase().includes(slotVal)
    );
  }

  // build summary
  const summaryMap = {};
  slots.forEach(s => {
    if (!summaryMap[s.user]) {
      summaryMap[s.user] = { count: 0 };
    }
    summaryMap[s.user].count += 1;
  });

  // sort main
  if (sortByUsername) {
    slots.sort((a,b)=> a.user.localeCompare(b.user));
  } else if (sortBySubscriber) {
    slots.sort((a,b)=> b.subscriber - a.subscriber);
  }

  // count dups for highlight
  const msgCount = {};
  slots.forEach(s=>{
    const key=s.msg.toLowerCase().trim();
    msgCount[key]=(msgCount[key]||0)+1;
  });

  // render main
  const tbody = document.getElementById('slots-body');
  tbody.innerHTML = '';
  slots.forEach((s,i)=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${i+1}</td>
      <td>${new Date(s.time).toLocaleString()}</td>
      <td>${s.user}${s.subscriber?' ⭐':''}${s.vip?' 💎':''}${s.moderator?' 🛡️':''}</td>
      <td${msgCount[s.msg.toLowerCase().trim()]>1?' style="color:red;font-weight:bold"':''}>${s.msg}</td>
      <td></td>
    `;
    const actTd = tr.querySelector('td:last-child');

    // DELETE
    const del = document.createElement('button');
    del.textContent='Delete';
    del.onclick = async()=>{
      if(!confirm('Delete this slot?'))return;
      await fetch(`/api/slots/${s._id}`,{method:'DELETE'});
      fetchAndUpdateTable();
    };
    actTd.append(del);

    // IN
    const inBtn = document.createElement('button');
    inBtn.textContent='IN';
    inBtn.onclick = async()=>{
      await fetch(`/api/slots/${s._id}`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({status:'IN'})
      });
      fetchAndUpdateTable();
    };
    actTd.append(inBtn);

    // OUT
    const out = document.createElement('button');
    out.textContent='OUT';
    out.onclick = async()=>{
      await fetch(`/api/slots/${s._id}`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({status:'OUT'})
      });
      fetchAndUpdateTable();
    };
    actTd.append(out);

    tbody.append(tr);
  });

  // render summary
  const sumTbody = document.getElementById('summary-body');
  sumTbody.innerHTML = '';
  Object.keys(summaryMap).sort().forEach(u=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${u}</td><td>${summaryMap[u].count}</td>`;
    sumTbody.append(tr);
  });
}

document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('userFilter').oninput = fetchAndUpdateTable;
  document.getElementById('slotFilter').oninput = fetchAndUpdateTable;
  document.getElementById('sortSubBtn').onclick = ()=>{
    sortBySubscriber = !sortBySubscriber;
    sortByUsername = false;
    fetchAndUpdateTable();
  };
  document.getElementById('sortUserBtn').onclick = ()=>{
    sortByUsername = !sortByUsername;
    sortBySubscriber = false;
    fetchAndUpdateTable();
  };
  document.getElementById('clearBtn').onclick = async()=>{
    if(!confirm('Clear all slots?'))return;
    await fetch('/api/slots',{method:'DELETE'});
    fetchAndUpdateTable();
  };
  document.getElementById('downloadBtn').onclick = async()=>{
    const slots = await fetchSlotsFromServer();
    const blob = new Blob([slots.map(s=>`${s.user}: ${s.msg}`).join('\n')],{type:'text/plain'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'slots.txt';
    a.click();
  };

  fetchAndUpdateTable();
  setInterval(fetchAndUpdateTable,5000);
});
