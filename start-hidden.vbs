Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "E:\Nexatech\nexa-remote"
sh.Run "node.exe server.js", 0, False