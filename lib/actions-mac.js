const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const LAST_SCREENSHOT = path.join(CACHE_DIR, 'last.png');
const LIVE_JPEG = path.join(CACHE_DIR, 'live.jpg');
const HOME = os.homedir();

function decodeOutput(buf) {
  if (!buf || buf.length === 0) return '';
  const s = buf.toString('utf8').replace(/\r/g, '');
  return s.trimEnd();
}

function runShell(script, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    const timeoutMs = o.timeout || 60000;
    let child;
    try {
      child = spawn('/bin/zsh', ['-lc', script], { cwd: o.cwd || HOME });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: String(e), timedOut: false, durationMs: 0 });
    }
    const out = [];
    const err = [];
    const started = Date.now();
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      out.timedOut = true;
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: '', stderr: String(e), timedOut: false, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: out.timedOut ? false : code === 0,
        code,
        stdout: decodeOutput(Buffer.concat(out)),
        stderr: decodeOutput(Buffer.concat(err)),
        timedOut: !!out.timedOut,
        durationMs: Date.now() - started
      });
    });
  });
}

function osa(script, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    const timeoutMs = o.timeout || 30000;
    let child;
    try {
      child = spawn('/usr/bin/osascript', ['-e', script], { cwd: o.cwd || HOME });
    } catch (e) {
      return resolve({ ok: false, code: -1, stdout: '', stderr: String(e), timedOut: false, durationMs: 0 });
    }
    const out = [];
    const err = [];
    const started = Date.now();
    const timer = setTimeout(() => {
      try { child.kill(); } catch (e) {}
      out.timedOut = true;
    }, timeoutMs);
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout: '', stderr: String(e), timedOut: false, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: out.timedOut ? false : code === 0,
        code,
        stdout: decodeOutput(Buffer.concat(out)),
        stderr: decodeOutput(Buffer.concat(err)),
        timedOut: !!out.timedOut,
        durationMs: Date.now() - started
      });
    });
  });
}

