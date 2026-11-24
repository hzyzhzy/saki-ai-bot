@echo off
rem ⚠️ 这个 .bat 自己**不要双击**用（双击会闪一下黑框）。
rem    真正零窗口的入口是同目录的 `启动适配器（隐藏）.vbs`，或者：
rem        wscript.exe "tools\启动适配器（隐藏）.vbs"
rem
rem 2026-11-17：用户明确说过「为什么非要开个黑窗啊，老是打断我」，
rem 而原来我起适配器用的 `cmd.exe /c node ...` **必然弹黑窗**，
rem 还被按到 ^C 杀过一次（日志最后一行就是 `^C`）⇒ 全部改成 VBS 隐藏启动。
cd /d "%~dp0.."
node tools\qq-onebot.mjs --port 6700
