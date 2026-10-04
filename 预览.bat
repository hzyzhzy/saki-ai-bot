@echo off
chcp 65001 >nul
title 预览一下（客服小祥）
cd /d "%~dp0"

REM ============================================================
REM  ⚠️ 别直接双击 test 里的 .js 文件！
REM     Windows 会把 .js 交给「Microsoft JScript」引擎跑，
REM     于是弹一个「Microsoft JScript 编译错误 / 语法错误 / 800A03EA」
REM     —— 那个报错跟脚本本身没关系，是**用错解释器**了。
REM     双击这个 bat 才对了（它会用 node 跑）。
REM ============================================================

if not exist logs mkdir logs

echo.
echo   ╔══════════════════════════════════════════════╗
echo   ║        客服小祥 · 预览 / 自检                ║
echo   ╚══════════════════════════════════════════════╝
echo.
echo    1  月末工资单    这个月会发到群和 QQ空间的那段字
echo    2  工资提醒      余额不够时她会说什么（含 @ 效果）
echo    3  当前账本      花了多少 / 工资多少 / token
echo    4  起始账        账本建好之前补记了多少
echo    5  跑完整回归    12 套（约 2.5 分钟）
echo.
echo    0  退出
echo.
set "PICK="
set /p "PICK=  输入数字后回车："

if "%PICK%"=="1" goto monthly
if "%PICK%"=="2" goto balance
if "%PICK%"=="3" goto spend
if "%PICK%"=="4" goto base
if "%PICK%"=="5" goto regress
goto done

:monthly
echo.
call :run test\preview-monthly.js
goto hold

:balance
echo.
call :run test\preview-balance.js
goto hold

:spend
echo.
call :run -e "import('./src/spend.js').then(function(m){console.log(m.spendText('month'));console.log();console.log(m.spendText('day'));})"
goto hold

:base
echo.
call :run -e "import('./src/spend.js').then(function(m){var b=m.baselineOf();console.log('起始账：');console.log(JSON.stringify(b,null,2));console.log();console.log(m.spendText('month'));})"
goto hold

:regress
echo.
echo   回归要 2 分半，输出会存到 logs\test-*.log
echo.
call :run test\run-all.js
goto hold

:run
REM ⚠️ 优先用 PATH 里的 node；没有再退回几个常见位置。
REM    这台机器上 DSH 自己带了一个 node，所以最后那条兜底是有用的。
set "NODEEXE="
for %%I in (node.exe) do if not defined NODEEXE if exist "%%~$PATH:I" set "NODEEXE=%%~$PATH:I"
if not defined NODEEXE if exist "%LOCALAPPDATA%\Programs\DeepSeekHarness\node\node.exe" set "NODEEXE=%LOCALAPPDATA%\Programs\DeepSeekHarness\node\node.exe"
if not defined NODEEXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODEEXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODEEXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODEEXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODEEXE (
  echo   ❌ 找不到 node.exe。
  echo      要么装一个 Node.js，要么把这个 bat 里的路径改成你的 node 位置。
  exit /b 1
)
REM ⚠️ 本机代理要排掉，不然脚本里连 127.0.0.1 的假服务会走代理失败
set "NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=127.0.0.1,localhost,::1"
"%NODEEXE%" %*
exit /b %errorlevel%

:hold
echo.
echo   ────────────────────────────────────────────
pause
goto done

:done
echo.
echo   关了。
REM ⚠️ 这里不用 timeout —— 它在本机某些环境下会报
REM    「Input redirection is not supported」。
ping -n 2 -w 1000 127.0.0.1 >nul
exit /b 0
