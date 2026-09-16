/** 探测：Node 能拿到哪些电脑状态 */
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { statfsSync } from 'node:fs';

const gb = (n) => (n / 1024 ** 3).toFixed(1);

console.log('=== Node 内置 os ===');
console.log('主机名   :', os.hostname());
console.log('平台     :', os.platform(), os.release(), os.arch());
console.log('CPU      :', os.cpus()[0]?.model);
console.log('CPU 核数 :', os.cpus().length);
console.log('总内存   :', gb(os.totalmem()), 'GB');
console.log('空闲内存 :', gb(os.freemem()), 'GB');
console.log('已用内存 :', gb(os.totalmem() - os.freemem()), 'GB');
console.log('开机时长 :', ((os.uptime()) / 3600).toFixed(1), '小时');
console.log('负载     :', os.loadavg().map((x) => x.toFixed(2)).join(', '));

console.log('\n=== 磁盘 ===');
try {
  const s = statfsSync('C:');
  console.log('C 盘总量 :', gb(s.blocks * s.bsize), 'GB');
  console.log('C 盘可用 :', gb(s.bavail * s.bsize), 'GB');
} catch (e) {
  console.log('statfs 失败:', e.message);
}

console.log('\n=== 电池（PowerShell） ===');
try {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress',
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  console.log('结果:', out.trim() || '（没有输出）');
} catch (e) {
  console.log('失败:', e.message);
}

console.log('\n=== CPU 负载（PowerShell） ===');
try {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    ],
    { encoding: 'utf8', timeout: 15000 },
  );
  console.log('CPU 使用率:', out.trim(), '%');
} catch (e) {
  console.log('失败:', e.message);
}

console.log('\n=== 显卡（PowerShell） ===');
try {
  const out = execFileSync(
    'powershell',
    ['-NoProfile', '-Command', '(Get-CimInstance Win32_VideoController | Select-Object -First 1).Name'],
    { encoding: 'utf8', timeout: 15000 },
  );
  console.log('显卡:', out.trim());
} catch (e) {
  console.log('失败:', e.message);
}
