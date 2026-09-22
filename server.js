const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const cp = require('child_process');
const actions = require('./lib/actions');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BUTTONS_FILE = path.join(DATA_DIR, 'buttons.json');
const BOOT_FILE = path.join(DATA_DIR, 'boot.json');

const env = loadEnv(path.join(ROOT, '.env'));
const PORT = parseInt(env.PORT || process.env.PORT || '3002', 10);
const HTTPS_PORT = parseInt(env.HTTPS_PORT || process.env.HTTPS_PORT || '443', 10);
const TLS_CERT = env.TLS_CERT || process.env.TLS_CERT || '';
const TLS_KEY = env.TLS_KEY || process.env.TLS_KEY || '';
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

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });

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

function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ ok: false, error: 'Devi accedere' });
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

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.use(express.static(path.join(ROOT, 'public')));
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

app.get('/api/status', (req, res) => {
  res.json({ ok: true, boot: bootInfo(), hasUser: !!req.session.userId });
});

app.get('/api/buttons', requireAuth, (req, res) => {
  const users = loadUsers();
  const u = users.find(x => x.id === req.session.userId);
  const all = readJson(BUTTONS_FILE, {});
  res.json({ ok: true, buttons: (all[req.session.userId] || []).map(b => ({ ...b, owner: u && u.nome })) });
});

app.post('/api/buttons', requireAuth, (req, res) => {
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

app.get('/api/apps', requireAuth, async (req, res) => {
  const r = await actions.dispatch('listApps', {});
  res.json(r);
});

app.get('/api/screenshot', requireAuth, async (req, res) => {
  const r = await actions.dispatch('screenshot', {});
  if (r.ok) return res.json(r);
  res.status(500).json(r);
});

const AUDIO_CAPTURE = path.join(ROOT, 'lib', 'audio', 'capture-loopback.exe');
let audioSpawned = null;

app.get('/api/audio', requireAuth, (req, res) => {
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

app.post('/api/action', requireAuth, async (req, res) => {
  const { action, payload } = req.body || {};
  if (!action) return res.status(400).json({ ok: false, error: 'Azione mancante' });
  const r = await actions.dispatch(action, payload, { blockedTerms: BLOCKED_TERMS });
  console.log(`[action] ${action} -> ok=${r.ok} code=${r.code} ms=${r.durationMs}`);
  if (r.image) return res.json(r);
  res.json({ ok: r.ok, code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut, durationMs: r.durationMs, ...(r.supported !== undefined ? { supported: !!r.supported } : {}) });
});

const AUDIO_PLAY = path.join(ROOT, 'lib', 'audio', 'play-pipe.exe');
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

app.post('/api/audio/talk', requireAuth, express.raw({ type: 'application/octet-stream', limit: '5mb' }), (req, res) => {
  const { error, child } = ensurePlayPipe();
  if (error) return res.status(500).json({ ok: false, error: 'Microfono non disponibile: ' + error });
  if (!child || !req.body || !req.body.length) return res.json({ ok: true });
  child.stdin.write(req.body, () => res.json({ ok: true }));
});

app.post('/api/audio/talk/stop', requireAuth, (req, res) => {
  if (playPipe && playPipe.exitCode === null) {
    try { playPipe.stdin.end(); } catch (e) { }
    playPipe = null;
  }
  res.json({ ok: true });
});

app.post('/api/terminal', requireAuth, async (req, res) => {
  const r = await actions.dispatch('term', req.body || {}, { blockedTerms: BLOCKED_TERMS });
  res.json(r);
});

app.get('/', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
app.get('/remote', (req, res) => res.sendFile(path.join(ROOT, 'public', 'remote.html')));

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
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'sconosciuto';
}