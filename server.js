const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const net = require('net');
const dns = require('dns');
const cp = require('child_process');
const actions = require('./lib/actions');
const pair = require('./lib/pair');

const config = require('./lib/config');

const ROOT = __dirname;
const DATA_DIR = config.DATA_DIR;
const CACHE_DIR = config.CACHE_DIR;
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BUTTONS_FILE = path.join(DATA_DIR, 'buttons.json');
const BOOT_FILE = path.join(DATA_DIR, 'boot.json');
const DEVICE_FILE = path.join(DATA_DIR, 'device.json');
const PUBLIC_URL_FILE = path.join(DATA_DIR, 'public-url.txt');

const env = loadEnv(config.ENV_FILE);
const PORT = parseInt(process.env.PORT || env.PORT || '3002', 10);
const HTTPS_PORT = parseInt(env.HTTPS_PORT || process.env.HTTPS_PORT || '443', 10);
// Il certificato si puo' indicare nel .env, oppure mettere i file .crt e .key
// nella cartella certs: vengono scelti da soli, preferendo quello che
// corrisponde all'indirizzo pubblico (se in cartella ce n'e' piu' di uno).
const TLS = (env.TLS_CERT || process.env.TLS_CERT)
  ? { cert: env.TLS_CERT || process.env.TLS_CERT, key: env.TLS_KEY || process.env.TLS_KEY }
  : findCertPair();
const TLS_CERT = TLS.cert;
const TLS_KEY = TLS.key;
const SESSION_SECRET = env.SESSION_SECRET || process.env.SESSION_SECRET || 'nexaremote-segretissimo';
const BLOCKED_TERMS = String(env.BLOCKED_TERMS || process.env.BLOCKED_TERMS || '').split(',').map(s => s.trim()).filter(Boolean);

function loadEnv(file) {
  const out = {};
  try {
    const content = fs.readFileSync(file, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { }
  return out;
}

// Nome host dell'indirizzo pubblico (usato per scegliere il certificato giusto).
function publicUrlHost() {
  let u = String(env.PUBLIC_URL || process.env.PUBLIC_URL || '');
  if (!u) { try { u = fs.readFileSync(PUBLIC_URL_FILE, 'utf8').trim(); } catch (e) { u = ''; } }
  return u.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim().toLowerCase();
}

// Cerca in <home>\certs una coppia .crt + .key; se l'indirizzo pubblico e'
// noto, preferisce il certificato che gli corrisponde.
function findCertPair() {
  try {
    const files = fs.readdirSync(config.CERT_DIR);
    const crts = files.filter((n) => n.toLowerCase().endsWith('.crt'));
    const host = publicUrlHost();
    const base = (n) => n.slice(0, -4).toLowerCase();
    const buoni = crts.filter((f) => base(f) === host);
    const altri = crts.filter((f) => base(f) !== host);
    for (const f of buoni.concat(altri)) {
      const k = f.slice(0, -4) + '.key';
      if (files.indexOf(k) >= 0) {
        return { cert: path.join(config.CERT_DIR, f), key: path.join(config.CERT_DIR, k) };
      }
    }
  } catch (e) { }
  return { cert: '', key: '' };
}

config.ensureDirs();

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function loadUsers() { return readJson(USERS_FILE, []); }
function saveUsers(users) { writeJson(USERS_FILE, users); }

fs.writeFileSync(BOOT_FILE, JSON.stringify({ bootAt: new Date().toISOString() }));

function bootInfo() {
  const b = readJson(BOOT_FILE, { bootAt: new Date().toISOString() });
  b.uptimeSeconds = Math.round((Date.now() - new Date(b.bootAt).getTime()) / 1000);
  b.hostname = os.hostname();
  b.platform = os.platform();
  b.totalMemGb = Math.round(os.totalmem() / 1073741824);
  b.port = PORT;
  return b;
}

function findUser(users, email) {
  return users.find(u => u.email.toLowerCase() === String(email || '').toLowerCase());
}

// Nome del PC e indirizzo pubblico: si possono cambiare senza toccare il codice,
// scrivendo data\device.json ({"name":"PC di Lorenzo"}) o data\public-url.txt.
function deviceInfo() {
  const cfg = readJson(DEVICE_FILE, {});
  let publicUrl = String((env.PUBLIC_URL || process.env.PUBLIC_URL) || '').trim();
  if (!publicUrl) {
    try { publicUrl = fs.readFileSync(PUBLIC_URL_FILE, 'utf8').trim(); } catch (e) { publicUrl = ''; }
  }
  publicUrl = publicUrl.replace(/\/+$/, '');
  const name = String((cfg.name || env.DEVICE_NAME || process.env.DEVICE_NAME) || '').trim() || os.hostname();
  return {
    name,
    host: os.hostname(),
    os: os.platform(),
    lan: getLanIp(),
    lanAll: getLanIps(),
    port: PORT,
    publicUrl,
    hasTls: !!(TLS_CERT && TLS_KEY)
  };
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ ok: false, error: 'Devi accedere' });
}

