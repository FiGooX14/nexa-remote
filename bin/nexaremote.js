#!/usr/bin/env node
// NexaRemote - comando globale: avvia il telecomando e apre il browser.
// Installazione (come NEXA):  npm install -g @nexa-tech/nexa-remote  ->  nexaremote
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const IS_GLOBAL = ROOT.includes('node_modules');
const HOME = process.env.NEXAREMOTE_HOME || (IS_GLOBAL ? path.join(os.homedir(), '.nexaremote') : ROOT);
const ENV_FILE = path.join(HOME, '.env');
const CERT_DIR = path.join(HOME, 'certs');
const args = process.argv.slice(2);

function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : '';
}

if (args.includes('--help') || args.includes('-h')) {
  console.log('');
  console.log('  N E X A  R E M O T E  -  Nexatech | Le app del futuro');
  console.log('');
  console.log('  nexaremote                 avvia il telecomando e apre il browser');
  console.log('  nexaremote --porta 3002    sceglie la porta (default 3002)');
  console.log('  nexaremote --no-browser    non apre il browser');
  console.log('  nexaremote --info          mostra dove stanno i dati e l indirizzo');
  console.log('  nexaremote --help          questo elenco');
  console.log('');
  process.exit(0);
}

const PORT = Number(flagValue('--porta') || flagValue('--port') || process.env.NEXAREMOTE_PORT || 3002);
const URL = 'http://localhost:' + PORT;
const NO_BROWSER = args.includes('--no-browser') || process.env.NEXAREMOTE_NO_BROWSER === '1';

let opened = false;
function openBrowser() {
  if (opened || NO_BROWSER) return;
  opened = true;
  try {
    const cmd = process.platform === 'win32'
      ? spawn('cmd', ['/c', 'start', '', URL], { windowsHide: true })
      : spawn('xdg-open', [URL], { stdio: 'ignore' });
    cmd.on('error', () => {});
  } catch (e) { }
}

function ping(cb) {
  const req = http.get(URL, (res) => { res.resume(); cb(true); });
  req.on('error', () => cb(false));
  req.setTimeout(2000, () => { req.destroy(); cb(false); });
}

// Prima configurazione: crea la cartella dei dati e un .env con i valori base.
function firstRun() {
  for (const dir of [HOME, path.join(HOME, 'data'), path.join(HOME, 'data', 'cache'), CERT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(ENV_FILE)) return;
  const lines = [
    '# NexaRemote - configurazione locale (creata al primo avvio)',
    '# MAI condividere questo file contiene i segreti.',
    '',
    'PORT=3002',
    'SESSION_SECRET=' + crypto.randomBytes(24).toString('hex'),
    '# Per il collegamento col telefono basta aprire l indirizzo del PC.',
    '# Fuori casa si aggiunge HTTPS con Tailscale: metti i file del certificato',
    '# (.crt e .key) nella cartella ' + CERT_DIR,
    ''
  ];
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
  console.log('');
  console.log('  Prima volta: creato ' + HOME);
}

function readEnv() {
  const out = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch (e) { }
  return out;
}

function certFiles() {
  try {
    const f = fs.readdirSync(CERT_DIR).filter((n) => n.toLowerCase().endsWith('.crt'))[0];
    return f ? path.join(CERT_DIR, f) : '';
  } catch (e) { return ''; }
}

function publicUrl() {
  const env = readEnv();
  let u = String(env.PUBLIC_URL || '').trim();
  if (!u) { try { u = fs.readFileSync(path.join(HOME, 'data', 'public-url.txt'), 'utf8').trim(); } catch (e) { u = ''; } }
  return u.replace(/\/+$/, '');
}

if (args.includes('--info')) {
  firstRun();
  const pub = publicUrl();
  console.log('');
  console.log('  NexaRemote: i tuoi dati stanno in ' + HOME);
  console.log('  Indirizzo in casa:      ' + URL);
  if (pub) console.log('  Indirizzo pubblico:     ' + pub);
  if (certFiles()) console.log('  HTTPS (fuori casa):     attivo, certificato in ' + certFiles());
  else console.log('  HTTPS (fuori casa):     non attivo (metti il certificato Tailscale in certs\\.)');
  console.log('');
  process.exit(0);
}

function start() {
  process.env.PORT = String(PORT);
  process.env.NEXAREMOTE_HOME = HOME;
  console.log('');
  console.log('  N E X A  R E M O T E  -  avvio in corso...');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
    windowsHide: false
  });

  let tries = 0;
  const timer = setInterval(() => {
    ping((ok) => {
      if (ok) {
        clearInterval(timer);
        const pub = publicUrl();
        console.log('');
        console.log('  NexaRemote attivo su ' + URL);
        if (pub) console.log('  Anche fuori casa: ' + pub);
        console.log('');
        console.log('  Sul telefono apri l indirizzo del PC: ti compare subito un codice.');
        console.log('  Sul PC, per confermare, apri: ' + URL + '/pc');
        console.log('');
        openBrowser();
      } else if (tries++ > 40) {
        clearInterval(timer);
        console.error('  Il server non risponde. Guarda i messaggi qui sopra per capire.');
      }
    });
  }, 500);

  const shutdown = () => {
    try { child.kill(); } catch (e) { }
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  child.on('exit', (code) => process.exit(code == null ? 0 : code));
  child.on('error', (err) => {
    console.error('  Impossibile avviare NexaRemote: ' + (err && err.message ? err.message : err));
    process.exit(1);
  });
}

firstRun();
start();
