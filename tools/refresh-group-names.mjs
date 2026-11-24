#!/usr/bin/env node
/**
 * 把「群号 → 群名」的映射从**协议端**拉下来，落到 `state/group-names.json`。
 *
 * ## 规矩（用户 2026-11-14 定）
 *   **群号是主键，群名只是参考** —— 群名随时会被群主改，而群号永远不变。
 *   所以这里**只更新 groupNames 里的 name**，绝不按群名去认群；
 *   任何按群名匹配的地方，都必须拿这份映射先换成群号再说。
 *
 * ## 数据从哪来
 *   `GET /api/qq/groups`（机器人自己的 webui 接口，内部走协议端 `get_group_list`）
 *   —— 不要直接连 OneBot 的 3001，那条 WS **只允许一个客户端**，机器人占着。
 *   三个号各自的 webui 端口是 3099 / 3100 / 3101，合并去重（每个号在的群不一样）。
 *
 * ## 用法
 *   node tools/refresh-group-names.mjs           # 拉一遍并写盘
 *   node tools/refresh-group-names.mjs --show    # 顺便打印出来
 *   node tools/refresh-group-names.mjs --resolve 200000007   # 只查一个群叫什么
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FILE = join(ROOT, 'state', 'group-names.json');
const PORTS = [3099, 3100, 3101];

const argv = process.argv.slice(2);
const show = argv.includes('--show');
const resolveIdx = argv.indexOf('--resolve');
const resolveId = resolveIdx >= 0 ? String(argv[resolveIdx + 1] || '') : '';

function load() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch {}
  return { groups: {} };
}

let doc = load();
if (!doc.groups) doc.groups = {};

let added = 0;
let renamed = 0;
const seenIds = new Set();

for (const port of PORTS) {
  let r;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/qq/groups`, { signal: AbortSignal.timeout(12000) });
    r = await res.json();
  } catch {
    continue; // 那个号没在跑，跳过
  }
  const list = Array.isArray(r?.groups) ? r.groups : [];
  for (const g of list) {
    const id = String(g.id || '').trim();
    const name = String(g.name || '').trim();
    if (!id) continue;
    // ⚠️ 2026-11-14：`/api/qq/groups` 会把「配置里写了但当前不在群里」的也列出来，
    //    name 填的是占位文案「(配置里写的，当前不在该群)」。那不是群名，不许覆盖真名 ✗
    if (/^\s*[（(]配置里写的/.test(name)) continue;
    seenIds.add(id);
    const old = doc.groups[id];
    if (!old) {
      doc.groups[id] = { name, count: Number(g.count) || 0, seenAt: Date.now() };
      added++;
    } else {
      const before = String(old.name || '');
      // ⚠️ 群名变了 ⇒ 马上更新（用户要求：变更之后立刻改记下来的那个名字）
      if (name && name !== before) {
        doc.groups[id] = { ...old, name, count: Number(g.count) || old.count || 0, seenAt: Date.now(), prevName: before };
        renamed++;
        console.log(`[改名] ${id}: 「${before}」→「${name}」`);
      } else {
        old.seenAt = Date.now();
        old.count = Number(g.count) || old.count || 0;
      }
    }
  }
}

doc.updatedAt = Date.now();
doc.note = '群号是主键；群名会变，发现变更立刻更新。按群名认群之前先用这里换成群号。';
mkdirSync(dirname(FILE), { recursive: true });
writeFileSync(FILE, JSON.stringify(doc, null, 1), 'utf8');

const total = Object.keys(doc.groups).length;
console.log(`✓ 已写 ${FILE}`);
console.log(`  群 ${total} 个（新增 ${added}，改名 ${renamed}），本次从 ${seenIds.size} 个群收到数据`);

if (resolveId) {
  const g = doc.groups[resolveId];
  console.log(g ? `  ${resolveId} = 「${g.name}」（${g.count} 人）` : `  ${resolveId} 不在列表里`);
}
if (show) {
  console.log('\n群号          群名');
  for (const [id, g] of Object.entries(doc.groups).sort((a, b) => String(a[1].name).localeCompare(String(b[1].name)))) {
    console.log(`${id}  ${g.name}${g.prevName ? '   ← 原名「' + g.prevName + '」' : ''}`);
  }
}
