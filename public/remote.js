const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  boot: null,
  apps: [],
  custom: [],
  customChecks: new Set(),
  touchActive: false,
  deferredInstall: null
};

let toastTimer = null;
let confirmCb = null;

function toast(msg, ok) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('warn', !ok);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500);
}

async function api(url, opts) {
  let r;
  try {
    r = await fetch(url, opts);
  } catch (e) {
    toast('PC non raggiungibile: attiva Tailscale', false);
    return { status: 0, data: {} };
  }
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { location.href = '/'; }
  return { status: r.status, data };
}

function confirmDialog(text, cb) {
  $('confirmText').textContent = text;
  confirmCb = cb;
  $('confirmOverlay').classList.remove('hidden');
}
$('confirmYes').addEventListener('click', () => { $('confirmOverlay').classList.add('hidden'); if (confirmCb) confirmCb(); confirmCb = null; });
$('confirmNo').addEventListener('click', () => { $('confirmOverlay').classList.add('hidden'); confirmCb = null; });

const DANGEROUS = ['shutdown', 'restart', 'logout', 'hibernate', 'sleep'];

async function runAction(action, payload) {
  const doRun = async () => {
    const { status, data } = await api('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, payload })
    });
    if (status !== 200) { toast((data.error || 'Errore'), false); return; }
    if (data.ok) {
      if (data.image) {
        $('screenImg').src = data.image + '?t=' + Date.now();
        $('screenWrap').classList.remove('hidden');
      } else if (data.stdout) {
        toast(String(data.stdout).trim(), true);
      } else {
        toast('Fatto', true);
      }
    } else {
      toast(data.stderr || 'Errore', false);
    }
  };
  const labels = { shutdown: 'Spegnere il PC?', restart: 'Riavviare il PC?', logout: 'Disconnettere l utente?', hibernate: 'Mettere in ibernazione?', sleep: 'Mettere in sospensione?' };
  if (DANGEROUS.includes(action)) {
    confirmDialog(labels[action] || 'Eseguire?', doRun);
  } else {
    doRun();
  }
}

document.querySelectorAll('[data-action]').forEach((el) => {
  el.addEventListener('click', () => {
    let payload;
    try { payload = JSON.parse(el.getAttribute('data-payload') || '{}'); } catch (e) { payload = {}; }
    runAction(el.getAttribute('data-action'), payload);
  });
});

document.querySelectorAll('.tabbar .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabbar .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.querySelectorAll('.view .panel').forEach(p => p.classList.toggle('hidden', p.id !== 'panel-' + tab.dataset.panel));
  });
});

$('btnLogout').addEventListener('click', async () => {
  try {
    await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
  } catch (e) { }
  location.href = '/';
});

const installBtn = $('btnInstall');
function isStandalone() {
  const mode = window.matchMedia('(display-mode: standalone)').matches ||
    window.matchMedia('(display-mode: minimal-ui)').matches ||
    window.matchMedia('(display-mode: fullscreen)').matches;
  return mode || window.navigator.standalone === true;
}
function refreshInstallBtn() {
  installBtn.hidden = isStandalone();
}
refreshInstallBtn();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredInstall = e;
  refreshInstallBtn();
});
installBtn.addEventListener('click', async () => {
  if (!state.deferredInstall) { toast('Non ancora disponibile, riprova tra poco', false); return; }
  state.deferredInstall.prompt();
  const choice = await state.deferredInstall.userChoice.catch(() => ({ outcome: 'dismissed' }));
  if (choice.outcome === 'accepted') refreshInstallBtn();
  state.deferredInstall = null;
});
window.addEventListener('appinstalled', () => {
  refreshInstallBtn();
  toast('NexaRemote installata! Trovane l icona nella home', true);
});

$('btnRefresh').addEventListener('click', async () => {
  const { data } = await api('/api/status');
  if (data.boot) { state.boot = data.boot; renderHost(); } else { renderOffline(); }
  toast('Aggiornato', true);
});

function renderHost() {
  const b = state.boot;
  if (!b) return;
  const platformLabel = b.platform === 'darwin' ? 'macOS' : (b.platform === 'win32' ? 'Windows' : b.platform);
  $('hostInfo').textContent = (b.hostname || 'PC') + ' - ' + platformLabel;
  $('bootDot').classList.remove('off');
  const lastBoot = new Date(b.bootAt);
  const noto = lastBoot.toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  $('bootBanner').textContent = 'Il PC e acceso dalla ultimo avvio (' + noto + '), da ' + fmtUptime(b.uptimeSeconds) + '.';
  $('bootBanner').classList.remove('hidden');
  $('infoGrid').innerHTML = '';
  const rows = [
    ['Stato', 'Acceso'],
    ['Nome PC', b.hostname],
    ['Sistema', platformLabel],
    ['Memoria', b.totalMemGb + ' GB'],
    ['Porta', b.port],
    ['Acceso da', fmtUptime(b.uptimeSeconds)],
    ['Il tuo dispositivo', state.user && state.user.os ? (state.user.os === 'mac' ? 'Mac' : 'Windows') : '']
  ];
  for (const [k, v] of rows) {
    const d = document.createElement('div');
    d.className = 'info-row';
    d.innerHTML = '<span>' + esc(k) + '</span><strong>' + esc(String(v)) + '</strong>';
    $('infoGrid').appendChild(d);
  }
}

