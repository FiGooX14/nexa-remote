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

Il modo più semplice, senza cartelle e senza file da toccare:

```
npm install -g @nexa-tech/nexa-remote
```

Poi, da **qualsiasi cartella**, scrivi:

```
nexaremote
```

Il server parte e si apre il browser. I tuoi dati (account, codici, pulsanti) vengono creati nella cartella `~/.nexaremote` della tua home: nel PC non resta nessuna cartella del progetto.

Comandi utili:

- `nexaremote` — avvia il telecomando e apre il browser
- `nexaremote --porta 3002` — sceglie la porta (default 3002)
- `nexaremote --no-browser` — non apre il browser
- `nexaremote --info` — mostra dove stanno i dati, l'indirizzo in casa e quello pubblico
- `nexaremote --help` — l'elenco dei comandi

### Installazione manuale (alternativa)

1. Scarica il progetto: clic su **Code → Download ZIP** in https://github.com/FiGooX14/nexa-remote (oppure `git clone`).
2. Entra nella cartella e digita `npm install`.
3. Avvia con `node server.js` (oppure doppio click su `Avvia-NexaRemote.bat`).

## Avvio

- **Installato con npm**: scrivi `nexaremote` da qualsiasi cartella.
- **Windows (installazione manuale)**: doppio click su `Avvia-NexaRemote.bat` (tieni la finestra aperta).
- **Mac (installazione manuale)**: dal Terminale, nella cartella del progetto, scrivi `node server.js`.

Il server stampa un indirizzo del tipo `http://192.168.x.x:3002`: è l'indirizzo da aprire dal telefono.

## Collegare il telefono

Il collegamento è semplice e **non cerca niente nella Wi-Fi**: nel telefono compare un codice e nel computer lo si digita.

1. Sul **telefono** apri l'indirizzo del PC e crea il tuo account (il primo account è l'amministratore del server). Subito dopo ti viene mostrato un **codice di 6 cifre**.
2. Sul **computer** apri la pagina del codice all'indirizzo `http://192.168.x.x:3002/pc` (fuori casa, l'indirizzo pubblico finito con `/pc`). Non serve registrarsi.
3. Digita lì il codice del telefono e premi **Continua**. Il computer chiede *"Sei sicuro di voler connettere?"*: scegli **CONFERMA** (con **Annulla** non viene collegato nulla).
4. Il telefono si collega da solo e apre il telecomando.

Il codice scade dopo 5 minuti e si usa una volta sola. Il collegamento resta salvato: le volte dopo l'app apre direttamente il telecomando. Non serve installare niente sul telefono, basta aggiungere l'app alla home (Android: menu del browser → *Installa app*; iPhone: *Condividi → Aggiungi alla Home*).

### Personalizzare

- **Nome del PC**: crea il file `data/device.json` nella cartella dei dati con `{"name": "PC di Lorenzo"}` (se non c'è viene usato il nome del computer). Con l'installazione npm la cartella dati è `~/.nexaremote/data`.
- **Indirizzo pubblico** (per usarlo fuori casa): scrivi l'indirizzo completo in `data/public-url.txt`, una riga sola, es. `https://esempio.it`. Oppure la variabile `PUBLIC_URL` nel `.env`.
- **Fuori casa con HTTPS (Tailscale)**: metti i file del certificato (`.crt` e `.key`) nella cartella `certs` della tua home: vengono usati automaticamente. Guida: `COME-COLLEGARSI-TAILSCALE.txt`.

## Sicurezza

- Chiavi e sessione stanno nel file `.env` del server (mai nel repository).
- Il terminale remoto blocca i comandi pericolosi (`format`, `diskpart`, `Reset-Computer`, ...). Puoi aggiungerne altri in `BLOCKED_TERMS` nel `.env`.
- L'accesso ha un limite di 5 tentativi sbagliati ogni 15 minuti.

## Per chi sviluppa: come si pubblica una nuova versione

La pubblicazione su npm è **automatica** e non usa né token né codici: npm si fida di GitHub Actions
(Trusted Publishing con OIDC), quindi non esiste nessun segreto da tenere al sicuro.

Il file è `.github/workflows/publish.yml`. Per pubblicare:

1. aggiorna la `version` in `package.json`;
2. crea il tag con lo stesso numero (`git tag v0.1.2`);
3. fai il push del tag (`git push origin v0.1.2`).

GitHub Actions fa il resto e npm rende visibile la versione in pochi secondi.
Il workflow controlla prima che la versione non sia già online e, se lo è, si ferma con un errore chiaro.

---

(c) Nexatech — tutti i diritti riservati.