// Il dispositivo del browser (salvato in localStorage) con cui si usa l'app.
function deviceIdOf(req) {
  return String(req.get('x-nexa-device') || (req.body && req.body.deviceId) || '').trim();
}

// Oltre all'accesso serve il dispositivo abbinato col codice del PC.
// I dispositivi gia abbinati restano abbinati per sempre.
function requirePaired(req, res, next) {
  if (!req.session || !req.session.userId) return res.status(401).json({ ok: false, error: 'Devi accedere' });
  ensureOwner();
  const owner = pair.owner();
  if (owner) {
    const u = currentUser(req);
    if (!u || u.email.toLowerCase() !== owner.toLowerCase()) {
      return res.status(403).json({ ok: false, notOwner: true, error: 'Questo PC e gia connesso a un account' });
    }
  }
  const id = deviceIdOf(req);
  if (id && pair.isTrusted(id)) { pair.touch(id); return next(); }
  return res.status(403).json({ ok: false, pairRequired: true, error: 'Inserisci il codice del PC' });
}

// Il proprietario del PC e' il primo account creato su questo PC.
function currentUser(req) {
  if (!req.session || !req.session.userId) return null;
  const users = loadUsers();
  return users.find(x => x.id === req.session.userId) || null;
}

// Il proprietario del PC e' il primo account creato su questo PC.
// Se il file non esiste (owner mai deciso) si sceglie l'account piu vecchio
// presente. Se invece e' deciso che non c'e' ancora un proprietario (stringa
// vuota) si aspetta: lo diventa il prossimo account che si registra.
function ensureOwner() {
  if (pair.owner() !== null) return;
  const users = loadUsers();
  if (!users.length) return;
  const first = users.slice().sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')))[0];
  if (first && first.email) pair.setOwner(first.email);
}

function isOwner(req) {
  ensureOwner();
  const u = currentUser(req);
  if (!u) return false;
  const owner = pair.owner();
  return !!owner && owner.toLowerCase() === u.email.toLowerCase();
}

const throttleMap = new Map();
function throttleCheck(key) {
  const now = Date.now();
  const t = throttleMap.get(key);
  if (!t || t.resetAt < now) {
    throttleMap.set(key, { count: 0, resetAt: now + 15 * 60 * 1000 });
    return { ok: true, entry: throttleMap.get(key) };
  }
  return { ok: t.count < 5, entry: t };
}

// indirizzo di chi sta facendo la richiesta (dietro Tailscale arriva 127.0.0.1)
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '');
  if (fwd) return fwd.split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'sconosciuto';
}

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(config.PUBLIC_DIR));
app.use('/cache', requireAuth, express.static(CACHE_DIR));

app.get('/api/session', (req, res) => {
  if (!req.session.userId) return res.json({ ok: true, user: null });
  const users = loadUsers();
  const u = users.find(x => x.id === req.session.userId);
  if (!u) return res.json({ ok: true, user: null });
  res.json({ ok: true, user: { id: u.id, nome: u.nome, email: u.email, os: u.os || 'windows' } });
});

