// Pagina che si apre sul PC: qui si scrive il codice di 6 cifre mostrato sul
// telefono e si conferma il collegamento. Non serve registrarsi.
// Se il PC ha un proprietario (colui che ha fatto il primo accesso), la pagina
// mostra anche i telefoni abbinati e permette di toglierli.
const $ = (id) => document.getElementById(id);

let codeTimer = null;
let pendingCode = '';

async function req(url, opts) {
  opts = opts || {};
  opts.headers = Object.assign({ 'Content-Type': 'application/json' }, NxaDevice.headers(), opts.headers || {});
  if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

// indirizzo pubblico del PC: quello da usare sempre (casa o fuori)
let PUBLIC_URL = '';
async function loadPublicUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  try {
    const r = await fetch('/api/status');
    const d = await r.json().catch(() => ({}));
    if (d && d.device && d.device.publicUrl) PUBLIC_URL = d.device.publicUrl;
  } catch (e) {}
  const box = document.getElementById('pubUrl');
  if (box && PUBLIC_URL) box.textContent = PUBLIC_URL;
  return PUBLIC_URL;
}

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

async function refresh() {
  const r = await req('/api/pair/devices');
  show('main');
  hide('needAuth');
  loadPublicUrl();
  // Senza accesso: si puo comunque collegare un telefono scrivendo il codice.
  if (r.status === 401 || !r.data || !r.data.isOwner) {
    hide('ownerArea');
    show('ownerNote');
    return;
  }
  show('ownerArea');
  hide('ownerNote');
  if (r.data.code) setCode(r.data.code.code, r.data.code.expiresAt);
  $('lanUrl').textContent = 'http://' + (r.data.lan || 'indirizzo-del-pc') + ':3002';
  if (r.data.publicUrl) { PUBLIC_URL = r.data.publicUrl; $('pubUrl').textContent = r.data.publicUrl; }
  renderDevices(r.data.devices || [], r.data.me);
  renderWaiting(r.data.pending || []);
}

function setCode(code, expiresAt) {
  $('codeBig').textContent = String(code);
  const left = Math.max(0, expiresAt - Date.now());
  const mins = Math.floor(left / 60000);
  const secs = Math.floor((left % 60000) / 1000);
  $('codeTime').textContent = left > 0
    ? 'valido per altri ' + mins + ' min ' + String(secs).padStart(2, '0') + ' sec'
    : 'codice scaduto: premi "Nuovo codice"';
  if (codeTimer) clearTimeout(codeTimer);
  codeTimer = setTimeout(refresh, 1000);
}

// Scritto il codice: si chiede "sei sicuro di voler connettere?" prima di collegare.
async function checkCode() {
  const code = $('confirmCode').value.replace(/\D/g, '');
  if (code.length !== 6) { $('confirmMsg').textContent = 'Il codice ha 6 cifre.'; return; }
  $('confirmMsg').textContent = 'controllo il codice...';
  const r = await req('/api/pair/lookup', { method: 'POST', body: { code: code } });
  if (r.status === 429) { $('confirmMsg').textContent = r.data.error; return; }
  if (!r.data || !r.data.ok) {
    $('confirmMsg').textContent = (r.data && r.data.error) || 'Codice non valido o scaduto';
    return;
  }
  pendingCode = code;
  $('askName').textContent = r.data.nome || 'questo dispositivo';
  show('askBox');
}

$('confirmGo').addEventListener('click', checkCode);
$('confirmCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') checkCode(); });

$('askNo').addEventListener('click', () => {
  hide('askBox');
  pendingCode = '';
  $('confirmMsg').textContent = 'Collegamento annullato: nessun dispositivo e stato abbinato.';
});

$('askYes').addEventListener('click', async () => {
  const code = pendingCode;
  hide('askBox');
  pendingCode = '';
  $('confirmMsg').textContent = 'collego...';
  const r = await req('/api/pair/confirm', { method: 'POST', body: { code: code } });
  if (r.status === 429) { $('confirmMsg').textContent = r.data.error; return; }
  if (r.data && r.data.ok) {
    $('confirmCode').value = '';
    $('confirmMsg').textContent = (r.data.nome || 'Il telefono') + ' e collegato: da ora puoi comandare il PC anche da fuori casa.';
    refresh();
  } else {
    $('confirmMsg').textContent = (r.data && r.data.error) || 'non posso collegare quel codice';
  }
});

function renderDevices(devices, me) {
  const box = $('devList');
  box.innerHTML = '';
  if (!devices.length) { box.textContent = 'Nessun dispositivo abbinato.'; return; }
  devices.forEach((d) => {
    const row = document.createElement('div');
    row.className = 'devrow';
    const txt = document.createElement('div');
    const n = document.createElement('div');
    n.className = 'devname';
    n.textContent = d.nome + (d.id === me ? ' (questo computer)' : '');
    const m = document.createElement('div');
    m.className = 'devmeta';
    m.textContent = (d.email || '') + ' - abbinato ' + new Date(d.created).toLocaleString('it-IT');
    txt.appendChild(n);
    txt.appendChild(m);
    const btn = document.createElement('button');
    btn.className = 'devdel';
    btn.textContent = 'Rimuovi';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '...';
      const r = await req('/api/pair/devices/' + encodeURIComponent(d.id), { method: 'DELETE' });
      if (r.data && r.data.devices) renderDevices(r.data.devices, me);
      else refresh();
    });
    row.appendChild(txt);
    row.appendChild(btn);
    box.appendChild(row);
  });
}

$('newCode').addEventListener('click', async () => {
  const r = await req('/api/pair/code', { method: 'POST' });
  if (r.data && r.data.code) setCode(r.data.code, r.data.expiresAt);
  else $('codeTime').textContent = r.data.error || 'non posso generare il codice';
});

$('pairSelf').addEventListener('click', async () => {
  const r = await req('/api/pair/self', { method: 'POST' });
  $('pairSelfMsg').textContent = r.data && r.data.ok
    ? 'Questo computer e abbinato: puoi usarlo subito dal suo browser.'
    : (r.data.error || 'non posso abbinare');
  refresh();
});

function renderWaiting(list) {
  const box = $('waitList');
  box.innerHTML = '';
  if (!list.length) { box.textContent = 'Nessuna richiesta in attesa.'; return; }
  list.forEach((p) => {
    const row = document.createElement('div');
    row.className = 'devrow';
    const txt = document.createElement('div');
    const n = document.createElement('div');
    n.className = 'devname';
    n.textContent = p.nome + ' chiede di collegarsi';
    const m = document.createElement('div');
    m.className = 'devmeta';
    m.textContent = 'codice ' + p.code + ' - scade fra ' + Math.max(1, Math.round((p.expiresAt - Date.now()) / 60000)) + ' min';
    txt.appendChild(n);
    txt.appendChild(m);
    const btn = document.createElement('button');
    btn.className = 'pcbtn primary';
    btn.style.flex = '0 0 auto';
    btn.style.padding = '9px 12px';
    btn.style.fontSize = '13px';
    btn.textContent = 'Collega';
    btn.addEventListener('click', () => { $('confirmCode').value = p.code; checkCode(); });
    row.appendChild(txt);
    row.appendChild(btn);
    box.appendChild(row);
  });
}

$('backHome').addEventListener('click', (e) => { e.preventDefault(); location.href = '/'; });

refresh();
