' 零窗口启动客户端适配器（双击即可，不弹黑框）。
'
' ⚠️ 2026-11-17 用户明确要求：「以后启动时不要起黑窗，用隐藏启动」。
'    原来那条 `cmd.exe /c node tools\qq-onebot.mjs ...` 必然弹一个黑控制台，
'    还会被误按 ^C 杀掉（日志最后一行就是 `^C`）⇒ 改用 VBS 的 0 号窗口模式。
'
' ⚠️ 要停适配器：按 PID 停 6700 的持有者，别按命令行匹配（会杀到 DSH 自己的 runner）。

Dim sh, dir
Set sh = CreateObject("WScript.Shell")
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
dir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(dir)
sh.CurrentDirectory = dir

' 0 = 隐藏窗口，False = 不等待它结束
sh.Run "cmd /c node tools\qq-onebot.mjs --port 6700 --self 10000013 >> """ & dir & "\logs\qq-onebot.log"" 2>&1", 0, False
