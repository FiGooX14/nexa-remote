# Backup record DNS di nexatech.it (prima del passaggio a Cloudflare)

Data del dump: 26/09/2026
Nameserver attuali: dns1.unitedhost.eu / dns2.unitedhost.eu
IP hosting: 185.11.193.25

## Record da ricreare su Cloudflare

| Nome | Tipo | Valore | Proxy | Serve per |
|---|---|---|---|---|
| @ | A | 185.11.193.25 | DNS only (grigio) | sito WordPress / hosting unitedhost |
| @ | MX | 10 nexatech-it.mail.protection.outlook.com | DNS only | email Microsoft 365 |
| @ | TXT | `v=spf1 include:spf.protection.outlook.com -all` | - | SPF email |
| @ | TXT | `MS=ms86339512` | - | verifica dominio su Microsoft 365 |
| www | CNAME | nexatech.it | DNS only | sito |
| mail | A | 212.183.164.51 | DNS only | mail server (IMAP/SMTP) |
| webmail | A | 185.4.142.59 | DNS only | webmail |
| autodiscover | CNAME | autodiscover.outlook.com | DNS only | configurazione automatica Outlook |
| selector1._domainkey | CNAME | selector1-nexatech-it._domainkey.nexasrl.q-v1.dkim.mail.microsoft.com | DNS only | DKIM (firma email) |
| selector2._domainkey | CNAME | selector2-nexatech-it._domainkey.nexasrl.q-v1.dkim.mail.microsoft.com | DNS only | DKIM (firma email) |
| _dmarc | TXT | `v=DMARC1; p=quarantine; adkim=s; aspf=s` | - | antifalsificazione email |

## Cosa NON ricreare
I record `www MX/TXT`, `www NS`, `www CAA`, `www SRV` che compaiono nelle query sono
solo risultati ereditati dal record CNAME: non vanno ricreati a mano.

## Attenzione
- I record email (MX, TXT, DKIM, DMARC) devono restare "DNS only": se passano dal
  proxy di Cloudflare la posta smette di funzionare.
- Se in futuro si tocca il dominio dentro Microsoft 365 le chiavi DKIM possono
  cambiare: in quel caso rileggere i record da qui e aggiornarli.

## Tunnel NexaRemote (creato dopo il passaggio a Cloudflare)
- Tipo: Cloudflare Tunnel (named tunnel) in locale sul PC
- Hostname: remote.nexatech.it
- Servizio locale: http://127.0.0.1:3002 (NexaRemote, porta 3002 in chiaro)
- Eseguibile: tools\cloudflared.exe
- Avvio: servizio Windows "cloudflared" + shortcut nella cartella Avvio
