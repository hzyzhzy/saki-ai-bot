' 开机自启用：**完全隐藏**地跑 autostart.ps1。
'
' 为什么单独做一个 vbs：
'   autostart.ps1 会先等 OneDrive 同步完、等网络通，再启动并重试 3 轮，最后转看门狗 ——
'   这一整套要跑好几分钟，如果开机时弹一个黑框（或者用 cmd 起），用户会看到一个
'   关不掉的窗口。这里用 wscript + Run(..., 0, False)：窗口隐藏、不等它结束。
'   （和 _run-bot-hidden.vbs 同一个套路，那个是为了不弹 "[net] ..." 那个窗口。）
'
' ⚠️ 手写这个文件**没有用** —— 关键是把它的路径注册到开机自启里。
'    要开/关请在管理界面 http://127.0.0.1:3099 →「状态」→「开机自启」点开关。
'    那个开关写的是注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Run
'    （任务管理器的「启动」页里能看到，叫 SakiBot）。
Option Explicit
Dim fso, sh, base
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
' 目录从脚本自己的位置推 —— 这样整个文件夹搬到哪都能用
base = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = base
' 0 = 隐藏窗口，False = 不等它跑完
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & base & "\autostart.ps1""", 0, False
