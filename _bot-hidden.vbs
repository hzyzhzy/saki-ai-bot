' 隐藏启动一个号的机器人（2026-11-07 加）。
'
' 为什么必须走 wscript，而不是直接 WMI 起 cmd/node：
'   2026-11-07 用户原话：「**你弹一次到前台我就关一次**」——
'   我用 `Invoke-CimMethod Win32_Process Create` 起的 `cmd.exe /c _run-bot.bat`，
'   cmd 窗口**弹到他桌面上了**，他关掉 ⇒ 机器人跟着死 ⇒ 三个号全灭 ✗
'   （AGENTS 里"WMI 起的没有窗口"那条，在 `cmd /c` 这种情况下不成立）
'
' 现在这条路：WMI 起 wscript（它自己没有窗口）→ 这里 `Run(..., 0, False)`
'   明确要求 **0 = 隐藏窗口、False = 不等它跑完** ⇒ 桌面上什么都不出现 ✓
'
' 用法（在用户会话里）：
'   wscript.exe //nologo "_bot-hidden.vbs" 10000002
'   ⚠️ 不带参数 = 老行为（由 config.yml 的 mainAccount 决定）
Option Explicit
Dim fso, sh, base, uin, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
' 目录从脚本自己位置推 —— 整个文件夹搬到哪都能用
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
uin = ""
If WScript.Arguments.Count > 0 Then uin = WScript.Arguments(0)
cmd = "cmd.exe /c _run-bot.bat " & uin
' 0 = 隐藏窗口；False = 不等它结束
sh.Run cmd, 0, False
