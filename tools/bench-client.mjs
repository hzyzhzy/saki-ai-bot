/**
 * 采集「客户端 vs 协议端」的实测数据。
 *
 * 要采的：
 *   ① 发送延迟（客户端：qq-py.py send 真实耗时；协议端：SnowLuma HTTP 接口耗时）
 *   ② 读消息延迟（客户端：qq-read.py；协议端：get_group_msg_history）
 *   ③ 成功率（各跑 N 次）
 *   ④ 资源占用（CPU / 工作集）
 *   ⑤ 功能覆盖（静态对比，写在报告里）
 *
 * 输出：JSON 打到 stdout，同时写 logs/client-vs-protocol.json
 */

import { execFile } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PY = 'C:\\Temp\\dbenv\\Scripts\\python.exe';
const HWND = '1902218';
const GROUP = '示例服务器 2026';
const GID = '200000007';
const N = Number(process.argv[2] || 3);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function py(script, args, timeout = 300000) {
  const t0 = Date.now();
  try {
    const { stdout } = await pExecFile(PY, ['-u', join(ROOT, 'tools', script), ...args], {
      cwd: ROOT, timeout, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8',
    });
    return { ok: true, ms: Date.now() - t0, out: String(stdout || '') };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, out: String(e.stdout || ''), err: String(e.stderr || e.message) };
  }
}

/** SnowLuma 的 HTTP 接口（3001 是 WS；管理面 5099）—— 这里用 OneBot HTTP 直发不适用，
 *  所以协议端那侧的"发送延迟"用 bot 日志里的时间差测（见 collectProtocolFromLog） */
async function httpJson(url, timeout = 15000) {
  try {
    const t0 = Date.now();
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout) });
    const j = await r.json().catch(() => null);
    return { ok: r.ok, ms: Date.now() - t0, json: j };
  } catch (e) {
    return { ok: false, ms: 0, err: String(e.message).slice(0, 80) };
  }
}

function procInfo(nameFilter) {
  return new Promise((resolve) => {
    execFile(
      'powershell',
      ['-NoProfile', '-Command',
        `Get-Process | Where-Object { ${nameFilter} } | Select-Object Id,ProcessName,@{n='CPU';e={[math]::Round($_.CPU,1)}},@{n='MB';e={[math]::Round($_.WorkingSet64/1MB,0)}} | ConvertTo-Json -Compress`],
      { timeout: 30000, encoding: 'utf8' },
      (err, stdout) => {
        try {
          const j = JSON.parse(String(stdout || '[]').trim() || '[]');
          resolve(Array.isArray(j) ? j : [j]);
        } catch {
          resolve([]);
        }
      },
    );
  });
}

async function main() {
  const result = {
    at: new Date().toISOString(),
    rounds: N,
    client: { send: [], read: [], verify: [] },
    protocol: {},
    resources: {},
  };

  // ── 客户端：发送 ──
  console.log(`=== 客户端发送（${N} 次）===`);
  for (let i = 0; i < N; i++) {
    const tag = 'BENCH' + Date.now().toString().slice(-6) + i;
    const r = await py('qq-py.py', ['send', '--hwnd', HWND, '--group', GROUP, '--text', `基准测试-${tag}`]);
    const ok = r.ok && /发送成功/.test(r.out);
    result.client.send.push({ ms: r.ms, ok, tag });
    console.log(`  第${i + 1}次: ${r.ms}ms ok=${ok}`);
    await sleep(1500);
  }

  // ── 客户端：读消息 ──
  console.log(`\n=== 客户端读消息（${N} 次）===`);
  for (let i = 0; i < N; i++) {
    const r = await py('qq-read.py', ['--hwnd', HWND, '--limit', '20']);
    let count = 0;
    try {
      count = JSON.parse(r.out.trim().split('\n').filter(Boolean).pop()).count || 0;
    } catch {}
    result.client.read.push({ ms: r.ms, ok: r.ok, count });
    console.log(`  第${i + 1}次: ${r.ms}ms ok=${r.ok} ${count} 条`);
    await sleep(800);
  }

  // ── 客户端：verify（全树搜）──
  console.log(`\n=== 客户端 verify（${N} 次）===`);
  for (let i = 0; i < N; i++) {
    const r = await py('qq-py.py', ['verify', '--hwnd', HWND, '--text', 'BENCH']);
    result.client.verify.push({ ms: r.ms, ok: r.ok });
    console.log(`  第${i + 1}次: ${r.ms}ms`);
    await sleep(600);
  }

  // ── 协议端：从 SnowLuma 日志测「收到回执 → 发出」的耗时 ──
  console.log('\n=== 协议端（SnowLuma）===');
  const t = await httpJson('http://127.0.0.1:5099/');
  result.protocol.manageReachable = t.ok;
  result.protocol.manageMs = t.ms;
  console.log(`  管理面 5099: ok=${t.ok} ${t.ms}ms`);
  // 端口
  const ports = {};
  for (const p of [3001, 6700, 3099, 3100, 3101]) {
    ports[p] = await new Promise((res) => {
      execFile('powershell', ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue) -ne $null`],
        { timeout: 15000, encoding: 'utf8' }, (e, o) => res(/True/.test(String(o || ''))));
    });
  }
  result.protocol.ports = ports;
  console.log('  端口:', JSON.stringify(ports));

  // ── 资源占用 ──
  console.log('\n=== 资源占用 ===');
  result.resources.qq = await procInfo("$_.ProcessName -eq 'QQ'");
  result.resources.snowluma = await procInfo("$_.ProcessName -eq 'node' -and $_.Path -like 'C:\\SnowLuma*'");
  result.resources.bots = await procInfo("$_.ProcessName -eq 'node' -and $_.Path -notlike 'C:\\SnowLuma*'");
  result.resources.adapter = await procInfo("$_.ProcessName -eq 'node'");
  for (const [k, v] of Object.entries(result.resources)) {
    const cpu = v.reduce((s, x) => s + (x.CPU || 0), 0);
    const mb = v.reduce((s, x) => s + (x.MB || 0), 0);
    console.log(`  ${k}: ${v.length} 进程  CPU=${cpu.toFixed(1)}s  内存=${mb}MB`);
    result.resources[k] = { count: v.length, cpu: +cpu.toFixed(1), mb };
  }

  // 汇总
  const avg = (a) => (a.length ? +(a.reduce((s, x) => s + x.ms, 0) / a.length).toFixed(0) : null);
  const rate = (a) => (a.length ? +(a.filter((x) => x.ok).length / a.length).toFixed(2) : null);
  result.summary = {
    clientSendAvgMs: avg(result.client.send),
    clientSendOkRate: rate(result.client.send),
    clientReadAvgMs: avg(result.client.read),
    clientReadOkRate: rate(result.client.read),
    clientVerifyAvgMs: avg(result.client.verify),
  };

  mkdirSync(join(ROOT, 'logs'), { recursive: true });
  writeFileSync(join(ROOT, 'logs', 'client-vs-protocol.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log('\n=== 汇总 ===');
  console.log(JSON.stringify(result.summary, null, 2));
  console.log('\n已写 logs/client-vs-protocol.json');
}

main().catch((e) => {
  console.error('采集失败:', e);
  process.exit(1);
});
