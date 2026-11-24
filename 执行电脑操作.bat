@echo off
rem ⚠️ 2026-11-14：**按需启动的"电脑操作"执行器** —— 跑完就退出，不留常驻进程。
rem
rem ## 为什么不常驻
rem   用户要求：「进程需要时自动启动，发完自动关闭」。
rem   ⇒ 这个 bat **每次只处理一次任务**（C:\Temp\cu-host\task.json），
rem     处理完把任务删掉、写结果、进程退出。
rem
rem ## 为什么必须由 explorer 起
rem   QQ 的键鼠只能打到**前台窗口**，而 Windows 只允许**前台进程**调用 SetForegroundWindow。
rem   从 DSH 的子进程里发起 ⇒ 天生不是前台 ⇒ 抢不到（实测前台一直是 DSH，键鼠全打歪）。
rem   由 explorer 起的进程在用户桌面会话里、是前台 ⇒ 能抢到 ✓
rem
rem ## 谁调它
rem   `node tools\qq-client.mjs send ...` 会写好任务文件，然后用
rem   `explorer.exe 执行电脑操作.bat` 把它拉起来，再轮询 result.json。

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\cu-host.ps1" -Task "C:\Temp\cu-host\task.json" -Out "C:\Temp\cu-host\result.json"
exit /b 0
