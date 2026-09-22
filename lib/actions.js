const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const IS_MAC = os.platform() === 'darwin';

if (IS_MAC) {
  module.exports = require('./actions-mac');
} else {

const CACHE_DIR = path.join(__dirname, '..', 'data', 'cache');
const LAST_SCREENSHOT = path.join(CACHE_DIR, 'last.png');
const LIVE_JPEG = path.join(CACHE_DIR, 'live.jpg');

function decodeOutput(buf) {
  if (!buf || buf.length === 0) return '';
  if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le', 2);
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf8', 3);
  return buf.toString('utf8');
}

function runPS(script, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    const timeoutMs = o.timeout || 60000;
    const args = ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
    let child;
    try {
      child = spawn('powershell.exe', args, { windowsHide: true, cwd: o.cwd });
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

const USER32_HELPER = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class U {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int nIndex);
}
"@
`;

const KEYEVENTF_KEYDOWN = 0x0000;
const KEYEVENTF_KEYUP = 0x0002;

function pressVk(vk) {
  return `
${USER32_HELPER}
[U]::keybd_event([byte]${vk}, 0, ${KEYEVENTF_KEYDOWN}, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[U]::keybd_event([byte]${vk}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)
`;
}

function pressVkMod(mod, vk) {
  return `
${USER32_HELPER}
[U]::keybd_event([byte]${mod}, 0, ${KEYEVENTF_KEYDOWN}, [UIntPtr]::Zero)
[U]::keybd_event([byte]${vk}, 0, ${KEYEVENTF_KEYDOWN}, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[U]::keybd_event([byte]${vk}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)
[U]::keybd_event([byte]${mod}, 0, ${KEYEVENTF_KEYUP}, [UIntPtr]::Zero)
`;
}

const actions = {

  async shutdown() {
    return runPS('shutdown /s /t 3');
  },

  async restart() {
    return runPS('shutdown /r /t 3');
  },

  async lock() {
    return runPS(`
Add-Type @"
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool LockWorkStation();
}
"@
[W]::LockWorkStation() | Out-Null
`);
  },

  async hibernate() {
    return runPS('shutdown /h');
  },

  async sleep() {
    return runPS('rundll32.exe powrprof.dll,SetSuspendState 0,1,0');
  },

  async logout() {
    return runPS('shutdown /l');
  },

  async volumeUp() { return runPS(pressVk(0xAF)); },
  async volumeDown() { return runPS(pressVk(0xAE)); },
  async volumeMute() { return runPS(pressVk(0xAD)); },

  async mediaPlayPause() { return runPS(pressVk(0xB3)); },
  async mediaNext() { return runPS(pressVk(0xB0)); },
  async mediaPrev() { return runPS(pressVk(0xB1)); },

  async key(payload) {
    const key = String((payload && payload.key) || '').toLowerCase();
    const map = {
      left: 0x25, up: 0x26, right: 0x27, down: 0x28,
      space: 0x20, enter: 0x0D, esc: 0x1B, tab: 0x09,
      f5: 0x74, f11: 0x7A, backspace: 0x08, delete: 0x2E
    };
    const vk = map[key];
    if (vk === undefined) return { ok: false, code: 1, stdout: '', stderr: 'Tasto sconosciuto', timedOut: false };
    return runPS(pressVk(vk));
  },

  async showDesktop() { return runPS(pressVkMod(0x5B, 0x44)); },
  async taskManager() { return runPS('Start-Process taskmgr'); },
  async lockWin() { return runPS(pressVkMod(0x5B, 0x4C)); },

  async brightness(payload) {
    const val = Math.max(1, Math.min(100, parseInt(payload && payload.value, 10) || 50));
    return runPS(`
try {
  $m = Get-WmiObject -Namespace root\\WMI -Class WmiMonitorBrightnessMethods -ErrorAction Stop
  if ($m) { $m[0].WmiSetBrightness(1, ${val}) ; Write-Output "Luminosita impostata a ${val}%"; exit 0 }
  Write-Output "PC senza controllo luminosita (desktop)"; exit 1
} catch {
  Write-Error "Luminosita non supportata su questo PC"
  exit 2
}
`, { cwd: 'C:\\Windows\\System32' });
  },

  async screenshot() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.X, $vs.Y, 0, 0, $bmp.Size)
$bmp.Save('${LAST_SCREENSHOT.replace(/\\/g, '\\\\').replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
Write-Output "OK"
`;
    const res = await runPS(script, { timeout: 30000 });
    if (res.ok && fs.existsSync(LAST_SCREENSHOT)) {
      return { ok: true, code: 0, stdout: 'OK', stderr: '', timedOut: false, durationMs: res.durationMs, image: '/cache/last.png' };
    }
    return res;
  },

  async brightnessSupport() {
    const res = await runPS(`
try {
  $m = Get-WmiObject -Namespace root\\WMI -Class WmiMonitorBrightnessMethods -ErrorAction Stop
  if ($m) { Write-Output "yes"; exit 0 }
  Write-Output "no"; exit 0
} catch { Write-Output "no"; exit 0 }
`, { cwd: 'C:\\Windows\\System32' });
    return { ok: true, code: 0, stdout: '', stderr: '', timedOut: false, durationMs: res.durationMs, supported: res.stdout.indexOf('yes') >= 0 };
  },

  async liveFrame() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const maxW = 1024;
    const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$full = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
$g0 = [System.Drawing.Graphics]::FromImage($full)
$g0.CopyFromScreen($vs.X, $vs.Y, 0, 0, $vs.Size)
$scale = ${maxW} / [double]$vs.Width
if ($scale -gt 1.0) { $scale = 1.0 }
$w = [int]($vs.Width * $scale)
$h = [int]($vs.Height * $scale)
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($full, 0, 0, $w, $h)
$enc = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
$ep = New-Object System.Drawing.Imaging.EncoderParameters(1)
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, 55)
$bmp.Save('${LIVE_JPEG.replace(/\\/g, '\\\\').replace(/'/g, "''")}', $enc, $ep)
$g0.Dispose(); $g.Dispose(); $full.Dispose(); $bmp.Dispose()
Write-Output ($w.ToString() + 'x' + $h.ToString())
`;
    const res = await runPS(script, { timeout: 30000 });
    if (res.ok && fs.existsSync(LIVE_JPEG)) {
      const m = /^(\d+)x(\d+)/.exec(res.stdout.trim());
      return { ok: true, code: 0, stdout: res.stdout, stderr: '', timedOut: false, durationMs: res.durationMs, image: '/cache/live.jpg', w: m ? parseInt(m[1], 10) : 0, h: m ? parseInt(m[2], 10) : 0 };
    }
    return res;
  },

  async listApps() {
    const res = await runPS(`
