# 一键启动「NapCat + 机器人 + 看门狗」
#
# 和「一键启动（QQ+机器人）.bat」的区别：
#   那个启动完就退出（服务跑着，但没人看着）
#   这个启动完**不退出**，留一个窗口持续盯着，挂了自动拉起来
#
# 用法：双击「一键启动+看门狗.bat」，然后让这个窗口一直开着。

$ErrorActionPreference = 'Continue'
$BotDir = $PSScriptRoot
# ⚠️ NapCat 目录**不要写死绝对路径**：默认 = 本项目**上一级**下的 napcat\NapCat.Shell，
#    也可以用环境变量 NAPCAT_DIR 覆盖。
$NapCatDir = if ($env:NAPCAT_DIR) { $env:NAPCAT_DIR } else { Join-Path (Split-Path -Parent $PSScriptRoot) 'napcat\NapCat.Shell' }

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  一键启动：QQ 协议端 + 客服小祥 + 看门狗' -ForegroundColor Cyan
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''

# 先正常启动一轮
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $BotDir 'start-all.ps1') -NoOpenUi

Write-Host ''
Write-Host '--------------------------------------------' -ForegroundColor Yellow
Write-Host ' 启动完成，接下来交给看门狗盯着。' -ForegroundColor Yellow
Write-Host ' 这个窗口不要关 —— 关了就没有自动恢复了。' -ForegroundColor Yellow
Write-Host '--------------------------------------------' -ForegroundColor Yellow
Write-Host ''

# 然后把看门狗接上（前台跑，所以这个窗口会一直留着）
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $BotDir 'watchdog.ps1')
