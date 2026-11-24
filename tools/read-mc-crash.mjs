// read-mc-crash.mjs —— 从**群文件**里取一份崩溃报告并分析
//
// ## 什么时候用它（而不是 `analyzeLogFile`）
// `analyzeLogFile()` 读的是**消息段里带的临时 url**，那个 url 会过期
// （日志里刷屏的 `文件下载失败（-134）` 就是它）✗
// 这个脚本走 `get_group_file_url` 重新取一份**新的**下载链接 —— 群文件是永久的 ⇒ 老文件也能读 ✓
//
// ## ⚠️⚠️ 2026-11-21 重写（用户：「刚才第二遍调出来的时候还有个弹窗，做到什么鬼东西啊」）
//
// 原来这里用 `execFileSync('powershell.exe', ['-Command', "Expand-Archive ..."])` 解压
// ⇒ **PowerShell 一定会建一个控制台窗口** ⇒ 用户看到一个黑窗弹出来 ✗✗
//
// ⇒ 现在**完全不用 PowerShell**：解压 + 挑文件 + 解析全部复用 `src/mc-log.js` 里现成的
//   `analyzeFile()`（纯 `node:zlib` 的 `inflateRawSync`，一个窗口都不起）✓
//   顺带把重复的"挑哪份文本（崩溃报告 > latest.log > … > debug.log）"逻辑也统一了 ✓
//
// ## 设计要点
// · **分清主人**：`--uploader <QQ或名字>` 只在这个人上传的文件里挑
// · **报出 message_id**：发送回复时要**引用**那份文件，所以要从历史里反查
// · 分析结果会落进 `logs/_uploaded/*.json`（24 小时后随缓存一起清）
import WebSocket from 'ws';
import fs from 'node:fs';
import yaml from 'js-yaml';
import { analyzeFile } from '../src/mc-log.js';

function arg(name, def = '') {
  const a = process.argv;
  for (let i = 0; i < a.length; i++) if (a[i] === '--' + name && i + 1 < a.length) return a[i + 1];
  return def;
}

const GID = Number(arg('group', '0'));
if (!GID) {
  console.log('要 --group <群号>');
  process.exit(1);
}
const WANT_UPLOADER = String(arg('uploader', '')).trim();

const cfgPath = arg('account', 'accounts/10000002.yml');
const acc = yaml.load(fs.readFileSync(cfgPath, 'utf8'));
const tok = acc.onebot?.accessToken || '';
const url = String(acc.onebot?.url || 'ws://127.0.0.1:3001');

const ws = new WebSocket(url, { headers: { Authorization: 'Bearer ' + tok } });
await new Promise((res, rej) => {
  ws.on('open', res);
  ws.on('error', rej);
  setTimeout(() => rej(new Error('连不上 ' + url)), 8000);
});
function api(action, params, timeout = 60000) {
  return new Promise((resolve) => {
    const echo = 'e' + Math.random().toString(36).slice(2, 8);
    const t = setTimeout(() => resolve({ timeout: true }), timeout);
    const on = (d) => {
      const j = JSON.parse(d.toString());
      if (j.echo === echo) {
        clearTimeout(t);
        ws.off('message', on);
        resolve(j);
      }
    };
    ws.on('message', on);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

// ── ① 找候选文件（带上上传者）────────────────────────────
let fileId = arg('file-id', '');
let fileName = arg('name', '');
let uploaderQq = '';
let uploadTime = 0;

if (!fileId) {
  const r = await api('get_group_root_files', { group_id: GID });
  let files = (r?.data?.files ?? []).filter((f) =>
    /\.(zip|rar|7z|tar\.gz|txt|log)$/i.test(String(f.file_name || '')),
  );
  if (!files.length) {
    console.log('群里没找到压缩包/日志文件（或者读不到群文件列表）');
    ws.close();
    process.exit(2);
  }
  if (WANT_UPLOADER) {
    const byQq = files.filter((f) => String(f.uploader || '') === WANT_UPLOADER);
    if (byQq.length) files = byQq;
  }
  if (fileName) {
    const byName = files.filter((f) => String(f.file_name || '').includes(fileName));
    if (byName.length) files = byName;
  }
  files.sort((a, b) => Number(b.upload_time || 0) - Number(a.upload_time || 0));
  const pick = files[0];
  fileId = pick.file_id;
  fileName = pick.file_name;
  uploaderQq = String(pick.uploader || '');
  uploadTime = Number(pick.upload_time || 0);
}

// ── ② 反查那条文件消息的 message_id（发送时要引用它）──────
let msgId = '';
let uploaderName = '';
try {
  const h = await api('get_group_msg_history', { group_id: GID, count: 200 });
  const msgs = h?.data?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const segs = Array.isArray(m.message) ? m.message : [];
    const seg = segs.find((s) => s?.type === 'file');
    if (!seg) continue;
    const n = String(seg.data?.name ?? seg.data?.file ?? '');
    if (n && fileName && n === fileName) {
      msgId = String(m.message_id ?? '');
      uploaderQq = uploaderQq || String(m.sender?.user_id ?? '');
      uploaderName = String(m.sender?.card || m.sender?.nickname || '');
      break;
    }
  }
  if (!msgId) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (uploaderQq && String(m.sender?.user_id ?? '') !== uploaderQq) continue;
      const segs = Array.isArray(m.message) ? m.message : [];
      if (!segs.some((s) => s?.type === 'file')) continue;
      msgId = String(m.message_id ?? '');
      uploaderName = String(m.sender?.card || m.sender?.nickname || '');
      break;
    }
  }
} catch {}

