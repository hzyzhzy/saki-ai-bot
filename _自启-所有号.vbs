' 开机自启用：**完全隐藏**地跑 _自启-所有号.ps1（所有号，含以后新增的）。
' 套路和主号那份 _autostart-hidden.vbs 一样：wscript + Run(..., 0, False)
' ⇒ 隐藏窗口、不等它跑完（这一套要跑好几分钟）。
'
' 注册表：HKCU\Software\Microsoft\Windows\CurrentVersion\Run 里的 SakiBot
' （任务管理器「启动」页能看到，随时可删）。
Option Explicit
Dim fso, sh, base
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & base & "\_自启-所有号.ps1""", 0, False