function renderOffline() {
  $('bootDot').classList.add('off');
  $('bootBanner').classList.add('hidden');
  $('hostInfo').textContent = 'PC - Spento';
  $('infoGrid').innerHTML = '';
  const rows = [
    ['Stato', 'Spento'],
    ['Nome PC', '-'],
    ['Sistema', '-'],
    ['Memoria', '-'],
    ['Porta', '-'],
    ['Acceso da', 'Spento'],
    ['Il tuo dispositivo', state.user && state.user.os ? (state.user.os === 'mac' ? 'Mac' : 'Windows') : '']
  ];
  for (const [k, v] of rows) {
    const d = document.createElement('div');
    d.className = 'info-row';
    d.innerHTML = '<span>' + esc(k) + '</span><strong>' + esc(String(v)) + '</strong>';
    $('infoGrid').appendChild(d);
  }
}

function fmtUptime(sec) {
  if (sec == null) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return h + ' ore e ' + m + ' min';
  return m + ' minuti';
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

$('btnScreenshot').addEventListener('click', async () => {
  $('btnScreenshot').textContent = 'Scattando...';
  const { status, data } = await api('/api/screenshot');
  $('btnScreenshot').textContent = 'Fa una foto (screenshot)';
  if (status !== 200 || !data.ok) { toast(data.stderr || 'Screenshot fallito', false); return; }
  $('screenImg').src = data.image + '?t=' + Date.now();
  $('screenWrap').classList.remove('hidden');
});
$('btnHideScreenshot').addEventListener('click', () => $('screenWrap').classList.add('hidden'));

const btnLive = $('btnLive');
const btnLiveFullscreen = $('btnLiveFullscreen');
const liveWrap = $('liveWrap');
const liveImg = $('liveImg');
const liveSize = $('liveSize');
const btnRotateLive = $('btnRotateLive');
let liveTimer = null;
let liveActive = false;
let liveAudio = null;

function stopLive() {
  liveActive = false;
  clearInterval(liveTimer);
  liveTimer = null;
  btnLive.textContent = 'Avvia live';
  liveWrap.classList.add('hidden');
  btnLiveFullscreen.disabled = true;
  btnLiveFullscreen.textContent = 'Schermo intero';
  liveImg.classList.remove('rotated');
  if (liveAudio) { liveAudio.pause(); liveAudio.src = ''; liveAudio = null; }
}

function startAudio() {
  if (liveAudio) { liveAudio.pause(); liveAudio.src = ''; liveAudio = null; }
  const a = document.createElement('audio');
  a.loop = false;
  a.setAttribute('autoplay', '');
  a.src = '/api/audio?v=' + Date.now();
  a.play().catch(() => { });
  liveAudio = a;
}

async function liveUpdate() {
  const { status, data } = await api('/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'liveFrame' })
  });
  if (status !== 200 || !data.ok) { stopLive(); toast(data.stderr || 'Live non disponibile', false); return; }
  if (!liveActive) return;
  liveImg.src = data.image + '?t=' + Date.now();
  if (data.w) liveSize.textContent = 'Risoluzione live: ' + data.w + ' x ' + data.h;
}

btnLive.addEventListener('click', () => {
  if (liveActive) { stopLive(); return; }
  liveActive = true;
  btnLive.textContent = 'Ferma live';
  liveWrap.classList.remove('hidden');
  btnLiveFullscreen.disabled = false;
  startAudio();
  liveUpdate();
  liveTimer = setInterval(liveUpdate, 1200);
});

btnLiveFullscreen.addEventListener('click', () => {
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    if (document.exitFullscreen) document.exitFullscreen();
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
    return;
  }
  if (liveWrap.requestFullscreen) liveWrap.requestFullscreen().catch(() => toast('Schermo intero non disponibile', false));
  else if (liveWrap.webkitRequestFullscreen) liveWrap.webkitRequestFullscreen();
});

function onFsChange() {
  const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
  btnLiveFullscreen.textContent = inFs ? 'Esci da pieno schermo' : 'Schermo intero';
}
document.addEventListener('fullscreenchange', onFsChange);
document.addEventListener('webkitfullscreenchange', onFsChange);

