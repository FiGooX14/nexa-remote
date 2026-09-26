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

// --- Ricerca del PC sulla rete (usata dal telefono) ---
// Risponde anche alle richieste che arrivano da un'altra pagina e alle richieste
// di controllo che fa Chrome prima di permettere di parlare con un indirizzo
// privato (senza questo la ricerca sulla Wi-Fi verrebbe bloccata dal browser).
function discoveryHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '600');
  res.setHeader('Cache-Control', 'no-store');
}

app.options('/api/discover', (req, res) => {
  discoveryHeaders(res);
  res.status(204).end();
});

app.options('/api/discover/scan', (req, res) => {
  discoveryHeaders(res);
  res.status(204).end();
});

// --- Ricerca dei PC fatta dal SERVER (non dal telefono) ---
// Serve quando il telefono e connesso con l'indirizzo pubblico HTTPS: il browser
// non puo parlare con la rete di casa, ma questo PC e dentro la rete e puo
// cercare lui. Risultato memorizzato 15 secondi e una ricerca ogni 10 secondi
// per telefono, cosi nessuno puo farlo girare in continuazione.
const scanCache = { at: 0, list: [] };
const scanWait = new Map();
let scanRunning = null;

function selfBases() {
  const d = deviceInfo();
  const port = d.port || 3002;
  const ips = (d.lanAll && d.lanAll.length) ? d.lanAll : (d.lan ? [d.lan] : []);
  return ips.map((ip) => 'http://' + ip + ':' + port);
}

function probeNexa(base, timeoutMs) {
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => { try { ctrl.abort(); } catch (e) {} resolve(null); }, timeoutMs);
    fetch(base + '/api/discover', { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        clearTimeout(t);
        if (j && j.app === 'NexaRemote') {
          resolve({ name: j.name || 'PC', base: base, host: j.host || '', os: j.os || '', lan: base.split('//')[1].split(':')[0], port: j.port || 3002 });
        } else resolve(null);
      })
      .catch(() => { clearTimeout(t); resolve(null); });
  });
}

async function scanNetwork() {
  if (scanRunning) return scanRunning;
  scanRunning = (async () => {
    const d = deviceInfo();
    const mine = new Set(selfBases());
    const lan = d.lan || ((d.lanAll && d.lanAll[0]) || '');
    const net = lan && lan.includes('.') ? lan.split('.').slice(0, 3).join('.') : '192.168.0';
    const hosts = [];
    for (let h = 1; h <= 254; h++) hosts.push(net + '.' + h);
    const found = [];
    const seen = new Set(mine);
    let i = 0;
    const worker = async () => {
      while (i < hosts.length) {
        const host = hosts[i++];
        if (mine.has('http://' + host + ':' + (d.port || 3002))) continue;
        const dev = await probeNexa('http://' + host + ':' + (d.port || 3002), 400);
        if (dev && !seen.has(dev.base)) { seen.add(dev.base); found.push(dev); }
      }
    };
    await Promise.all(Array.from({ length: 40 }, worker));
    // questo computer per primo, con il segno "e quello che sta servendo"
    const self = Array.from(mine).map((b) => ({
      name: d.name || 'PC', base: b, host: d.host || '', os: d.os || '',
      lan: b.split('//')[1].split(':')[0], port: d.port || 3002, isSelf: true
    }));
    const list = self.concat(found);
    scanCache.list = list;
    scanCache.at = Date.now();
    return list;
  })();
  try { return await scanRunning; } finally { scanRunning = null; }
}

app.get('/api/discover/scan', async (req, res) => {
  discoveryHeaders(res);
  const ip = clientIp(req);
  const now = Date.now();
  const last = scanWait.get(ip) || 0;
  if (now - last < 10000 && scanCache.list.length) {
    return res.json({ ok: true, cached: true, found: scanCache.list, devices: scanCache.devices || [] });
  }
  if (now - last < 10000) {
    return res.status(429).json({ ok: false, error: 'Attendi qualche secondo e riprova la ricerca' });
  }
  scanWait.set(ip, now);
  try {
    const list = await scanNetwork();
    res.json({ ok: true, found: list, devices: scanCache.devices || [] });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'ricerca non riuscita' });
  }
});

