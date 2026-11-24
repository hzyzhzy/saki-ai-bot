// ⚠️ 2026-11-20：**内存整理**（把不重要进程的工作集刷进页面文件）
//   用户要求：「如果因为内存不够就执行一次内存清理，可以把不重要的进程比如把不重要的进程移动进虚拟内存」
//   ⚠️ 写成独立 .ps1 文件跑 —— `Add-Type -TypeDefinition @"..."@` 的 here-string **必须独占一行**，
//      在 node 里用 `;` 拼成一行会直接语法错（实测踩过）
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';

const SCRIPT_DIR = join(process.env.TEMP || 'C:\\Windows\\Temp', 'saki-tools');

const PS = `# 把"不重要"的浏览器/聊天/壁纸类进程的工作集刷进页面文件（进程不死，只是暂时变慢）
# ⚠️ 只碰白名单里的：java(MC服务端) / llama-server / node / explorer / 系统进程 一律不动
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class MemTrim {
  [DllImport("psapi.dll")] public static extern bool EmptyWorkingSet(IntPtr h);
}
"@

$pats = @('msedge','chrome','weixin','wechat','qq','telegram','wallpaper','onedrive','searchhost','textinputhost','copilot')
$n = 0
$freed = 0
foreach ($p in Get-Process -ErrorAction SilentlyContinue) {
  $nm = $p.ProcessName.ToLower()
  $hit = $false
  foreach ($x in $pats) { if ($nm -like "*$x*") { $hit = $true; break } }
  if (-not $hit) { continue }
  try {
    $b = $p.WorkingSet64
    [void][MemTrim]::EmptyWorkingSet($p.Handle)
    Start-Sleep -Milliseconds 40
    $a = (Get-Process -Id $p.Id -ErrorAction SilentlyContinue).WorkingSet64
    if ($a -lt $b) { $freed += ($b - $a); $n++ }
  } catch {}
}
"$n|$([math]::Round($freed/1MB))"
`;

/** 跑一次内存整理，返回 { ok, processes, freedMB } */
export function trimMemoryNow() {
  try {
    if (!existsSync(SCRIPT_DIR)) mkdirSync(SCRIPT_DIR, { recursive: true });
    const f = join(SCRIPT_DIR, 'trim-memory.ps1');
    // ⚠️ 用 WriteAllText 写（无 BOM；PowerShell 5.1 的 utf8 会带 BOM 让脚本第 1 行失效）
    writeFileSync(f, PS, 'utf8');
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', f],
      {
        encoding: 'utf8',
        timeout: 40000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
    const [count, freedMB] = String(out).split('|');
    return { ok: true, processes: Number(count) || 0, freedMB: Number(freedMB) || 0 };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

export { SCRIPT_DIR };
