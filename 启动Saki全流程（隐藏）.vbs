' 客服小祥 · 全流程启动（**完全隐藏**，不弹黑窗）
'
' 用途：
'   ① 双击它 = 手动拉起全部（anode 席位 / 座位里的 QQ / daemon / 适配器 / bot 号）
'   ② 注册表开机自启也指向它（HKCU\Software\Microsoft\Windows\CurrentVersion\Run 里的 SakiBot）
'
' ⚠️ 为什么必须走 VBS：`powershell -File` 直接跑会弹一个黑控制台窗口，
'    用户明确说过「以后启动时不要起黑窗，用隐藏启动」（写进 AGENTS 了）。
'    VBS 的 Run(..., 0, False) = 0 号窗口（隐藏）+ 不等它跑完 ✓
'
' ⚠️ 日志不丢：脚本自己往 logs\start-saki.log 写，VBS 这边不需要重定向。

Option Explicit
Dim fso, sh, base, ps1
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = base & "\start-saki.ps1"

If Not fso.FileExists(ps1) Then
    MsgBox "找不到 " & ps1, 16, "客服小祥 · 全流程启动"
    WScript.Quit 1
End If

sh.CurrentDirectory = base
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