// --- Elenco TUTTI i dispositivi della rete (non solo quelli con NexaRemote) ---
// Il PC e dentro la rete di casa: fa un ping veloce a tutti gli indirizzi,
// legge la tabella degli indirizzi fisici (arp), poi guarda quali porte sono
// aperte per capire cos'e ogni dispositivo (computer, stampante, router, TV).
const netCache = { at: 0, list: [] };
const netNames = new Map(); // ip -> nome, per non rileggerlo ogni volta

const exec = (cmd, args, ms) => new Promise((res) => {
  const p = cp.spawn(cmd, args, { windowsHide: true });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.on('error', () => res(''));
  p.on('close', () => res(out));
  setTimeout(() => { try { p.kill(); } catch (e) {} res(out); }, ms || 4000);
});

function netBase() {
  const d = deviceInfo();
  const lan = d.lan || ((d.lanAll && d.lanAll[0]) || '');
  if (!lan || !lan.includes('.')) return { net: '192.168.0', lan: lan, port: d.port || 3002 };
  const p = lan.split('.');
  return { net: p.slice(0, 3).join('.'), lan: lan, port: d.port || 3002 };
}

async function pingAll(net) {
  const isMac = process.platform === 'darwin';
  const hosts = [];
  for (let h = 1; h <= 254; h++) hosts.push(net + '.' + h);
  let i = 0;
  const worker = async () => {
    while (i < hosts.length) {
      const ip = hosts[i++];
      await exec('ping', isMac ? ['-c', '1', '-W', '400', ip] : ['-n', '1', '-w', '300', ip], 700);
    }
  };
  await Promise.all(Array.from({ length: 48 }, worker));
}

