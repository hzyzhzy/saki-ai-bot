// 清掉 recent 里「戳一戳」相关的旧错误记录
//   ⚠️ 必须用 node 写（AGENTS 铁律：Set-Content -Encoding utf8 会带 BOM 毁掉 JSON）
//   ⚠️ 只在 bot 停着的时候跑（否则内存那份会把文件覆盖回去）
import fs from 'node:fs';

const P = '<项目目录>/qq-ai-bot/state/recent.json';
const j = JSON.parse(fs.readFileSync(P, 'utf8'));
const groups = j.groups || {};

let total = 0;
const detail = [];
for (const [gid, arr] of Object.entries(groups)) {
  if (!Array.isArray(arr)) continue;
  const before = arr.length;
  const kept = arr.filter((m) => {
    const t = String(m?.text ?? '');
    // ① 旧的戳记录：`（戳了你一下：捏了捏的脸）` —— 前半句把"戳"钉死了
    if (t.includes('戳了你一下：')) return false;
    // ② 她复读的正文：`[戳一戳] 嗯…草，今天怎么样？`
    if (/^\[戳一戳\]/.test(t)) return false;
    return true;
  });
  const removed = before - kept.length;
  if (removed) {
    groups[gid] = kept;
    total += removed;
    detail.push(`${gid}: 删 ${removed} / 原有 ${before}`);
  }
}

j.groups = groups;
fs.writeFileSync(P, JSON.stringify(j, null, 2), 'utf8');

// 立刻验没有 BOM
const b = fs.readFileSync(P);
console.log('BOM?', b[0] === 0xef, '（应为 false）');
console.log('共删', total, '条');
for (const d of detail) console.log('  ' + d);
