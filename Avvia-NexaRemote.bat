@echo off
cd /d "%~dp0"
title NexaRemote - Nexatech
echo ============================================
echo   NexaRemote - Nexatech
echo   Il telecomando del tuo PC, dal tuo telefono
echo ============================================
echo.
echo Il server si sta avviando...
echo Tieni QUESTA finestra aperta mentre usi NexaRemote.
echo.
echo Dal telefono, sulla stessa rete Wi-Fi, apri:
echo   http://IP-DI-QUESTO-PC:3002
echo (l'IP esatto e' stampato qui sotto all'avvio)
echo.
echo Per fermare qui, chiudi la finestra.
echo.
node server.js
echo.
echo Il server si e' fermato.
pause