// ── ③ 拿新链接并下载 ──────────────────────────────────────
const u = await api('get_group_file_url', { group_id: GID, file_id: fileId });
const dl = u?.data?.url;
if (!dl) {
  console.log('拿不到下载链接（这个文件可能已过期）');
  ws.close();
  process.exit(3);
}

let buf = null;
try {
  const res = await fetch(dl, { signal: AbortSignal.timeout(180000) });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  buf = Buffer.from(await res.arrayBuffer());
} catch (e) {
  console.log('下载失败：' + e.message);
  ws.close();
  process.exit(4);
}

// ── ④ 解析：**复用 mc-log.js**，不起任何 PowerShell 窗口 ──
const res = analyzeFile({
  name: fileName || 'report.zip',
  buf,
  uploader: { qq: uploaderQq, name: uploaderName, group: String(GID), messageId: msgId },
});

// ── ⑤ 输出摘要 ────────────────────────────────────────────
const ts = uploadTime ? new Date(uploadTime * 1000).toLocaleString('zh-CN') : '';
console.log('');
console.log(`文件：${fileName}（${buf.length} 字节）`);
if (uploaderName || uploaderQq) {
  console.log(`上传者：${uploaderName || '?'}（QQ ${uploaderQq || '?'}）${ts ? '　' + ts : ''}`);
}
if (msgId) console.log(`文件消息 message_id：${msgId}（回话时引用这条）`);

if (!res.ok) {
  console.log('');
  console.log('⚠️ 读不出来：' + res.reason);
} else {
  const p = res.analysis?.parsed ?? res.parsed ?? {};
  console.log('');
  console.log(`里面挑中的是：${p.fileName || res.analysis?.innerFile || '?'}（${p.lines ?? '?'} 行）`);
  const ex = Array.isArray(p.exceptions) ? p.exceptions : [];
  console.log(`异常 ${ex.length} 个、命中已知模式 ${p.known?.length ?? 0} 条`);
  if (ex.length) {
    console.log('');
    console.log('关键报错（照这个说原因）：');
    for (const e of ex.slice(0, 6)) {
      const t = String(e.type ?? '').trim();
      const m = String(e.msg ?? '').replace(/\s+/g, ' ').slice(0, 180);
      console.log('  · ' + (t ? t + '：' : '') + m);
    }
  }
}

ws.close();
console.log('');
console.log(
  '##OK ' +
    JSON.stringify({
      file: fileName,
      bytes: buf.length,
      ok: res.ok,
      uploaderQq,
      uploaderName,
      messageId: msgId,
    }),
);
