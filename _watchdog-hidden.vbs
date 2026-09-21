' 只起看门狗，**完全隐藏**地跑（2026-09-20 加）。
'
' 为什么单独做一个 vbs（而不复用 _autostart-hidden.vbs）：
'   _autostart-hidden.vbs 跑的是 autostart.ps1 —— 那一整套会
'   等 OneDrive → 等网络 → 调 start-all.ps1（**按 PID 停掉正在跑的机器人再起**）→ 才交给看门狗。
'   也就是说：只想"补一个看门狗"的时候用它，会白白把机器人重启一次
'   （重启 = 一次 QQ 登录，这个号是风险设备，能不烧就不烧）。
'   这个文件只做一件事：把 watchdog.ps1 在**用户会话里、窗口隐藏**下拉起来。
'
' 用法：**双击它就行**（或者在用户会话里跑）—— 看门狗在隐藏窗口里起来、不弹控制台。
' ⚠️ **不能用 WMI 调它**（2026-09-20 实测：35 秒后什么都没有）——
'    那个环境是**非交互式窗口站**，PowerShell 在里面起不来。
'    见 AGENTS.md「WMI 起不了 PowerShell 脚本」那节。
'
' ⚠️ 为什么必须走 wscript（而不是让 WMI 直接起 powershell）：
'   WMI 直接创建的进程跑在**非交互式窗口站**里，PowerShell 起不来
'   （实测：进程存在过、5 秒就没，watchdog.log 一行都不写）。
'   而 wscript 的 Run(..., 0, False) 是在**用户会话**里起的、只是把窗口隐藏 —— 这是
'   开机自启那条链一直在用的方式（autostart.log 里 09-20 12:03 那次它连续工作了几小时）。
Option Explicit
Dim fso, sh, base
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
' 目录从脚本自己的位置推 —— 整个文件夹搬到哪都能用
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
' 0 = 隐藏窗口，False = 不等它跑完（看门狗是常驻的，等它就永远不返回）
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & base & "\watchdog.ps1""", 0, False
