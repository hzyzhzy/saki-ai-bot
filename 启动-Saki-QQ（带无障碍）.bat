@echo off
chcp 65001 >nul
rem ⚠️ 2026-11-14 加：**Saki 的 QQ 用这个启动，带无障碍（a11y）开关**
rem
rem ## 为什么
rem   我们要用 UIA 直接读 QQ 界面（不靠协议端、不靠截图 OCR）。QQ 是 Electron，
rem   Chromium 的 a11y 树**默认不建**——实测同一个 QQ 版本：
rem     · <主人> 大号那个进程（你正常交互过）→ uitree 读到 163 节点 / 61 条文字 ✓
rem     · Saki 这个进程（裸启动）        → uitree 只读到 10 节点 / 2 条文字 ✗
rem   加 `--force-renderer-accessibility` 是让 Chromium **强制建树**，
rem   不必等辅助技术来触发。
rem
rem ## 为什么必须你双击
rem   ⚠️ 我用 WMI / Start-Process 起的 QQ 都落在**非交互窗口站**或本会话的 Job 里：
rem     · WMI 起 → 窗口数是 0（界面根本不渲染）
rem     · Start-Process 起 → 我这条命令一结束它就被带走
rem   ⇒ 只有 explorer（也就是你双击）起的进程，才在你的桌面会话里、又不在我的 Job 里 ✓
rem
rem ## 起来之后
rem   登录（可能要手机确认），然后跟我说一声，我来验证：
rem     node tools\computer-use.mjs tree --hwnd ^<窗口句柄^> --depth 20 --nodes 3000
rem   节点数从 10 变成 150+ 就说明成了。
rem
rem ## ⚠️ 注意
rem   · 这个参数只影响渲染层，不改登录、不改任何数据
rem   · 机器人靠 SnowLuma 协议端跑，**关/重启 QQ 客户端不影响它说话** ✓

set "QQ=C:\Program Files\Tencent\QQNT\QQ.exe"

rem 只看"Saki 那个主实例"在不在（多开的三个号带 --from-multiple-login，不算）
set "RUNNING="
for /f "tokens=2 delims=," %%i in ('tasklist /fi "imagename eq QQ.exe" /fo csv /nh 2^>nul') do (
  set "RUNNING=1"
)
if defined RUNNING (
  echo [提示] 现在有 QQ.exe 在跑（可能是别的号，也可能是 Saki）。
  echo        如果 Saki 那个已经开着且界面正常，就不用管这个脚本。
  echo        要带参数重开 Saki，先手动退出**Saki 那个** QQ 窗口再双击这里。
  echo.
)

start "" "%QQ%" --force-renderer-accessibility
echo 已启动：QQ.exe --force-renderer-accessibility
echo 登录之后告诉我，我验证 a11y 树有没有建起来。
timeout /t 4 >nul
