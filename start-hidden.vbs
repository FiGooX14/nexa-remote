Set sh = CreateObject("WScript.Shell")
' Avvia NexaRemote col comando globale npm (nessuna cartella del progetto).
' I dati stanno in %USERPROFILE%\.nexaremote
sh.Run "cmd /c %APPDATA%\npm\nexaremote.cmd --no-browser", 0, False
