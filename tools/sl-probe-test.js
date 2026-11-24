// 实测：对着本机真实 QQ 进程跑一遍探测逻辑（不注入、不动 QQ）
// 逻辑和 packages/bridge/src/qq-port-probe.ts 一致，只是独立跑一遍看结果

const { exec } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const { promisify } = require('node:util');

const execAsync = promisify(exec);
const CONNECTION_TIMEOUT_MS = 500;
const COMMAND_TIMEOUT_MS = 1500;
const EXEC_OPTIONS = { timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' };
const LOGGED_OUT_PROCESS_COUNT_MAX = 6;

function fetchPtlogin(port, useHttps) {
  return new Promise((resolve) => {
    const url = `${useHttps ? 'https' : 'http'}://127.0.0.1:${port}/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0`;
    const headers = {
      Host: 'localhost.ptlogin2.qq.com',
      Referer: 'https://xui.ptlogin2.qq.com/',
      Cookie: 'pt_local_token=0',
    };
    const handleResponse = (res) => {
      let text = '';
      res.on('data', (c) => (text += c.toString()));
      res.on('end', () => {
        try {
          const inner = text.split('[')[1].split(']')[0];
          resolve(JSON.parse('[' + inner + ']'));
        } catch {
          resolve(null);
        }
      });
    };
    const req = useHttps
      ? https.get(url, { headers, timeout: CONNECTION_TIMEOUT_MS, rejectUnauthorized: false }, handleResponse)
      : http.get(url, { headers, timeout: CONNECTION_TIMEOUT_MS }, handleResponse);
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function tryPtloginMethod(port) {
  const useHttps = port % 2 !== 0;
  const r1 = await fetchPtlogin(port, useHttps);
  const r2 = await fetchPtlogin(port, useHttps);
  if (r1 === null && r2 === null) return 'fallback';
  const target = [r1, r2].filter((x) => x !== null).reduce((a, b) => (a.length <= b.length ? a : b));
  if (target.length === 1) {
    const a = target[0];
    return { port, uin: String(a.uin || a.account || ''), nickName: a.nickname || '', identityKnown: true };
  }
  return 'fallback';
}

async function getQqProcessCount() {
  try {
    const { stdout } = await execAsync('tasklist /fi "imagename eq QQ.exe" /nh', EXEC_OPTIONS);
    return stdout.toLowerCase().split('\n').filter((l) => l.includes('qq.exe')).length;
  } catch {
    return LOGGED_OUT_PROCESS_COUNT_MAX;
  }
}

async function getProcessPorts(pid) {
  try {
    const { stdout } = await execAsync('netstat -ano', EXEC_OPTIONS);
    const ports = new Set();
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 5) continue;
      if (parts[parts.length - 1] !== String(pid)) continue;
      const m = parts[1].match(/:(\d+)$/);
      if (m) ports.add(Number(m[1]));
    }
    return Array.from(ports);
  } catch {
    return null;
  }
}

const ODD = [4301, 4303, 4305, 4307, 4309];
const EVEN = [4302, 4304, 4306, 4308, 4310];

async function probe(pid) {
  const ports = await getProcessPorts(pid);
  if (ports === null) return { err: 'netstat 失败' };
  const hits = ports.filter((p) => ODD.includes(p) || EVEN.includes(p));
  const cnt = await getQqProcessCount();
  if (!hits.length) {
    return { ports, ptPorts: [], qqCount: cnt, result: cnt < LOGGED_OUT_PROCESS_COUNT_MAX ? '未登录（identityKnown=false）' : 'null' };
  }
  const tryPorts = hits.filter((p) => ODD.includes(p));
  const use = tryPorts.length ? tryPorts : hits;
  const out = [];
  for (const p of use) {
    const r = await tryPtloginMethod(p);
    out.push({ port: p, r });
    if (r !== 'fallback') break;
  }
  return { ports: ports.length, ptPorts: hits, qqCount: cnt, tried: out };
}

(async () => {
  const { stdout } = await execAsync('tasklist /fi "imagename eq QQ.exe" /fo csv /nh', EXEC_OPTIONS);
  const pids = stdout
    .split('\n')
    .map((l) => l.split(',')[1])
    .filter(Boolean)
    .map((x) => Number(String(x).replace(/"/g, '')))
    .filter((x) => Number.isInteger(x) && x > 0);
  console.log('=== 找到 QQ 进程: ' + pids.join(', ') + ' ===\n');
  for (const pid of pids) {
    console.log('--- PID ' + pid + ' ---');
    const t0 = Date.now();
    const r = await probe(pid);
    console.log('  耗时 ' + (Date.now() - t0) + ' ms');
    console.log('  ' + JSON.stringify(r, null, 2).split('\n').join('\n  '));
    console.log('');
  }
})();