app.post('/api/register', (req, res) => {
  const { nome, email, password, os } = req.body || {};
  if (!nome || !email || !password) return res.status(400).json({ ok: false, error: 'Nome, email e password obbligatori' });
  if (String(password).length < 4) return res.status(400).json({ ok: false, error: 'Password troppo corta (minimo 4 caratteri)' });
  const users = loadUsers();
  if (findUser(users, email)) return res.status(400).json({ ok: false, error: 'Email gia registrata' });
  const userOs = String(os || '').toLowerCase() === 'mac' ? 'mac' : 'windows';
  const user = { id: crypto.randomUUID(), nome, email, os: userOs, password: bcrypt.hashSync(password, 10), created: new Date().toISOString() };
  users.push(user);
  saveUsers(users);
  pair.setOwner(user.email); // il primo account creato diventa proprietario del PC
  req.session.userId = user.id;
  res.json({ ok: true, user: { id: user.id, nome: user.nome, email: user.email, os: userOs } });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const key = String(email || '').toLowerCase() + '|' + (req.ip || req.connection.remoteAddress);
  const chk = throttleCheck(key);
  if (!chk.ok) return res.status(429).json({ ok: false, error: 'Troppi tentativi. Attendi 15 minuti per riprovare.' });
  const users = loadUsers();
  const u = findUser(users, email);
  if (!u || !bcrypt.compareSync(String(password || ''), u.password)) {
    chk.entry.count++;
    return res.status(401).json({ ok: false, error: 'Email o password errati' });
  }
  throttleMap.delete(key);
  pair.setOwner(u.email); // se non c'e' ancora un proprietario, chi accede per primo lo diventa
  req.session.userId = u.id;
  res.json({ ok: true, user: { id: u.id, nome: u.nome, email: u.email, os: u.os || 'windows' } });
});

app.post('/api/logout', (req, res) => {
  const sid = req.sessionID;
  req.session.destroy(() => {
    res.clearCookie('connect.sid', { path: '/' });
    res.json({ ok: true });
  });
});

// --- Abbinamento col codice del PC ---
// 1) sul PC (pagina /pc) il proprietario vede un codice di 6 cifre
// 2) sul telefono lo si inserisce e il dispositivo diventa autorizzato
const pairUser = (req) => {
  const u = currentUser(req);
  return { nome: (u && u.nome) || 'Dispositivo', email: (u && u.email) || '' };
};

// --- Collegamento col codice che nasce sul telefono ---
// 1) il telefono chiede e riceve un codice di 6 cifre
app.post('/api/pair/request', (req, res) => {
  const id = deviceIdOf(req);
  if (!id) return res.status(400).json({ ok: false, error: 'Dispositivo non riconosciuto' });
  const nome = String((req.body || {}).nome || '').slice(0, 40);
  const r = pair.requestCode(id, nome);
  res.json({ ok: true, code: r.code, expiresAt: r.expiresAt });
});

// il telefono controlla se il PC ha confermato
app.get('/api/pair/pending', (req, res) => {
  const id = String(req.query.device || '').trim();
  const confirmed = !!id && pair.isTrusted(id);
  res.json({ ok: true, confirmed });
});

// Fino a 12 tentativi ogni 15 minuti: evita di indovinare i codici alla cieca
const pairTries = new Map();
function pairRateOk(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const t = (pairTries.get(ip) || []).filter(x => now - x < 15 * 60 * 1000);
  if (t.length >= 12) { pairTries.set(ip, t); return false; }
  t.push(now);
  pairTries.set(ip, t);
  return true;
}

// 2) sul PC si scrive il codice: il server risponde dicendo QUALE dispositivo
//    chiede il collegamento, ma non collega ancora niente.
app.post('/api/pair/lookup', (req, res) => {
  if (!pairRateOk(req)) return res.status(429).json({ ok: false, error: 'Troppi tentativi: aspetta qualche minuto e riprova.' });
  const p = pair.findPending((req.body || {}).code);
  if (!p) return res.status(400).json({ ok: false, error: 'Codice non valido o scaduto' });
  res.json({ ok: true, nome: p.nome });
});

// 3) l'utente sul PC preme "Conferma": adesso il telefono diventa autorizzato
app.post('/api/pair/confirm', (req, res) => {
  if (!pairRateOk(req)) return res.status(429).json({ ok: false, error: 'Troppi tentativi: aspetta qualche minuto e riprova.' });
  const dev = pair.confirmCode((req.body || {}).code);
  if (!dev) return res.status(400).json({ ok: false, error: 'Nessun telefono sta aspettando quel codice (o e scaduto)' });
  res.json({ ok: true, nome: dev.nome });
});

app.get('/api/pair/devices', requireAuth, (req, res) => {
  const owner = isOwner(req);
  res.json({
    ok: true,
    isOwner: owner,
    hasOwner: !!pair.owner(),
    me: deviceIdOf(req),
    trusted: pair.isTrusted(deviceIdOf(req)),
    devices: owner ? pair.list() : [],
    pending: owner ? pair.pendingList() : [],
    code: owner ? pair.getCode() : null,
    publicUrl: deviceInfo().publicUrl,
    lan: getLanIp()
  });
});