function escOsa(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function keyCodeFor(name) {
  const map = {
    left: 123, up: 126, right: 124, down: 125,
    space: 49, enter: 36, esc: 53, tab: 48,
    f5: 96, f11: 103, backspace: 51, delete: 117
  };
  return map[name];
}

function pressKeyCode(code) {
  return `
tell application "System Events"
  key code ${code}
end tell
`;
}

const actions = {

  async shutdown() {
    return osa(`tell application "System Events" to shut down`);
  },

  async restart() {
    return osa(`tell application "System Events" to restart`);
  },

  async lock() {
    return runShell('/System/Library/CoreServices/Menu\\ Extras/User.menu/Contents/Resources/CGSession -suspend');
  },

  async hibernate() {
    return osa(`
tell application "System Events"
  key code 39 using control down
end tell
sleep 1
tell application "System Events" to sleep
`);
  },

  async sleep() {
    return osa(`tell application "System Events" to sleep`);
  },

  async logout() {
    return osa(`
tell application "System Events"
  key code 53
  set frontProcess to name of first application process whose frontmost is true
end tell
tell application System Events to keystroke "q" using {command down, option down}
`);
  },

  async volumeUp() {
    return runShell('osascript -e "set volume output volume ((output volume of (get volume settings)) + 10)"');
  },

  async volumeDown() {
    return runShell('osascript -e "set volume output volume ((output volume of (get volume settings)) - 10)"');
  },

  async volumeMute() {
    return runShell(`
set +e
osascript -e 'set volume output muted true'
`);
  },

  async mediaPlayPause() { return osa(pressKeyCode(16)); },
  async mediaNext() { return osa(pressKeyCode(17)); },
  async mediaPrev() { return osa(pressKeyCode(18)); },

  async key(payload) {
    const name = String((payload && payload.key) || '').toLowerCase();
    const code = keyCodeFor(name);
    if (code === undefined) return { ok: false, code: 1, stdout: '', stderr: 'Tasto sconosciuto', timedOut: false };
    return osa(pressKeyCode(code));
  },

  async showDesktop() {
    return osa(`tell application "System Events" to key code 103 using {control down, command down}`);
  },

  async taskManager() {
    return runShell('open -a "Activity Monitor"');
  },

  async lockWin() {
    return this.lock();
  },

  async brightness(payload) {
    const val = Math.max(1, Math.min(100, parseInt(payload && payload.value, 10) || 50));
    return osa(`
tell application "System Events"
  repeat ${val} / 10 times
    key code 144
  end repeat
end tell
`);
  },

  async brightnessSupport() {
    const res = await runShell('system_profiler SPPowerDataType 2>/dev/null | grep -i "Battery Installed" | head -1');
    const m = /Battery Installed:\s*(Yes|No)/i.exec(res.stdout);
    return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false, durationMs: res.durationMs, supported: m ? m[1].toLowerCase() === 'yes' : true };
  },

  async screenshot() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const dest = LAST_SCREENSHOT.replace(/'/g, "\\'");
    const res = await runShell(`screencapture -x -t png '${dest}'`);
    if (res.ok && fs.existsSync(LAST_SCREENSHOT)) {
      return { ok: true, code: 0, stdout: 'OK', stderr: '', timedOut: false, durationMs: res.durationMs, image: '/cache/last.png' };
    }
    return res;
  },

  async liveFrame() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const maxW = 1024;
    const tmp = LIVE_JPEG;
    const res = await runShell(`
screencapture -x -t jpeg /tmp/nexa-live-full.jpg
sips -g pixelWidth -g pixelHeight /tmp/nexa-live-full.jpg > /tmp/nexa-live-size.txt 2>/dev/null
`);
    if (!res.ok) return res;
    const sizeTxt = fs.existsSync('/tmp/nexa-live-size.txt') ? fs.readFileSync('/tmp/nexa-live-size.txt', 'utf8') : '';
    const wm = /pixelWidth: (\d+)/.exec(sizeTxt);
    const hm = /pixelHeight: (\d+)/.exec(sizeTxt);
    const w = wm ? parseInt(wm[1], 10) : 0;
    const h = hm ? parseInt(hm[1], 10) : 0;
    if (w <= 0 || h <= 0) return { ok: false, code: 1, stdout: '', stderr: 'Impossibile catturare lo schermo su macOS (serve il permesso Registrazione schermo)', timedOut: false };
    const scale = Math.min(1, maxW / w);
    const nw = Math.round(w * scale);
    const nh = Math.round(h * scale);
    const r2 = await runShell(`sips --resampleWidth ${nw} --resampleHeight ${nh} /tmp/nexa-live-full.jpg --out '${tmp}' >/dev/null 2>&1`);
    if (r2.ok && fs.existsSync(LIVE_JPEG)) {
      return { ok: true, code: 0, stdout: nw + 'x' + nh, stderr: '', timedOut: false, durationMs: r2.durationMs, image: '/cache/live.jpg', w: nw, h: nh };
    }
    return r2;
  },

  async listApps() {
    const res = await osa(`
set out to ""
tell application "System Events"
  set allApps to name of every application process whose visible is true
end tell
repeat with a in allApps
  set out to out & a & linefeed
end repeat
return out
`, { timeout: 15000 });
    if (!res.ok) return res;
    const apps = res.stdout.split('\n').filter(Boolean).map((name) => ({ name, id: 0, title: name }));
    return { ok: true, code: 0, stdout: res.stdout, stderr: '', timedOut: false, durationMs: res.durationMs, apps };
  },

  async closeApp(payload) {
    const name = String((payload && payload.name) || '').trim();
    if (!name) return { ok: false, code: 1, stdout: '', stderr: 'Nome programma mancante', timedOut: false };
    return osa(`
on run
  try
    quit application "${escOsa(name)}"
    return "Chiuso ${escOsa(name)}"
  on error
    return "Nessun programma '${escOsa(name)}' aperto o impossibile chiuderlo"
  end try
end run
`);
  },

  async minimizeApp(payload) {
    const name = String((payload && payload.name) || '').trim();
    if (!name) return { ok: false, code: 1, stdout: '', stderr: 'Nome programma mancante', timedOut: false };
    return osa(`
on run
  try
    tell application "System Events" to set visible of first process whose name is "${escOsa(name)}" to false
    return "Ridotto a icona ${escOsa(name)}"
  on error
    return "Programma non trovato o violazione accessibilita"
  end try
end run
`);
  },

  async maximizeApp(payload) {
    const name = String((payload && payload.name) || '').trim();
    if (!name) return { ok: false, code: 1, stdout: '', stderr: 'Nome programma mancante', timedOut: false };
    return osa(`
on run
  try
    tell application "System Events" to set visible of first process whose name is "${escOsa(name)}" to true
    tell application "${escOsa(name)}" to activate
    return "A schermo intero ${escOsa(name)}"
  on error
    return "Programma non trovato"
  end try
end run
`);
  },

  async openApp(payload) {
    if (payload && payload.target) {
      const t = String(payload.target).replace(/\s+/g, '\\ ').replace(/'/g, "\\'");
      if (/^https?:\/\//i.test(String(payload.target))) return runShell(`open '${t}'`);
      return runShell(`open -a '${t}' ` + '|| ' + `open '${t}'`);
    }
    const app = String((payload && payload.app) || '').toLowerCase();
    const map = {
      calculator: 'Calculator',
      notepad: 'TextEdit',
      explorer: 'Finder',
      settings: 'System Settings',
      taskmanager: 'Activity Monitor',
      paint: 'Preview',
      terminal: 'Terminal',
      thispc: 'Finder'
    };
    if (app === 'browser') return runShell('open -a Safari');
    if (app === 'browserurl') {
      const url = String((payload && payload.url) || 'https://www.google.com');
      return runShell(`open '${url}'`);
    }
    if (app === 'copilot') {
      return { ok: false, code: 1, stdout: '', stderr: 'Copilot non esiste su macOS', timedOut: false };
    }
    const target = map[app];
    if (!target) return { ok: false, code: 1, stdout: '', stderr: 'Programma sconosciuto', timedOut: false };
    return runShell(`open -a '${target}'`);
  },

  async mouseMove(payload) {
    const res = await runShell('command -v cliclick');
    if (!res.ok) return { ok: false, code: 1, stdout: '', stderr: 'Serve cliclick su macOS (installa con: brew install cliclick). Su mac il touchpad si controlla da questo stato software.', timedOut: false };
    const xPct = Math.max(0, Math.min(100, parseFloat(payload && payload.x) || 0));
    const yPct = Math.max(0, Math.min(100, parseFloat(payload && payload.y) || 0));
    return runShell(`cliclick p:${xPct}%:${yPct}%`, { timeout: 10000 });
  },

  async mouseClick(payload) {
    const res = await runShell('command -v cliclick');
    if (!res.ok) return { ok: false, code: 1, stdout: '', stderr: 'Serve cliclick su macOS (installa con: brew install cliclick)', timedOut: false };
    const btn = (payload && payload.button) || 'left';
    const dbl = !!(payload && payload.double);
    if (dbl) return runShell('cliclick dc:', { timeout: 10000 });
    return runShell(`cliclick ${btn === 'right' ? 'rc:' : 'c:'}`, { timeout: 10000 });
  },

  async mouseScroll(payload) {
    const res = await runShell('command -v cliclick');
    if (!res.ok) return { ok: false, code: 1, stdout: '', stderr: 'Serve cliclick su macOS (installa con: brew install cliclick)', timedOut: false };
    const delta = Math.max(-1200, Math.min(1200, parseInt(payload && payload.delta, 10) || 0));
    const steps = Math.max(1, Math.round(Math.abs(delta) / 60));
    return runShell(`cliclick ${delta < 0 ? 'w:-' : 'w:'}` + steps, { timeout: 10000 });
  },

  async typeText(payload) {
    const text = String((payload && payload.text) || '');
    if (!text) return { ok: false, code: 1, stdout: '', stderr: 'Testo vuoto', timedOut: false };
    const escaped = escOsa(text).replace(/\n/g, '\\n');
    return osa(`
tell application "System Events" to keystroke "${escaped}"
`, { timeout: 15000 });
  },

  async term(payload, blockedTerms) {
    const script = String((payload && payload.script) || '').trim();
    if (!script) return { ok: false, code: 1, stdout: '', stderr: 'Script vuoto', timedOut: false };
    if (script.length > 10000) return { ok: false, code: 1, stdout: '', stderr: 'Script troppo lungo (max 10000 caratteri)', timedOut: false };
    const blocked = blockedTerms || [];
    for (const b of blocked) {
      if (b && script.toLowerCase().includes(b.toLowerCase())) {
        return { ok: false, code: 1, stdout: '', stderr: `Comando rifiutato: contiene "${b}"`, timedOut: false };
      }
    }
    return runShell(script, { timeout: 60000 });
  },
};

async function dispatch(actionName, payload, opts) {
  if (actionName === 'term') {
    const script = String((payload && payload.script) || '').trim();
    if (!script) return { ok: false, code: 1, stdout: '', stderr: 'Script vuoto', timedOut: false };
    const blocked = (opts && opts.blockedTerms) || [];
    for (const b of blocked) {
      if (b && script.toLowerCase().includes(b.toLowerCase())) {
        return { ok: false, code: 1, stdout: '', stderr: `Comando rifiutato: contiene "${b}"`, timedOut: false };
      }
    }
    return runShell(script, { timeout: 60000 });
  }
  const fn = actions[actionName];
  if (!fn) return { ok: false, code: 1, stdout: '', stderr: `Azione sconosciuta: ${actionName}`, timedOut: false };
  try {
    return await fn(payload, opts && opts.blockedTerms);
  } catch (e) {
    return { ok: false, code: 1, stdout: '', stderr: String(e), timedOut: false };
  }
}

module.exports = { dispatch, runShell, osa, actions };