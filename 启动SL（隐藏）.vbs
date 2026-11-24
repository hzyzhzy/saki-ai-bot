' 客服小祥 · 纯 SL 启动（**完全隐藏**，不弹黑窗）
'
' 用途：
'   ① 双击它 = 拉起 SnowLuma（如果没起）+ 全部 bot 号
'   ② 注册表开机自启也指向它（HKCU\...\Run 里的 SakiBot）
'
' ⚠️ 2026-11-21 起**不再起 anode**：
'   用户决定「把爱音也先接进 sl，关掉 anode 模式，anode 模式作为技术储备吧，关闭 anode 自启」
'   ⇒ 老的「启动Saki全流程（隐藏）.vbs」会拉座位 + daemon + 适配器，那条路已停用。
'      要重新启用 anode，看 tools\anode模式-交接文档.md 的「四、如果以后要重新启用」。

Option Explicit
Dim fso, sh, base, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh  = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = base & "\start-sl.ps1"

If Not fso.FileExists(ps1) Then
    MsgBox "找不到 " & ps1, 16, "客服小祥 · 纯 SL 启动"
    WScript.Quit 1
End If

sh.CurrentDirectory = base
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False