btnRotateLive.addEventListener('click', () => {
  liveImg.classList.toggle('rotated');
});

const btnMic = $('btnMic');
let micRunning = false;
let micStream = null;
let micCtx = null;
let micNode = null;

function micStop() {
  micRunning = false;
  btnMic.textContent = 'Attiva microfono';
  btnMic.classList.remove('rec');
  try { if (micNode) micNode.disconnect(); } catch (e) { }
  try { if (micCtx) micCtx.close(); } catch (e) { }
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  micNode = null; micCtx = null; micStream = null;
  fetch('/api/audio/talk/stop', { method: 'POST', keepalive: true }).catch(() => { });
}

async function micStart() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch (e) {
    $('micUnsupported').classList.remove('hidden');
    toast('Microfono non accessibile', false);
    return;
  }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    micCtx = new AC({ sampleRate: 16000 });
  } catch (e2) {
    try { micCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e3) {
      micStream.getTracks().forEach((t) => t.stop());
      $('micUnsupported').classList.remove('hidden');
      return;
    }
  }
  const src = micCtx.createMediaStreamSource(micStream);
  const factor = micCtx.sampleRate / 16000;
  micNode = micCtx.createScriptProcessor(4096, 1, 1);
  micRunning = true;
  btnMic.textContent = 'Ferma microfono';
  btnMic.classList.add('rec');
  toast('Microfono attivo: parla, si sente dal PC', true);
  micNode.onaudioprocess = (e) => {
    if (!micRunning) return;
    const inData = e.inputBuffer.getChannelData(0);
    const outLen = Math.floor(inData.length / factor);
    const int16 = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      let s = inData[Math.floor(i * factor)];
      if (s > 1) s = 1; else if (s < -1) s = -1;
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    fetch('/api/audio/talk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: int16.buffer,
      keepalive: true
    }).catch(() => { });
  };
  src.connect(micNode);
  micNode.connect(micCtx.destination);
}

btnMic.addEventListener('click', () => {
  if (micRunning) { micStop(); return; }
  micStart();
});

async function checkBrightness() {
  const { status, data } = await api('/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'brightnessSupport' })
  });
  if (status !== 200 || !data.ok || data.supported === false) {
    $('brightSection').classList.add('hidden');
    $('brightUnsupported').classList.remove('hidden');
    $('brightUnsupported').textContent = 'La luminosita non e regolabile su questo PC.';
  }
}

let brightTimer = null;
$('brightRange').addEventListener('input', () => {
  clearTimeout(brightTimer);
  const val = $('brightRange').value;
  brightTimer = setTimeout(() => runAction('brightness', { value: val }), 500);
});

