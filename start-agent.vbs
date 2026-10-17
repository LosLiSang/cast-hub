' Starts cast-agent hidden at login.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = "C:\Users\lxtoa\Documents\code\cast-hub"
sh.Run """C:\Program Files\nodejs\node.exe"" ""C:\Users\lxtoa\Documents\code\cast-hub\src\agent.mjs""", 0, False