app.post('/api/pair/code', requireAuth, (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ ok: false, error: 'Solo il proprietario del PC puo generare il codice' });
  res.json({ ok: true, ...pair.newCode() });
});

app.post('/api/pair', requireAuth, (req, res) => {
  ensureOwner();
  const owner = pair.owner();
  if (owner) {
    const u = currentUser(req);
    if (!u || u.email.toLowerCase() !== owner.toLowerCase()) {
      return res.status(403).json({ ok: false, notOwner: true, error: 'Questo PC e gia connesso a un account' });
    }
  }
  const code = (req.body || {}).code;
  if (!pair.checkCode(code)) return res.status(400).json({ ok: false, error: 'Codice non valido o scaduto' });
  const id = deviceIdOf(req) || String((req.body || {}).deviceId || '').trim();
  if (!id) return res.status(400).json({ ok: false, error: 'Dispositivo non riconosciuto: ricarica la pagina' });
  const dev = pair.trust(id, pairUser(req));
  res.json({ ok: true, device: dev, deviceId: id });
});

// Abina il computer da cui stai guardando la pagina /pc (solo proprietario:
// e' il suo PC, quindi non serve digitare nulla).
app.post('/api/pair/self', requireAuth, (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ ok: false, error: 'Solo il proprietario del PC puo fare questo' });
  const id = deviceIdOf(req);
  if (!id) return res.status(400).json({ ok: false, error: 'Dispositivo non riconosciuto' });
  res.json({ ok: true, device: pair.trust(id, pairUser(req)), deviceId: id });
});

app.delete('/api/pair/devices/:id', requireAuth, (req, res) => {
  if (!isOwner(req)) return res.status(403).json({ ok: false, error: 'Solo il proprietario puo rimuovere dispositivi' });
  const ok = pair.revoke(String(req.params.id || ''));
  res.json({ ok, devices: pair.list() });
});

app.get('/api/status', (req, res) => {
  res.json({ ok: true, boot: bootInfo(), device: deviceInfo(), hasUser: !!req.session.userId });
});

app.get('/api/buttons', requirePaired, (req, res) => {
  const users = loadUsers();
  const u = users.find(x => x.id === req.session.userId);
  const all = readJson(BUTTONS_FILE, {});
  res.json({ ok: true, buttons: (all[req.session.userId] || []).map(b => ({ ...b, owner: u && u.nome })) });
});

app.post('/api/buttons', requirePaired, (req, res) => {
  const list = Array.isArray(req.body && req.body.buttons) ? req.body.buttons : [];
  const clean = list.slice(0, 20).map(b => ({
    name: String(b.name || '').slice(0, 30),
    target: String(b.target || '').slice(0, 128)
  })).filter(b => b.name && b.target);
  const all = readJson(BUTTONS_FILE, {});
  all[req.session.userId] = clean;
  writeJson(BUTTONS_FILE, all);
  res.json({ ok: true, buttons: clean });
});

app.get('/api/apps', requirePaired, async (req, res) => {
  const r = await actions.dispatch('listApps', {});
  res.json(r);
});

app.get('/api/screenshot', requirePaired, async (req, res) => {
  const r = await actions.dispatch('screenshot', {});
  if (r.ok) return res.json(r);
  res.status(500).json(r);
});

const AUDIO_CAPTURE = path.join(config.AUDIO_DIR, 'capture-loopback.exe');
let audioSpawned = null;

app.get('/api/audio', requirePaired, (req, res) => {
  try { if (!fs.existsSync(AUDIO_CAPTURE)) throw new Error('helper mancante'); }
  catch (e) { return res.status(500).json({ ok: false, error: 'Audio non disponibile: ' + e.message }); }
  res.writeHead(200, {
    'Content-Type': 'audio/wav',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'X-Accel-Buffering': 'no'
  });
  if (audioSpawned && audioSpawned.exitCode === null) { try { audioSpawned.kill(); } catch (e) { } }
  const child = cp.spawn(AUDIO_CAPTURE, [], { stdio: ['ignore', 'pipe', 'ignore'] });
  audioSpawned = child;
  let killed = false;
  const killChild = () => { if (!killed && child.exitCode === null) { killed = true; try { child.kill(); } catch (e) { } } };
  child.stdout.on('data', (d) => { if (!res.writableEnded) res.write(d); });
  child.on('error', () => killChild());
  child.on('exit', () => { if (!res.writableEnded) res.end(); });
  req.on('close', killChild);
  res.on('close', killChild);
});