$('btnListApps').addEventListener('click', loadApps);
async function loadApps() {
  const { status, data } = await api('/api/apps');
  const list = $('appList');
  list.innerHTML = '';
  if (status !== 200 || !data.ok) { toast('Impossibile leggere i programmi', false); return; }
  state.apps = data.apps || [];
  if (!state.apps.length) {
    const li = document.createElement('li');
    li.textContent = 'Nessun programma con finestra aperta.';
    li.className = 'app-empty';
    list.appendChild(li);
    return;
  }
  for (const app of state.apps) {
    const li = document.createElement('li');
    li.className = 'app-item';
    const name = document.createElement('span');
    name.className = 'app-name';
    name.textContent = (app.title || app.name) + ' (' + app.id + ')';
    const btn = document.createElement('button');
    btn.textContent = 'Chiudi';
    btn.addEventListener('click', () => confirmDialog('Chiudere "' + (app.title || app.name) + '"?', async () => {
      const res = await runAction('closeApp', { name: app.name });
      setTimeout(loadApps, 800);
    }));
    li.appendChild(name);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

const pad = $('touchpad');
function sendMouse(xPct, yPct) {
  void runAction('mouseMove', { x: xPct, y: yPct });
}
pad.addEventListener('touchstart', (e) => {
  e.preventDefault();
  state.touchActive = true;
  sendMouseFromEvent(e);
}, { passive: false });
pad.addEventListener('touchmove', (e) => {
  e.preventDefault();
  if (state.touchActive) sendMouseFromEvent(e);
}, { passive: false });
pad.addEventListener('touchend', (e) => { e.preventDefault(); state.touchActive = false; }, { passive: false });
pad.addEventListener('mousedown', (e) => sendMouseFromEvent(e));
pad.addEventListener('mousemove', (e) => { if (e.buttons === 1) sendMouseFromEvent(e); });

let lastSend = 0;
function sendMouseFromEvent(e) {
  const now = Date.now();
  if (now - lastSend < 60) return;
  lastSend = now;
  let x = 50, y = 50;
  if (e.touches && e.touches.length) {
    x = e.touches[0].clientX; y = e.touches[0].clientY;
  } else if (e.clientX || e.clientY) {
    x = e.clientX; y = e.clientY;
  }
  const rect = pad.getBoundingClientRect();
  const xPct = Math.round(((x - rect.left) / rect.width) * 100);
  const yPct = Math.round(((y - rect.top) / rect.height) * 100);
  sendMouse(Math.max(0, Math.min(100, xPct)), Math.max(0, Math.min(100, yPct)));
}

$('btnTap').addEventListener('click', () => runAction('mouseClick', { button: 'left' }));
$('btnRightClick').addEventListener('click', () => runAction('mouseClick', { button: 'right' }));
$('btnDoubleRight').addEventListener('click', () => runAction('mouseClick', { button: 'left', double: true }));
document.querySelectorAll('[data-scroll]').forEach((b) => {
  b.addEventListener('click', () => {
    const dir = parseInt(b.getAttribute('data-scroll'), 10);
    runAction('mouseScroll', { delta: dir * 160 });
  });
});
$('btnScrolStop').addEventListener('click', () => toast('Scroll fermo', true));

$('btnType').addEventListener('click', async () => {
  const text = $('kbText').value;
  if (!text.trim()) { toast('Scrivi prima un testo', false); return; }
  const res = await runAction('typeText', { text });
  $('kbText').value = '';
});

$('btnTermRun').addEventListener('click', termRun);
$('termInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); termRun(); }
});
async function termRun() {
  const script = $('termInput').value;
  if (!script.trim()) { toast('Comando vuoto', false); return; }
  const out = $('termOut');
  out.textContent = 'Esecuzione...';
  const { status, data } = await api('/api/terminal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ script })
  });
  if (status !== 200 || !data.ok) {
    out.textContent = '[' + (data.stderr || data.error || 'Errore') + ']';
    return;
  }
  const t = 'PS> ' + script + '\n' + (data.stdout || '(nessun output)') + (data.stderr ? '\n[ERRORE] ' + data.stderr : '') + '\nexit code: ' + data.code + ' - ' + data.durationMs + ' ms' + (data.timedOut ? ' (TIMEOUT)' : '');
  out.textContent = t;
}
$('btnTermClear').addEventListener('click', () => { $('termOut').textContent = ''; $('termInput').value = ''; });

async function loadCustom() {
  const { data } = await api('/api/buttons');
  if (data.ok) {
    state.custom = data.buttons || [];
    renderCustom();
  }
}
$('btnAddButton').addEventListener('click', () => {
  const name = $('btnName').value.trim();
  const target = $('btnTarget').value.trim();
  if (!name || !target) { toast('Compila nome e destinazione', false); return; }
  state.custom.push({ name, target });
  $('btnName').value = '';
  $('btnTarget').value = '';
  renderCustom();
  toast('Pulsante aggiunto. Lo salvi con "Salva su questo PC".', true);
});
function renderCustom() {
  const list = $('customList');
  list.innerHTML = '';
  if (!state.custom.length) {
    const li = document.createElement('li');
    li.textContent = 'Nessun pulsante. Aggiungine uno qui sopra.';
    li.className = 'app-empty';
    list.appendChild(li);
    return;
  }
  state.custom.forEach((b, i) => {
    const li = document.createElement('li');
    li.className = 'custom-item';
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.customChecks.has(i);
    cb.addEventListener('change', () => {
      if (cb.checked) state.customChecks.add(i); else state.customChecks.delete(i);
    });
    const text = document.createElement('span');
    text.textContent = b.name + ' -> ' + b.target;
    const del = document.createElement('button');
    del.textContent = 'X';
    del.addEventListener('click', () => { state.custom.splice(i, 1); renderCustom(); });
    label.appendChild(cb);
    label.appendChild(text);
    li.appendChild(label);
    li.appendChild(del);
    list.appendChild(li);
  });
}
$('btnRunCustom').addEventListener('click', () => {
  const sel = [...state.customChecks].map(i => state.custom[i]);
  if (!sel.length) { toast('Seleziona almeno un pulsante', false); return; }
  if (sel.length > 3) { toast('Max 3 alla volta', false); return; }
  sel.forEach(b => runAction('openApp', { target: b.target }));
});
$('btnSaveButtons').addEventListener('click', async () => {
  const { status } = await api('/api/buttons', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buttons: state.custom })
  });
  toast(status === 200 ? 'Pulsanti salvati' : 'Errore salvataggio', status === 200);
});

(async () => {
  const s = await api('/api/session');
  if (!s.data.ok || !s.data.user) { location.href = '/'; return; }
  state.user = s.data.user;
  const st = await api('/api/status');
  if (st.data.boot) { state.boot = st.data.boot; renderHost(); } else { renderOffline(); }
  loadApps();
  loadCustom();
  checkBrightness();
})();