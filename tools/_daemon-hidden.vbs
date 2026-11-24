' 在**座位里**隐藏地起 daemon（零控制台窗口）
'
' 为什么需要它：`anode run python.exe ...` 起的是**控制台程序**，
'   会在座位桌面上留一个黑窗（用户明确说过不许起黑窗，2026-11-22 实测又冒出来了：
'   截图里左上角那个 `SyntaxWarning: invalid escape sequence '\T'` 就是它）✗
'   而 dbenv 里没有 pythonw.exe ⇒ 只能用 wscript 的 `Run(..., 0, False)` 包一层。
'
' 用法（主机侧）：
'   anode --agent dsh --lease TOKEN run wscript.exe "C:\...\tools\_daemon-hidden.vbs"
'
' ⚠️ 不传 --hwnd：daemon 自己 `find_qq_window()` 会按昵称找 Saki 的窗口
'    （传死 hwnd 反而危险 —— 窗口一变它就"读不到聊天区"，还会误判瞎、去重启 QQ）

Option Explicit
Dim fso, sh, here, root, py, launcher, pyArgs

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

here = fso.GetParentFolderName(WScript.ScriptFullName)          ' ...\qq-ai-bot\tools
root = fso.GetParentFolderName(here)                            ' ...\qq-ai-bot
py = "C:\Temp\dbenv\Scripts\python.exe"
launcher = here & "\qq-daemon-launch.py"

If Not fso.FileExists(launcher) Then
    sh.LogEvent 1, "找不到 " & launcher
    WScript.Quit 1
End If

sh.CurrentDirectory = here
' ⚠️ `--me Anon`（2026-11-21）——
'    daemon 靠 `me` 判断"这句是不是她自己说的"（`m.self` 过滤）。
'    不传就默认 `Saki`，而座位里现在登的是 **Anon**
'    ⇒ 实测：Anon 自己说的话被当成"别人发的"推回给她（日志 `收到(daemon) · 「Anon」 诶`）✗
'    ⚠️ 换号时这里必须一起改（或者以后让 daemon 自己读窗口昵称当 me）。
pyArgs = """" & py & """ """ & launcher & """ --port 6701 --me Anon"

' 0 = 隐藏窗口，False = 不等它结束（daemon 是常驻）
sh.Run pyArgs, 0, False