app.post('/api/action', requirePaired, async (req, res) => {
  const { action, payload } = req.body || {};
  if (!action) return res.status(400).json({ ok: false, error: 'Azione mancante' });
  const r = await actions.dispatch(action, payload, { blockedTerms: BLOCKED_TERMS });
  console.log(`[action] ${action} -> ok=${r.ok} code=${r.code} ms=${r.durationMs}`);
  if (r.image) return res.json(r);
  res.json({ ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, durationMs: r.durationMs, ...(r.supported !== undefined ? { supported: !!r.supported } : {}) });
});

const AUDIO_PLAY = path.join(config.AUDIO_DIR, 'play-pipe.exe');
let playPipe = null;

function ensurePlayPipe() {
  try { if (!fs.existsSync(AUDIO_PLAY)) throw new Error('helper mancante'); } catch (e) { return { error: e.message }; }
  if (playPipe && playPipe.exitCode === null) return { child: playPipe };
  const child = cp.spawn(AUDIO_PLAY, [], { stdio: ['pipe', 'ignore', 'ignore'] });
  playPipe = child;
  child.stdin.on('error', () => { });
  child.on('exit', () => { if (playPipe === child) playPipe = null; });
  return { child };
}

app.post('/api/audio/talk', requirePaired, express.raw({ type: 'application/octet-stream', limit: '5mb' }), (req, res) => {
  const { error, child } = ensurePlayPipe();
  if (error) return res.status(500).json({ ok: false, error: 'Microfono non disponibile: ' + error });
  if (!child || !req.body || !req.body.length) return res.json({ ok: true });
  child.stdin.write(req.body, () => res.json({ ok: true }));
});

app.post('/api/audio/talk/stop', requirePaired, (req, res) => {
  if (playPipe && playPipe.exitCode === null) {
    try { playPipe.stdin.end(); } catch (e) { }
    playPipe = null;
  }
  res.json({ ok: true });
});

app.post('/api/terminal', requirePaired, async (req, res) => {
  const r = await actions.dispatch('term', req.body || {}, { blockedTerms: BLOCKED_TERMS });
  res.json(r);
});

app.get('/', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'index.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'remote.html')));
app.get('/pc', (req, res) => res.sendFile(path.join(config.PUBLIC_DIR, 'pc.html')));

app.use((req, res) => res.status(404).json({ ok: false, error: 'Non trovato' }));

app.listen(PORT, '0.0.0.0', () => {
  console.log('NexaRemote avviato su http://0.0.0.0:' + PORT);
  console.log('Host: ' + os.hostname() + ' - IP LAN: ' + getLanIp());
  console.log('Terminale: comandi bloccati: ' + (BLOCKED_TERMS.length ? BLOCKED_TERMS.join(', ') : 'nessuno'));
});

function startTls() {
  if (!TLS_CERT || !TLS_KEY) return;
  let cert, key;
  try {
    cert = fs.readFileSync(TLS_CERT);
    key = fs.readFileSync(TLS_KEY);
  } catch (e) {
    console.log('TLS configurato ma file non leggibili, HTTPS saltato (' + e.message + ')');
    return;
  }
  try {
    const server = https.createServer({ cert, key }, app);
    server.listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log('NexaRemote TLS attivo su https://0.0.0.0:' + HTTPS_PORT);
    });
    server.on('error', (err) => console.log('HTTPS non avviato: ' + err.message));
  } catch (e) {
    console.log('HTTPS non avviato: ' + e.message);
  }
}
startTls();

function getLanIp() {
  const list = getLanIps();
  return list[0] || 'sconosciuto';
}

// Tutti gli indirizzi IP "di casa": serve al telefono per capire quale rete
// scansionare. Si escludono Tailscale, le schede virtuali e i link locali.
function getLanIps() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (/tailscale|\btun\b|tunnel|loopback|teredo|vmware|vethernet|wsl|bluetooth|npcap/i.test(name)) continue;
    for (const i of ifaces[name] || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (i.address.startsWith('169.254.')) continue;
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(i.address)) continue;
      if (out.indexOf(i.address) === -1) out.push(i.address);
    }
  }
  return out;
}