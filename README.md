# NexaRemote

Telecomando del tuo PC dal telefono, da qualunque browser. Progetto di **Nexatech — Le app del futuro**.

Con NexaRemote puoi, dal telefono:
- spegnere, riavviare, bloccare, sospendere il PC
- regolare volume e controlli musica/gestione presentazioni
- vedere lo schermo (foto e live) e l'audio del PC
- aprire e chiudere programmi
- usare il PC come touchpad e tastiera remota
- eseguire comandi da un terminale remoto (PowerShell)
- parlare nel microfono del telefono e farlo uscire dagli altoparlanti del PC

## Requisiti

- Un computer con **Windows 10/11** oppure **macOS** (le azioni di sistema sono per il computer dove parte il server).
- **Node.js 18 o superiore** installato: [nodejs.org](https://nodejs.org) (installa la versione LTS).
- Un telefono (Android o iPhone) con browser.

## Installazione

1. Scarica il progetto: clic su **Code → Download ZIP**, estrai la cartella (oppure `git clone https://github.com/FiGooX14/nexa-remote.git`).
2. Entra nella cartella del progetto.
3. Apri un terminale lì e digita:
   ```
   npm install
   ```
4. (Consigliato) Copia il file `.env.example` in `.env` e cambia `SESSION_SECRET` con una stringa lunga a caso.

## Avvio

- **Windows**: doppio click su `Avvia-NexaRemote.bat` (tieni la finestra aperta).
- **Mac**: dal Terminale, nella cartella del progetto, scrivi `node server.js`.

Il server stampa un indirizzo del tipo `http://192.168.x.x:3002`: è l'indirizzo da aprire dal telefono.

## Collegare il telefono

- **In casa**: telefono e PC sulla stessa Wi-Fi → dal browser del telefono apri l'indirizzo stampato (es. `http://192.168.x.x:3002`).
- **Fuori casa**: installa [Tailscale](https://tailscale.com) su PC e telefono, accedi con lo stesso account su entrambi, poi dal telefono apri `http://IP-tailscale-del-pc:3002` (il server resta raggiungibile ovunque ci sia internet).

Alla prima apertura registrati (nome, email, password): il primo account creato è l'unico amministratore del server.

## Sicurezza

- Chiavi e sessione stanno nel file `.env` del server (mai nel repository).
- Il terminale remoto blocca i comandi pericolosi (`format`, `diskpart`, `Reset-Computer`, ...). Puoi aggiungerne altri in `BLOCKED_TERMS` nel `.env`.
- L'accesso ha un limite di 5 tentativi sbagliati ogni 15 minuti.

---

(c) Nexatech — tutti i diritti riservati.