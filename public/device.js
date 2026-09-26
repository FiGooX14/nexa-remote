// Identificativo del dispositivo (telefono, computer, tablet).
// Viene salvato nel browser (e come copia in un cookie di lunga durata, cosi
// l'abbinamento col PC non si perde se il browser si resetta) e inviato al
// server con ogni richiesta: serve per il codice di abbinamento con il PC.
// Il codice si digita una volta sola: dopo, il dispositivo resta abbinato.
const NxaDevice = {
  key: 'nexa.deviceId',
  cookie: 'nexa_device',
  readCookie() {
    try {
      const m = document.cookie.match(/(?:^|;\s*)nexa_device=([^;]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  },
  writeCookie(v) {
    try {
      const d = new Date();
      d.setFullYear(d.getFullYear() + 10);
      document.cookie = 'nexa_device=' + encodeURIComponent(v) + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
    } catch (e) {}
  },
  id() {
    let v = '';
    try { v = localStorage.getItem(this.key) || ''; } catch (e) { v = ''; }
    if (!v) v = this.readCookie();
    if (!v) {
      v = 'nx-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      try { localStorage.setItem(this.key, v); } catch (e) {}
      this.writeCookie(v);
    } else {
      // tiene allineati i due posti dove e salvato
      try { if (localStorage.getItem(this.key) !== v) localStorage.setItem(this.key, v); } catch (e) {}
      this.writeCookie(v);
    }
    return v;
  },
  headers() {
    return { 'x-nexa-device': this.id() };
  },
  forget() {
    try { localStorage.removeItem(this.key); } catch (e) {}
  }
};
