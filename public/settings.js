// public/settings.js

// Elements
const enableLimits     = document.getElementById('enableLimits');
const subLimitInput    = document.getElementById('subLimit');
const vipLimitInput    = document.getElementById('vipLimit');
const modLimitInput    = document.getElementById('modLimit');
const folLimitInput    = document.getElementById('followerLimit');
const outCooldownInput = document.getElementById('outCooldown');
const saveSettingsBtn  = document.getElementById('saveSettings');

const timeoutUser      = document.getElementById('timeoutUser');
const userListD        = document.getElementById('userList');
const timeoutDur       = document.getElementById('timeoutDuration');
const addTimeoutBtn    = document.getElementById('addTimeoutBtn');
const timeoutsBody     = document.querySelector('#timeoutsTable tbody');

let currentSessionId = null;

// SSE for live updates
const es = new EventSource('/events');
es.addEventListener('settings', loadSettings);
es.addEventListener('timeoutAdd', loadTimeouts);
es.addEventListener('timeoutRemove', loadTimeouts);

// 1) Load settings from server
async function loadSettings() {
  const res = await fetch('/api/settings');
  const cfg = await res.json();
  enableLimits.checked      = cfg.enabled;
  subLimitInput.value       = cfg.subLimit;
  vipLimitInput.value       = cfg.vipLimit;
  modLimitInput.value       = cfg.modLimit;
  folLimitInput.value       = cfg.followerLimit;
  outCooldownInput.value    = cfg.outCooldownMinutes;
}

// 2) Save settings
saveSettingsBtn.addEventListener('click', async () => {
  const payload = {
    enabled: enableLimits.checked,
    subLimit: parseInt(subLimitInput.value, 10),
    vipLimit: parseInt(vipLimitInput.value, 10),
    modLimit: parseInt(modLimitInput.value, 10),
    followerLimit: parseInt(folLimitInput.value, 10),
    outCooldownMinutes: parseFloat(outCooldownInput.value)
  };
  await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  alert('Settings saved!');
});

// 3) Fetch current session (for user autocomplete)
async function fetchCurrentSession() {
  const res = await fetch('/api/sessions');
  const sessions = await res.json();
  if (sessions.length) currentSessionId = sessions[0]._id;
}

// 4) Populate user autocomplete
async function loadUserList() {
  if (!currentSessionId) return;
  const res   = await fetch(`/api/slots?sessionId=${currentSessionId}`);
  const slots = await res.json();
  const users = Array.from(new Set(slots.map(s => s.user))).sort();
  userListD.innerHTML = users.map(u => `<option value="${u}">`).join('');
}

// 5) Render timeouts table
function startCountdown(tr, expiresAt) {
  const cell = tr.querySelector('.remain-cell');
  let iv;
  function tick() {
    const diff = new Date(expiresAt) - Date.now();
    if (diff <= 0) {
      clearInterval(iv);
      tr.remove();
    } else {
      const m = Math.floor(diff/60000);
      const s = Math.floor((diff%60000)/1000).toString().padStart(2,'0');
      cell.textContent = `${m}m ${s}s`;
    }
  }
  tick();
  iv = setInterval(tick, 1000);
}

async function loadTimeouts() {
  const res = await fetch('/api/timeouts');
  const arr = await res.json();
  timeoutsBody.innerHTML = '';
  arr.forEach(to => {
    const tr = document.createElement('tr');
    tr.dataset.id = to._id;
    tr.innerHTML = `
      <td>${to.user}</td>
      <td class="remain-cell"></td>
      <td><button class="remove-timeout-btn">Remove</button></td>
    `;
    timeoutsBody.append(tr);
    startCountdown(tr, to.expiresAt);
  });
}

// 6) Add timeout
addTimeoutBtn.addEventListener('click', async () => {
  const user = timeoutUser.value.trim();
  const dur  = parseInt(timeoutDur.value, 10);
  if (!user || isNaN(dur) || dur <= 0) {
    return alert('Enter valid user & minutes');
  }
  await fetch('/api/timeouts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user, duration: dur })
  });
  timeoutDur.value = '';
});

// 7) Remove timeout early
timeoutsBody.addEventListener('click', async e => {
  if (!e.target.matches('.remove-timeout-btn')) return;
  const id = e.target.closest('tr').dataset.id;
  await fetch(`/api/timeouts/${id}`, { method: 'DELETE' });
});

// 8) Init on load
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await fetchCurrentSession();
  await loadUserList();
  await loadTimeouts();
});