$list = Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object @{n='name';e={$_.ProcessName}}, Id, @{n='title';e={$_.MainWindowTitle}} | Sort-Object title
$list | ConvertTo-Json -Compress
`, { timeout: 15000 });
    if (!res.ok) return res;
    let apps = [];
    try {
      const parsed = JSON.parse(res.stdout);
      if (Array.isArray(parsed)) apps = parsed;
      else if (parsed && parsed.name) apps = [parsed];
    } catch (e) { apps = []; }
    return { ok: true, code: 0, stdout: res.stdout, stderr: '', timedOut: false, durationMs: res.durationMs, apps };
  },

  async closeApp(payload) {
    const name = String((payload && payload.name) || '').trim().toLowerCase().replace(/\.exe$/i, '');
    if (!name) return { ok: false, code: 1, stdout: '', stderr: 'Nome programma mancante', timedOut: false };
    return runPS(`
$p = Get-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue
if (-not $p) { Write-Output "Nessun programma '${name.replace(/'/g, "''")}' aperto"; exit 0 }
$p | ForEach-Object { try { $_.CloseMainWindow() | Out-Null } catch {} }
Start-Sleep -Seconds 2
$still = Get-Process -Name '${name.replace(/'/g, "''")}' -ErrorAction SilentlyContinue
if ($still) { $still | Stop-Process -Force }
Write-Output "Chiuso ${name}"
`, { timeout: 20000 });
  },

  async openApp(payload) {
    if (payload && payload.target) {
      return runPS(`Start-Process '${String(payload.target).replace(/'/g, "''")}'`);
    }
    const app = String((payload && payload.app) || '').toLowerCase();
    const map = {
      calculator: 'calc',
      notepad: 'notepad',
      explorer: 'explorer.exe',
      settings: 'explorer.exe ms-settings:',
      taskmanager: 'taskmgr',
      paint: 'mspaint',
      terminal: 'cmd.exe /k echo Consenti l\'uso del telecomando',
      thispc: 'explorer.exe shell:MyComputerFolder'
    };
    if (app === 'browser') return runPS('Start-Process "https://www.google.com"');
    if (app === 'browserurl') {
      const url = String((payload && payload.url) || 'https://www.google.com');
      return runPS(`Start-Process '${url.replace(/'/g, "''")}'`);
    }
    if (app === 'copilot') {
      return runPS(`
$pkg = Get-AppxPackage -Name '*Copilot*' | Select-Object -First 1
if (-not $pkg) { Write-Output 'Copilot non e installato su questo PC'; exit 1 }
$mPath = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
try {
  [xml]$m = Get-Content -LiteralPath $mPath -ErrorAction Stop
  $appId = $m.Package.Applications.Application.Id
} catch { $appId = 'App' }
$aumid = "$($pkg.PackageFamilyName)!$appId"
Start-Process explorer.exe ("shell:AppsFolder\$aumid")
Start-Sleep -Milliseconds 600
Write-Output "Copilot avviato ($aumid)"
`);
    }
    const target = map[app];
    if (!target) return { ok: false, code: 1, stdout: '', stderr: 'Programma sconosciuto', timedOut: false };
    return runPS(`Start-Process ${target}`);
  },

  async mouseMove(payload) {
    const xPct = Math.max(0, Math.min(100, parseFloat(payload && payload.x) || 0));
    const yPct = Math.max(0, Math.min(100, parseFloat(payload && payload.y) || 0));
    return runPS(`
${USER32_HELPER}
$w = [U]::GetSystemMetrics(0)
$h = [U]::GetSystemMetrics(1)
$x = [int]($w * (${xPct} / 100))
$y = [int]($h * (${yPct} / 100))
[U]::SetCursorPos($x, $y) | Out-Null
`, { timeout: 10000 });
  },

  async mouseClick(payload) {
    const btn = (payload && payload.button) || 'left';
    const dbl = !!(payload && payload.double);
    const down = btn === 'right' ? '0x0008' : '0x0002';
    const up = btn === 'right' ? '0x0010' : '0x0004';
    const script = `
${USER32_HELPER}
[U]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[U]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)
${dbl ? `
Start-Sleep -Milliseconds 80
[U]::mouse_event(${down}, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[U]::mouse_event(${up}, 0, 0, 0, [UIntPtr]::Zero)` : ''}
`;
    return runPS(script, { timeout: 10000 });
  },

  async mouseScroll(payload) {
    const delta = Math.max(-1200, Math.min(1200, parseInt(payload && payload.delta, 10) || 0));
    return runPS(`
${USER32_HELPER}
$d = if (${delta} -lt 0) { [uint32](4294967296 + ${delta}) } else { [uint32]${delta} }
[U]::mouse_event(0x0800, 0, 0, $d, [UIntPtr]::Zero)
`, { timeout: 10000 });
  },

  async typeText(payload) {
    const text = String((payload && payload.text) || '');
    if (!text) return { ok: false, code: 1, stdout: '', stderr: 'Testo vuoto', timedOut: false };
    const escaped = text.replace(/'/g, "''");
    return runPS(`
Add-Type -AssemblyName System.Windows.Forms
$old = ""
try { $old = (Get-Clipboard -Raw) } catch { $old = "" }
Set-Clipboard -Value '${escaped}'
Start-Sleep -Milliseconds 100
$ws = New-Object -ComObject WScript.Shell
$ws.SendKeys('^v')
Start-Sleep -Milliseconds 250
try { if ($old -ne "") { Set-Clipboard -Value $old } } catch {}
Write-Output "Testo scritto (${text.length} caratteri)"
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
    return runPS(script, { timeout: 60000, cwd: 'C:\\Users\\Utente' });
  }
};

async function dispatch(actionName, payload, opts) {
  const fn = actions[actionName];
  if (!fn) return { ok: false, code: 1, stdout: '', stderr: `Azione sconosciuta: ${actionName}`, timedOut: false };
  try {
    return await fn(payload, opts && opts.blockedTerms);
  } catch (e) {
    return { ok: false, code: 1, stdout: '', stderr: String(e), timedOut: false };
  }
}

module.exports = { dispatch, runPS, actions };
}