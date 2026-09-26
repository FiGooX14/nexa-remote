// Ricerca e collegamento automatico del PC.
// Il telefono cerca NexaRemote nella stessa rete Wi-Fi, lo ricorda e da quel
// momento sceglie da solo dove connettersi: indirizzo di casa se il PC risponde,
// altrimenti indirizzo pubblico (funziona anche fuori casa).
const DisCo = (function () {
  const KEY = 'nexaremote.devices.v1';
  const DEFAULT_PORT = 3002;
  const LAN_CONCURRENCY = 32;

  function currentBase() {
    return location.origin;
  }

  function saved() {
    try {
      const list = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch (e) { return []; }
  }

  function store(list) {
    try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, 12))); } catch (e) { }
  }

  function normalize(d, base) {
    return {
      id: base,
      name: d.name || d.host || base,
      host: d.host || '',
      os: d.os || '',
      lan: d.lan || '',
      port: d.port || DEFAULT_PORT,
      base,
      publicUrl: d.publicUrl || '',
      hasTls: !!d.hasTls,
      lastSeen: Date.now()
    };
  }

  function remember(dev) {
    if (!dev || !dev.base) return dev;
    const list = saved().filter((d) => d.base !== dev.base);
    list.unshift(dev);
    store(list);
    return dev;
  }

  function forget(base) {
    store(saved().filter((d) => d.base !== base));
  }

  // Porta da provare: quella con cui e aperta questa pagina (se e una porta
  // normale) e quella standard di NexaRemote.
  function probePorts() {
    const ports = [];
    const here = parseInt(location.port || '', 10);
    if (here && here > 1023 && here < 65536 && here !== DEFAULT_PORT) ports.push(here);
    ports.push(DEFAULT_PORT);
    return ports;
  }

  // Indirizzo IP locale del telefono, senza permessi: lo ottiene WebRTC.
  function localIp() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ip) => { if (!done) { done = true; try { pc && pc.close(); } catch (e) { } resolve(ip || ''); } };
      let pc = null;
      const timer = setTimeout(() => finish(''), 2500);
      try {
        pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
        pc.onicecandidate = (e) => {
          if (!e.candidate) return;
          const m = e.candidate.candidate.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
          if (!m) return;
          if (/^(127\.|0\.|169\.254\.)/.test(m[1])) return;
          clearTimeout(timer);
          finish(m[1]);
        };
        pc.createDataChannel('nexaremote');
        pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => { clearTimeout(timer); finish(''); });
      } catch (e) { clearTimeout(timer); finish(''); }
    });
  }

  function subnetsFrom(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return ['192.168.0'];
    const third = parseInt(parts[2], 10);
    const nets = [parts[0] + '.' + parts[1] + '.' + third];
    if (third === 1) nets.push(parts[0] + '.' + parts[1] + '.0');
    if (third === 0) nets.push(parts[0] + '.' + parts[1] + '.1');
    return nets;
  }

  async function fetchJson(url, timeoutMs) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(url, {
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit',
        signal: ctl.signal
      });
      if (!r.ok) return null;
      return await r.json();
    } catch (e) {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  // Un indirizzo risponde se su una porta c'e un NexaRemote.
  async function probeBase(base, timeoutMs) {
    const d = await fetchJson(base + '/api/discover', timeoutMs || 1500);
    if (!d || d.app !== 'NexaRemote' || !d.ok) return null;
    return normalize(d, base);
  }

  async function probeHost(host, timeoutMs) {
    for (const port of probePorts()) {
      const base = 'http://' + host + ':' + port;
      const found = await probeBase(base, timeoutMs);
      if (found) return found;
    }
    return null;
  }

  // Cerca i PC con NexaRemote nella stessa rete del telefono.
  // Prima passata veloce, poi se non trova niente una passata piu lenta.
  async function scan(onProgress) {
    const ip = await localIp();
    const nets = ip ? subnetsFrom(ip) : ['192.168.0', '192.168.1'];
    const found = [];
    const seen = new Set();

    async function pass(nets2, timeoutMs) {
      for (const net of nets2) {
        const hosts = [];
        for (let h = 1; h <= 254; h++) hosts.push(net + '.' + h);
        let i = 0;
        const worker = async () => {
          while (i < hosts.length) {
            const host = hosts[i++];
            const dev = await probeHost(host, timeoutMs);
            if (dev) {
              const isNew = !seen.has(dev.base);
              seen.add(dev.base);
              if (isNew) found.push(dev);
              if (onProgress) onProgress({ done: i, total: hosts.length, found: found.length, current: host, hit: dev });
            } else if (onProgress) {
              onProgress({ done: i, total: hosts.length, found: found.length, current: host });
            }
          }
        };
        await Promise.all(Array.from({ length: LAN_CONCURRENCY }, worker));
      }
    }

    if (onProgress) onProgress({ done: 0, total: 1, found: 0, current: '', phase: 'fast' });
    await pass(nets, 500);
    if (!found.length) await pass(nets, 1600);
    found.forEach(remember);
    return { found, myIp: ip, nets };
  }

  // Cerca i PC con NexaRemote dentro UNA rete precisa (es. 192.168.0).
  // La fa il telefono, quindi vede solo i computer che si raggiungono dalla
  // sua stessa rete: se e sui dati mobili non trova niente, e giusto.
  async function scanSubnet(net, port, onProgress, timeoutMs) {
    const ports = [port || DEFAULT_PORT];
    const here = parseInt(location.port || '', 10);
    if (here && here > 1023 && here < 65536 && ports.indexOf(here) === -1) ports.push(here);
    const hosts = [];
    for (let h = 1; h <= 254; h++) hosts.push(net + '.' + h);
    const found = [];
    const seen = new Set();
    let i = 0;
    const worker = async () => {
      while (i < hosts.length) {
        const host = hosts[i++];
        let dev = null;
        for (const p of ports) {
          const b = 'http://' + host + ':' + p;
          const hit = await probeBase(b, timeoutMs || 500);
          if (hit) { dev = hit; break; }
        }
        if (dev && !seen.has(dev.base)) { seen.add(dev.base); found.push(dev); }
        if (onProgress) onProgress({ done: i, total: hosts.length, found: found.length, current: host, hit: dev });
      }
    };
    if (onProgress) onProgress({ done: 0, total: hosts.length, found: 0, current: '' });
    await Promise.all(Array.from({ length: LAN_CONCURRENCY }, worker));
    found.forEach(remember);
    return { found: found, net: net };
  }

  // Controlla i PC ricordati: in casa risponde l'indirizzo locale, fuori casa
  // risponde quello pubblico.
  async function checkSaved() {
    const list = saved().slice(0, 6);
    const out = [];
    for (const d of list) {
      const lan = d.base || (d.lan ? 'http://' + d.lan + ':' + (d.port || DEFAULT_PORT) : '');
      const pub = d.publicUrl || '';
      let lanOk = false, pubOk = false, info = null;
      if (lan) { info = await probeSmart(lan, 1400); lanOk = !!info; }
      if (pub && !lanOk) { info = await probeSmart(pub, 3000); pubOk = !!info; }
      if (lanOk || pubOk) {
        const merged = normalize(info, lanOk ? lan : pub);
        merged.id = d.id || merged.id;
        merged.base = lanOk ? lan : pub;
        merged.lanOk = lanOk;
        merged.publicOk = pubOk;
        merged.online = true;
        remember(merged);
        out.push(merged);
      } else if (lan || pub) {
        out.push(Object.assign({}, d, { base: lan || pub, online: false }));
      }
    }
    return out;
  }

  // Per l'indirizzo della pagina corrente conviene usare un percorso relativo:
  // funziona sempre, anche quando il browser blocca le richieste verso la rete privata.
  async function probeSmart(base, timeoutMs) {
    if (base === currentBase()) {
      try {
        const r = await fetch('/api/discover', { cache: 'no-store', credentials: 'omit' });
        if (r.ok) {
          const d = await r.json();
          if (d && d.app === 'NexaRemote' && d.ok) return normalize(d, base);
        }
        return null;
      } catch (e) { return null; }
    }
    return probeBase(base, timeoutMs);
  }

  // L'indirizzo da usare per questa pagina: quello da cui e aperta, se risponde.
  async function here() {
    const d = await probeSmart(currentBase(), 2000);
    if (d) { remember(d); return d; }
    return null;
  }

  return { saved, remember, forget, scan, scanSubnet, checkSaved, here, probeBase, probeSmart, localIp, currentBase, DEFAULT_PORT };
})();

if (typeof window !== 'undefined') window.DisCo = DisCo;
