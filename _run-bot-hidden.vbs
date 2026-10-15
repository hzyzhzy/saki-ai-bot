' 2026-09-17: run the bot FULLY hidden (no cmd window at all).
' Why: the user reported a cmd window popping up showing the proxy check
'      output. That window came from starting _run-bot.bat with a normal
'      console.
' 2026-10-16: now takes an optional account argument, e.g.
'      wscript.exe //nologo _run-bot-hidden.vbs 10000014
'      Before this it was hardcoded without arguments, so the watchdog
'      could not use it for multi-account and fell back to PowerShell's
'      -WindowStyle Hidden -- which still pops a cmd window on PS 5.1.
' Usage: wscript.exe //nologo _run-bot-hidden.vbs [account]
' The 0 in sh.Run means "hidden window", False means "do not wait".
Option Explicit
Dim fso, sh, base, qq
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
qq = ""
If WScript.Arguments.Count > 0 Then qq = " " & WScript.Arguments(0)
sh.Run "cmd /c """ & base & "\_run-bot.bat""" & qq, 0, False
