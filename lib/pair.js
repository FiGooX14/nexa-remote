// Abbinamento telefono <-> PC.
// Il PC mostra un codice di 6 cifre: chi lo inserisce da un telefono o da un
// altro computer viene aggiunto alla lista dei dispositivi autorizzati e da quel
// momento puo comandare il PC. Il file e' data\pair.json.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const config = require('./config');

const FILE = path.join(config.DATA_DIR, 'pair.json');
const CODE_TTL = 5 * 60 * 1000; // il codice vale 5 minuti (come scritto nella guida)

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')) || {}; } catch (e) { return {}; }
}

function save(d) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(d, null, 2), 'utf8');
}

function state() {
  const d = load();
  if (!Array.isArray(d.trusted)) d.trusted = [];
  return d;
}

// Genera un codice nuovo di 6 cifre (valido 10 minuti).
function newCode() {
  const d = state();
  d.code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  d.codeUntil = Date.now() + CODE_TTL;
  save(d);
  return { code: d.code, expiresAt: d.codeUntil };
}

// Restituisce il codice solo se non e' scaduto, altrimenti lo genera.
function getCode() {
  const d = state();
  if (!d.code || !d.codeUntil || d.codeUntil < Date.now()) return newCode();
  return { code: d.code, expiresAt: d.codeUntil };
}

function checkCode(code) {
  const d = state();
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return false;
  if (!d.code || !d.codeUntil || d.codeUntil < Date.now()) return false;
  return d.code === clean;
}

// Aggiunge (o aggiorna) un dispositivo autorizzato.
function trust(id, info) {
  if (!id) return null;
  const d = state();
  const now = new Date().toISOString();
  let dev = d.trusted.find(x => x.id === id);
  if (!dev) {
    dev = { id, nome: (info && info.nome) || 'Dispositivo', email: (info && info.email) || '', created: now };
    d.trusted.push(dev);
  } else {
    if (info && info.nome) dev.nome = info.nome;
    if (info && info.email) dev.email = info.email;
  }
  dev.lastSeen = now;
  save(d);
  return dev;
}

function isTrusted(id) {
  if (!id) return false;
  return state().trusted.some(x => x.id === id);
}

function touch(id) {
  if (!isTrusted(id)) return;
  const d = state();
  const dev = d.trusted.find(x => x.id === id);
  if (dev) { dev.lastSeen = new Date().toISOString(); save(d); }
}

function list() {
  return state().trusted;
}

function revoke(id) {
  const d = state();
  const before = d.trusted.length;
  d.trusted = d.trusted.filter(x => x.id !== id);
  save(d);
  return d.trusted.length < before;
}

// Il proprietario del PC e' il primo account creato: e' l'unico che puo'
// mostrare il codice e gestire i dispositivi.
// owner() ritorna:
//   null  = non e' mai stato deciso (il server sceglie il primo account)
//   ''    = deciso che non c'e' ancora un proprietario (aspetta il prossimo)
//   email = il proprietario
function owner() {
  const d = load();
  return typeof d.owner === 'string' ? d.owner : null;
}

function setOwner(email) {
  if (!email) return;
  const d = state();
  if (!d.owner) { d.owner = email; save(d); }
}

// --- Richieste dal telefono: il codice nasce sul telefono e si conferma sul PC ---
const MAX_PENDING = 5;
const PENDING_TTL = 5 * 60 * 1000; // una richiesta scade dopo 5 minuti

function cleanPending(d) {
  if (!Array.isArray(d.pending)) d.pending = [];
  d.pending = d.pending.filter(p => (p.expiresAt || 0) > Date.now());
  return d.pending;
}

// Il telefono chiede di essere collegato: gli torna un codice da digitare sul PC.
function requestCode(deviceId, nome) {
  if (!deviceId) return null;
  const d = state();
  const pend = cleanPending(d);
  const mine = pend.find(p => p.deviceId === deviceId);
  if (mine) return { code: mine.code, expiresAt: mine.expiresAt };
  if (pend.length >= MAX_PENDING) pend.shift();
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const item = {
    code,
    deviceId,
    nome: nome || 'Dispositivo',
    created: new Date().toISOString(),
    expiresAt: Date.now() + PENDING_TTL
  };
  d.pending = pend.concat([item]);
  save(d);
  return { code, expiresAt: item.expiresAt };
}

// Richieste in attesa di conferma (mostrate sulla pagina del PC).
function pendingList() {
  const d = state();
  const before = JSON.stringify(d.pending || []);
  const pend = cleanPending(d);
  if (JSON.stringify(d.pending) !== before) save(d);
  return pend;
}

// Cerca un codice in attesa senza effettuare il collegamento: serve al PC per
// chiedere "sei sicuro di voler connettere <dispositivo>?".
function findPending(code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return null;
  const p = cleanPending(state()).find(x => x.code === clean);
  return p ? { code: p.code, nome: p.nome, deviceId: p.deviceId } : null;
}

// Il PC conferma il codice: il telefono collegato diventa autorizzato.
function confirmCode(code) {
  const clean = String(code || '').replace(/\D/g, '');
  if (clean.length !== 6) return null;
  const d = state();
  const pend = cleanPending(d);
  const p = pend.find(x => x.code === clean);
  if (!p) return null;
  d.pending = pend.filter(x => x.code !== clean);
  save(d);
  trust(p.deviceId, { nome: p.nome });
  return { deviceId: p.deviceId, nome: p.nome };
}

module.exports = {
  newCode, getCode, checkCode, trust, isTrusted, touch, list, revoke, owner, setOwner,
  requestCode, pendingList, confirmCode, findPending
};
