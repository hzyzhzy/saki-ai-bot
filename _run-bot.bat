@echo off
rem 启动机器人并把日志写进 logs\bot.log。
rem 单独做成一个文件是为了避开 cmd /c start 的多层引号转义问题。
cd /d "%~dp0"
if not exist "logs" mkdir "logs"

rem ── 让 node 走系统代理（2026-09-12 加）──────────────────────────
rem ⚠️ 为什么需要：**node 的 fetch 不会自动用系统代理**，
rem    而 PowerShell 的 Invoke-WebRequest 会 —— 所以之前实测
rem    「只有 Bing 能连、DuckDuckGo 连不上」其实是这个原因造成的假象。
rem    加上这两个变量后 node 能走代理：DuckDuckGo 通了，Bing 也照样通。
rem
rem ⚠️ NODE_USE_ENV_PROXY 是 Node 24 才支持的开关（让 fetch 认 HTTP(S)_PROXY）。
rem
rem ⚠️⚠️ **必须加 NO_PROXY 排除本机**（不然会砸掉自己的服务）：
rem    NODE_USE_ENV_PROXY 会让 node 的**所有** HTTP 请求都走代理 ——
rem    包括访问本机的东西（模型 API、NapCat 的接口）。
rem    代理不认识 127.0.0.1 就会失败，表现为「模型全部超时、机器人哑掉」。
rem    实测：不加 NO_PROXY，回归里 5 个测试套件全挂。
rem ⚠️⚠️ 2026-09-16 深夜：**这三行注释掉了** —— 当时「机器人忽然不能聊天」就是这个原因：
rem    机器人被强制走本地代理 127.0.0.1:7890，而**代理软件没开** →
rem    每个模型请求都是 ECONNREFUSED（日志 `失败底层原因：ECONNREFUSED`）。
rem    实测 **DeepSeek 国内直连就行**（200 / 664ms），不用代理更稳。
rem ⚠️ 所以这里默认**直连**。哪天网络环境变成"必须走代理"，再把下面三行放开。
rem    （Node 24 才认 `NODE_USE_ENV_PROXY`；放开时代理端口要跟你的软件对上。）
rem set "HTTP_PROXY=http://127.0.0.1:7890"
rem set "HTTPS_PROXY=http://127.0.0.1:7890"
rem set "NODE_USE_ENV_PROXY=1"
rem ⚠️⚠️ 2026-09-16 深夜：**改成"自动选出口"**（用户要求：「要能自动切换网络，比如关掉代理」）。
rem    那晚的故障：这里写死 `HTTPS_PROXY=127.0.0.1:7890`，而**代理软件没开**
rem    → 每个模型请求 ECONNREFUSED，机器人整晚不能聊天。
rem    现在：**启动时探一下 7890 通不通** —— 通就走代理，不通就自动直连。
rem    ⚠️ 必须在**启动 node 之前**决定：`NODE_USE_ENV_PROXY` 只在
rem       **node 刚起来时**生效，进了 index.js 再设就晚了。
rem    ⚠️ 判断端口**不要**用 `for /f` 包 powershell（拿不到退出码）——
rem       照 AGENTS 里的老办法：**写临时文件再读**。
set "PCHK=%TEMP%\_qqbot_proxy_check.txt"
rem ⚠️ 用 **node** 探（它一定在，而且没有 cmd→powershell 的嵌套引号问题；
rem    第一版用 powershell -Command "…TcpClient…" 实测写出来是空的）。
node -e "const n=require('net');const s=n.connect(7890,'127.0.0.1');s.setTimeout(400);s.on('connect',()=>{console.log(1);s.destroy()});s.on('timeout',()=>{console.log(0);s.destroy()});s.on('error',()=>{console.log(0)})" > "%PCHK%" 2>nul
set "PROXYUP=0"
if exist "%PCHK%" set /p PROXYUP=<"%PCHK%"
del "%PCHK%" >nul 2>&1
if "%PROXYUP%"=="1" (
  set "HTTP_PROXY=http://127.0.0.1:7890"
  set "HTTPS_PROXY=http://127.0.0.1:7890"
  set "NODE_USE_ENV_PROXY=1"
) else (
  set "HTTP_PROXY="
  set "HTTPS_PROXY="
  set "ALL_PROXY="
  set "NODE_USE_ENV_PROXY="
)
rem ⚠️ 2026-09-17 用户要求：「这个不要显示出来，要完全后台隐藏运行」——
rem    这两行原来各有一句 `echo [net] … 通/不通`，会**在窗口里显示出来**，已删。
rem    探测结果照样能查：机器人启动日志里有一行「大模型出口：直连 / 走代理 xxx」。
rem ⚠️ 这两行**留着**：走代理时必须用它排除本机（不然会砸掉自己的服务）。
set "NO_PROXY=127.0.0.1,localhost,::1"
set "no_proxy=127.0.0.1,localhost,::1"

node src\index.js > "logs\bot.log" 2>&1
