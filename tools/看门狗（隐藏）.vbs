' 客服小祥 · 看门狗（**完全隐藏**启动，单实例）
'
' 为什么单实例：多开几个看门狗会各自判定"卡死"、各自去重启，
' 互相踩 ⇒ 反而把好好的 daemon 反复杀掉。这里用 state\watchdog.lock 里的 pid 判活。
'
' 由 start-saki.ps1 自动拉起，也可以双击它手动起。

Option Explicit
Dim fso, sh, base, ps1, lockPath, f, pid, alive, i

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
base = fso.GetParentFolderName(WScript.ScriptFullName)
ps1 = base & "\watchdog.ps1"
lockPath = fso.GetParentFolderName(base) & "\state\watchdog.lock"

If Not fso.FileExists(ps1) Then
    MsgBox "找不到 " & ps1, 16, "客服小祥 · 看门狗"
    WScript.Quit 1
End If

' ── 单实例：lock 里的 pid 还活着就不重复起
If fso.FileExists(lockPath) Then
    On Error Resume Next
    Set f = fso.OpenTextFile(lockPath, 1)
    pid = Trim(f.ReadAll)
    f.Close
    On Error GoTo 0
    If pid <> "" Then
        alive = False
        On Error Resume Next
        Dim wmi, procs, p
        Set wmi = GetObject("winmgmts:\\.\root\cimv2")
        Set procs = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & pid)
        For Each p In procs
            alive = True
        Next
        On Error GoTo 0
        If alive Then
            WScript.Quit 0        ' 已经有一个在跑，静默退出
        End If
    End If
End If

sh.CurrentDirectory = base
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & ps1 & """", 0, False
' ⚠️ pid 由 watchdog.ps1 自己写进 lock（它才知道自己的 $PID），这里不写 —— 
'    原来这里写了个 0，`WHERE ProcessId=0` 永远查不到 ⇒ 等于没有单实例保护 ✗