async function readArp() {
  const out = await exec('arp', ['-a'], 5000);
  const found = new Map();
  out.split(/\r?\n/).forEach((line) => {
    const m = line.match(/(\d{1,3}(?:\.\d{1,3}){3}).*?([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i);
    if (!m) return;
    const ip = m[1];
    const mac = m[2].toLowerCase();
    if (ip.endsWith('.255') || mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') return;
    if (!found.has(ip)) found.set(ip, mac);
  });
  return found;
}

function tcpOpen(ip, port, ms) {
  return new Promise((res) => {
    const s = net.connect({ host: ip, port: port });
    let done = false;
    let t = null;
    const end = (v) => { if (done) return; done = true; if (t) clearTimeout(t); try { s.destroy(); } catch (e) {} res(v); };
    t = setTimeout(() => end(false), ms || 500); // scade sempre, anche se la porta e "muta"
    s.on('connect', () => end(true));
    s.on('error', () => end(false));
  });
}

// Produttori dei principali prefissi di indirizzo fisico (serve per dare un
// nome leggibile ai dispositivi: "Samsung", "Apple", "TP-Link"...).
const OUI = {
  '00-1b-63': 'Apple', '3c-15-c2': 'Apple', 'ac-bc-32': 'Apple', 'f0-18-98': 'Apple',
  'd8-3a-dd': 'Apple', '04-0c-ce': 'Apple', '6c-40-73': 'Apple', '8c-85-90': 'Apple',
  '90-b2-1f': 'Apple', 'a4-83-e7': 'Apple', '00-a4-10': 'Apple', 'a0-07-4f': 'Apple',
  '3c-22-fb': 'Apple', 'f0-18-6e': 'Apple', '00-25-00': 'Apple',
  '00-16-32': 'Samsung', '78-47-1d': 'Samsung', '5c-0a-5b': 'Samsung', '34-be-00': 'Samsung',
  '8c-79-f5': 'Samsung', 'ec-21-9e': 'Samsung', 'e8-50-8b': 'Samsung', '00-1e-75': 'Samsung',
  '00-26-b2': 'Samsung', '78-1f-db': 'Samsung', 'cc-2d-8c': 'Samsung',
  '00-1c-42': 'Intel', '3c-97-0e': 'Intel', '8c-16-45': 'Intel', '94-65-2d': 'Intel',
  'a4-ce-6e': 'Intel', '00-1b-21': 'Intel', '58-94-8c': 'Intel',
  '00-e0-4c': 'Realtek', '00-1f-3b': 'Realtek', '52-54-00': 'PC virtuale',
  '00-24-9b': 'Realtek', 'b8-c9-e4': 'Realtek',
  '50-c7-bf': 'TP-Link', '1c-61-b4': 'TP-Link', 'c0-25-e9': 'TP-Link', '30-b5-c2': 'TP-Link',
  'ec-08-6b': 'TP-Link', 'a4-2b-b0': 'TP-Link', '5c-a6-e6': 'TP-Link',
  '48-db-50': 'Huawei', '04-cf-8c': 'Huawei', '8c-85-80': 'Huawei', '70-72-3c': 'Huawei',
  '48-7c-2c': 'Huawei', 'e0-24-7f': 'Huawei',
  '64-b4-73': 'Xiaomi', '64-09-80': 'Xiaomi', '78-11-dc': 'Xiaomi', '8c-de-52': 'Xiaomi',
  'f4-f5-e8': 'Xiaomi', '54-ef-44': 'Xiaomi', '74-23-44': 'Xiaomi',
  '68-54-fd': 'Amazon', '44-65-0d': 'Amazon', 'fc-65-de': 'Amazon', '24-4b-fe': 'Amazon',
  '3c-5a-b4': 'Google', 'f4-f5-a5': 'Google', '20-bb-ed': 'Google', 'f4-f0-6f': 'Google',
  'b8-27-eb': 'Raspberry Pi', 'dc-a6-32': 'Raspberry Pi', 'e4-5f-01': 'Raspberry Pi',
  '24-0a-c4': 'Espressif (telecamera/smart)', '30-ae-a4': 'Espressif (telecamera/smart)',
  '8c-aa-b5': 'Espressif (telecamera/smart)', '7c-9e-bd': 'Espressif (telecamera/smart)',
  '00-14-6c': 'Netgear', 'a0-40-a0': 'Netgear', '9c-3d-cf': 'Netgear', '4c-60-de': 'Netgear',
  '24-a4-3c': 'Ubiquiti', '78-8a-20': 'Ubiquiti', '44-d9-e7': 'Ubiquiti', 'f0-9f-c2': 'Ubiquiti',
  '2c-56-dc': 'Asus', '40-16-6e': 'Asus', '04-d4-c4': 'Asus', '1c-87-2c': 'Asus',
  '3c-d9-2b': 'HP', '94-7e-dd': 'HP', '9c-b6-54': 'HP', '00-1b-78': 'HP',
  '00-1b-a9': 'Brother', '00-80-77': 'Brother', '30-05-5c': 'Brother',
  '00-1b-63x': '', '00-00-6e': 'SMC', '00-0c-29': 'VMware', '00-50-56': 'VMware',
  '00-15-5d': 'Hyper-V', '00-1c-42x': '', '00-04-4b': 'Hewlett Packard',
  '00-1e-0b': 'Hewlett Packard', '00-80-63': 'Hewlett Packard',
  '00-00-77': 'Samsung vecchio', '00-16-6c': 'Samsung vecchio', '00-07-f9': 'Intel vecchio',
  '00-13-10': 'Sony', '00-04-1f': 'Sony', 'b8-27-78': 'Sony', '00-1e-6a': 'Sony',
  '00-07-ab': 'Panasonic', '00-17-88': 'Philips', '90-68-c3': 'Philips', '84-30-9b': 'Philips',
  '00-0e-58': 'Sony', 'f0-4e-xd': '', '00-1f-3b-2': '',
  'b0-be-76': 'TP-Link', 'e4-8d-8c': 'Router vari', '00-04-f2': 'Router (Vodafone/FASTWEB)',
  '90-af-29': 'Vodafone', 'e8-40-25': 'Vodafone', '4c-72-75': 'Vodafone',
  'b0-2a-46': 'Vodafone', 'c0-25-06': 'Vodafone', '00-17-9a': 'Router TIM', '90:f2:aa': 'Router TIM',
  '00-f4-9f': 'Aruba', '94:b4-0f': 'Aruba', 'f0:15:79': 'Aruba',
  '00-1c-35': 'Tenda', '00-26-1e': 'Tenda', 'c0-4c-02': 'D-Link', '1c-af-f7': 'D-Link',
  '00-13-10x': '', '00-18-e8': 'D-Link', '00-24-01': 'D-Link',
  '00-1f-3b-x': '', '00-0c-42': 'Router', '20-1c-44': 'Router', '1c-15-4e': 'Router',
  'e8-3f-b2': 'Router', '00-26-5a': 'D-Link vecchio', 'c0-8f-1c': 'Zyxel',
  '00-04-f2-x': '', '00:04:f2': '', 'c0:25:6c': 'Zyxel', '00-18:9d': 'Zyxel'
};

// Nome del produttore dal MAC. Se il MAC e "privato" (secondo bit attivo)
// vuol dire che il dispositivo usa un indirizzo casuale per privacy: e un
// segnale che oggi e un telefono/PC moderno, quindi lo diciamo.
function macVendor(mac) {
  if (!mac) return '';
  const p = String(mac).replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (p.length < 6) return '';
  if (parseInt(p.slice(0, 2), 16) & 0x02) return 'indirizzo privato (telefono o PC)';
  for (let n = 6; n >= 2; n -= 2) {
    const k = (p.slice(0, n).match(/../g) || []).join('-').toLowerCase();
    if (OUI[k]) return OUI[k];
  }
  return '';
}

async function reverseName(ip) {
  if (netNames.has(ip)) return netNames.get(ip);
  let name = '';
  try {
    const r = await dns.promises.reverse(ip);
    if (r && r[0]) name = r[0].replace(/\.$/, '');
  } catch (e) {}
  if (name && /^([0-9a-f]{1,4}\.){3}[0-9a-f]{1,4}$/i.test(name)) name = ''; // IP come nome: non serve
  netNames.set(ip, name);
  if (netNames.size > 300) netNames.clear();
  return name;
}

async function scanWholeNet() {
  const { net, lan, port } = netBase();
  await pingAll(net);
  const arp = await readArp();
  const gateway = process.platform === 'darwin' ? '' : (await exec('powershell', ['-NoProfile', '-Command', '(Get-NetRoute -DestinationPrefix \'0.0.0.0/0\' -ErrorAction SilentlyContinue | Select-Object -First 1).NextHop'], 4000)).trim().split(/\r?\n/).pop();
  const ips = Array.from(arp.keys()).filter((ip) => ip.startsWith(net + '.'));
  const out = [];
  // questo computer non e nella tabella degli indirizzi (Windows non lo mette):
  // aggiungiamolo a mano, con il nome vero e il segno "collegato"
  const d0 = deviceInfo();
  for (const b of selfBases()) {
    out.push({
      ip: lan, mac: '', name: d0.name || 'PC', tipo: 'computer con NexaRemote (questo)',
      isNexa: true, isSelf: true, base: b, lan: lan, port: port, host: d0.host || '', os: d0.os || ''
    });
  }
  let k = 0;
  const worker = async () => {
    while (k < ips.length) {
      const ip = ips[k++];
      const mac = arp.get(ip);
      const base = 'http://' + ip + ':' + port;
      const nexa = await probeNexa(base, 450);
      const ports = await Promise.all([445, 3389, 9100, 631, 80, 443].map((p) => tcpOpen(ip, p, 450)));
      const [smb, rdp, print9100, print631, http, https] = ports;
      let tipo = 'dispositivo';
      if (nexa) tipo = 'PC con NexaRemote';
      else if (smb || rdp) tipo = 'computer';
      else if (print9100 || print631) tipo = 'stampante o telecamera';
      else if (http || https) tipo = 'TV, telecamera o router';
      if (ip === gateway) tipo = 'router (internet)';
      const name = (nexa && nexa.name) || (await reverseName(ip)) || '';
      out.push({
        ip: ip, mac: mac, name: name, tipo: tipo, vendor: macVendor(mac),
        isNexa: !!nexa, isSelf: nexa ? nexa.base === ('http://' + lan + ':' + port) : false,
        base: nexa ? nexa.base : base, lan: ip, port: port,
        host: (nexa && nexa.host) || '', os: (nexa && nexa.os) || ''
      });
    }
  };
  await Promise.all(Array.from({ length: 12 }, worker));
  out.sort((a, b) => (b.isNexa - a.isNexa) || (a.ip.localeCompare(b.ip, undefined, { numeric: true })));
  netCache.list = out;
  netCache.at = Date.now();
  return out;
}

app.get('/api/discover/devices', async (req, res) => {
  discoveryHeaders(res);
  const ip = clientIp(req);
  const now = Date.now();
  if (now - netCache.at < 20000 && netCache.list.length) {
    return res.json({ ok: true, cached: true, devices: netCache.list });
  }
  if (now - netCache.at < 6000) {
    return res.status(429).json({ ok: false, error: 'Ricerca in corso, riprova tra un momento' });
  }
  try {
    const list = await scanWholeNet();
    res.json({ ok: true, devices: list });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'elenco non riuscito' });
  }
});


// Il telefono e sulla stessa Wi-Fi del PC? Serve a distinguerlo da chi sta
// usando la app con i dati mobili: il collegamento si fa in casa, il
// telecomando invece funziona anche fuori.
function sameNetworkAsPc(req) {
  const d = deviceInfo();
  const ip = String(clientIp(req) || '').replace(/^::ffff:/, '');
  if (!ip || ip === 'sconosciuto') return false;
  if (ip === '127.0.0.1' || ip === '::1') return false;
  const ips = (d.lanAll && d.lanAll.length) ? d.lanAll : (d.lan ? [d.lan] : []);
  if (!ips.length) return false;
  const parts = (s) => String(s).split('.').map((n) => parseInt(n, 10));
  const me = parts(ip);
  if (me.length !== 4 || me.some((n) => isNaN(n))) return false;
  return ips.some((lan) => {
    const t = parts(lan);
    return t.length === 4 && t[0] === me[0] && t[1] === me[1] && t[2] === me[2];
  });
}

// Nome della Wi-Fi a cui e collegato il PC (il telefono poi sa cosa cercare).
function wifiName() {
  if (process.platform === 'darwin') return '';
  const out = require('child_process').execSync('netsh wlan show interfaces', { encoding: 'utf8', timeout: 4000, windowsHide: true });
  const m = out.match(/^\s*SSID\s+:\s*(.+)$/m);
  const s = m ? m[1].trim() : '';
  return (s && s.toLowerCase() !== 'ssid') ? s : '';
}

app.get('/api/discover', (req, res) => {
  discoveryHeaders(res);
  const d = deviceInfo();
  res.json({
    ok: true,
    app: 'NexaRemote',
    name: d.name,
    host: d.host,
    os: d.os,
    port: d.port,
    lan: d.lan,
    lanAll: d.lanAll,
    publicUrl: d.publicUrl,
    hasTls: d.hasTls,
    sameNetwork: sameNetworkAsPc(req), // il telefono e sulla stessa Wi-Fi del PC?
    wifi: (() => { try { return wifiName(); } catch (e) { return ''; } })(),
    boot: bootInfo()
  });
});

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