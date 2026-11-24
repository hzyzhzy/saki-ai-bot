' 隐藏启动客户端适配器（零窗口）。
'
' ⚠️ 为什么不用 `cmd.exe /c node ...`：
'    那会弹一个**黑色控制台窗口**（2026-11-17 用户：「为什么非要开个黑窗啊，老是打断我」），
'    而且用户一不小心按到 ^C 就把适配器杀了（实测日志最后一行就是 `^C`）。
'
' ⚠️ 为什么不用 `Start-Process -WindowStyle Hidden`：
'    它起的进程会被调用方的 job 对象带走 —— 我这条命令一结束它就死。
'
' ⇒ 用 wscript 跑这个 VBS：`WScript.Shell.Run(..., 0, False)` 的 0 = **隐藏窗口**，
'   而且父进程是 wscript，不在我的 job 里，能活过我这条命令 ✓

Dim sh, dir, cmd
Set sh = CreateObject("WScript.Shell")
dir = "<项目目录>\qq-ai-bot"
sh.CurrentDirectory = dir

cmd = "cmd /c node tools\qq-onebot.mjs --port 6700 >> """ & dir & "\logs\qq-onebot.log"" 2>&1"
' 第二个参数 0 = 隐藏窗口；第三个参数 False = 不等待
sh.Run cmd, 0, False
