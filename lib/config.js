// Percorsi centrali di NexaRemote.
// In sviluppo (cartella del progetto) i dati stanno accanto al codice.
// Con il pacchetto installato GLOBALMENTE (npm install -g) i dati vanno invece
// in ~/.nexaremote, cosi l'utente non deve avere la cartella del progetto.
const os = require('os');
const path = require('path');
const fs = require('fs');

const PACKAGE_DIR = path.join(__dirname, '..');

function isGlobalInstall() {
  if (process.env.NEXAREMOTE_HOME) return true;
  return PACKAGE_DIR.includes('node_modules');
}

function getHome() {
  if (process.env.NEXAREMOTE_HOME) return process.env.NEXAREMOTE_HOME;
  if (isGlobalInstall()) return path.join(os.homedir(), '.nexaremote');
  return PACKAGE_DIR;
}

const HOME = getHome();
const IS_GLOBAL = isGlobalInstall();
const DATA_DIR = path.join(HOME, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const CERT_DIR = path.join(HOME, 'certs');
const ENV_FILE = path.join(HOME, '.env');
// Il codice (frontend, helper audio) resta sempre nella cartella del pacchetto.
const PUBLIC_DIR = path.join(PACKAGE_DIR, 'public');
const AUDIO_DIR = path.join(PACKAGE_DIR, 'lib', 'audio');

function ensureDirs() {
  for (const dir of [HOME, DATA_DIR, CACHE_DIR, CERT_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  PACKAGE_DIR, HOME, IS_GLOBAL, DATA_DIR, CACHE_DIR, CERT_DIR,
  ENV_FILE, PUBLIC_DIR, AUDIO_DIR, ensureDirs
};
