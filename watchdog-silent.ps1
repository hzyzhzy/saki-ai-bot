$ErrorActionPreference = 'Continue'
$BotDir = $PSScriptRoot

# 已经在跑就不重复起
$running = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'watchdog\.ps1' })
if ($running.Count -gt 0) {
  exit 0
}

# ⚠️ 这里踩过两次坑，别改：
#
#   ① `Start-Process powershell -ArgumentList '-File', 'C:\...\OneDrive - yijia\...\watchdog.ps1'`
#      路径含空格，Start-Process 不给你加引号 → powershell 报
#      「Processing -File '<本机用户目录>\OneDrive' failed ... does not have a '.ps1' extension」
#   ② 手工拼 `-File "带空格的路径"` 交给 cmd 也一样会栽 ——
#      实测 `powershell -File "C:\a b\c.ps1"` 在有的调用方式下仍被截断。
#
# 稳妥做法：**切到脚本所在目录，用相对文件名调用**，路径里就没有空格了。
Start-Process -FilePath 'powershell.exe' `
  -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', 'watchdog.ps1' `
  -WorkingDirectory $BotDir `
  -WindowStyle Hidden
