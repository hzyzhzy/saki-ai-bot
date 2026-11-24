@echo off
rem ⚠️ 静默版：由 explorer 起的，不在 DSH 的 Job 里、也在用户桌面会话里
start "" "C:\Program Files\Tencent\QQNT\QQ.exe" --force-renderer-accessibility
exit /b 0
