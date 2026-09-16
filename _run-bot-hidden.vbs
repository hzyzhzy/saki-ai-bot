' 2026-09-17: run the bot FULLY hidden (no cmd window at all).
' Why: user reported a cmd window popping up showing "[net] 127.0.0.1:7890 ... -> direct".
'      That window came from starting _run-bot.bat with a normal console.
' Usage: wscript.exe //nologo _run-bot-hidden.vbs
'        (or WMI Win32_Process Create with this command line -> survives the caller)
' The 0 in sh.Run means "hidden window", False means "do not wait".
Option Explicit
Dim fso, sh, base
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
sh.Run "cmd /c """ & base & "\_run-bot.bat""", 0, False
