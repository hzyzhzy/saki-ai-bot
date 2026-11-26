/**
 * 一次性清理：把群记忆里**同一个人的多条**合并成一条（按 QQ 号，认不出就按归一化昵称）。
 *
 * 现场：主号记忆里 Anon 一个人被写成 13 条（`Anon` / `新成员Anon` / `Anon（补充三）` / …），
 * 认识视图和别人问起她"这人是谁"时都是一堆碎片。
 *
 * 规矩：
 * · **先备份**（`backupKnowledge`，落在 `knowledge/_backup/`）
 * · **信息不丢**：保留最长那条，另一条里"独有的句子"（按句号切，长度>8 且最长那条没有）拼回去，最多 2 句
 * · 「大事」那节一个字不动
 * · 名字去掉 `新成员 / 新增 / （补充N）` 这类前缀后缀（就是这些让同一个人分裂成十几条）
 *
 * 用法：`node tools/_clean-people-memory.mjs`（只报清单，不写）· 加 `--write` 才真写。
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KNOWLEDGE_DIR, knowledgePrivateDir } from '../src/config.js';
import { backupKnowledge } from '../src/backup.js';
import * as peopleOf from '../src/people.js';

const WRITE = process.argv.includes('--write');

/** 归一化昵称（和 memory-overview 里同一个规则） */
function normName(raw) {
  return String(raw ?? '')
    .replace(/\*\*/g, '')
    .replace(/^\s*(?:新成员|新增|补充|备注|观察|性格)\s*/, '')
    .replace(/[（(]\s*(?:再\s*补充|补充|新增|备注|观察|续写)[^）)]{0,6}[）)]\s*$/, '')
    .replace(/[（(]\s*\d+\s*[）)]\s*$/, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 按行找标记（同 memory-overview 的 locateSegment） */
function locate(lines, seg) {
  const b = `<!-- ${seg}:BEGIN`;
  const e = `<!-- ${seg}:END`;
  let bi = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    const hb = l.includes(b);
    const he = l.includes(e);
    if (hb && he) continue;
    if (bi < 0) {
      if (hb) bi = i;
      continue;
    }
    if (he) return { bi, ei: i };
  }
  return null;
}

const sentences = (s) =>
  String(s)
    .split(/[。；;！!？?\n]/)
    .map((x) => x.trim())
    .filter((x) => x.length > 8);

function cleanFile(file) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const at = locate(lines, 'AUTO-OBSERVE');
  if (!at) return null;
  const seg = lines.slice(at.bi + 1, at.ei);

  // 切成「群友」和「大事」两段（保留原文，只重建群友那节）
  const evIdx = seg.findIndex((l) => /^#{2,3}\s*大事/.test(l.trim()));
  const peoplePart = evIdx === -1 ? seg : seg.slice(0, evIdx);
  const restPart = evIdx === -1 ? [] : seg.slice(evIdx);

  const entries = [];
  for (const line of peoplePart) {
    const t = line.replace(/^\s*[-*·]\s*/, '').trim();
    if (!t || /^(<!--|#|>|\|)/.test(t)) continue;
    const mu = /<!--\s*u:(\d+)\s*-->/.exec(t);
    const body = t.replace(/<!--\s*u:\d+\s*-->/g, '').trim();
    const m = /^(.{1,24}?)[：:]\s*(.+)$/.exec(body);
    if (!m) continue;
    const name = m[1].replace(/\*\*/g, '').trim();
    const uid = (mu && mu[1]) || peopleOf.uidOfName(name) || peopleOf.uidOfName(normName(name));
    entries.push({ name, note: m[2].trim(), uid });
  }
  if (!entries.length) return null;

  // 按 uid / 归一化名分组
  const groups = new Map();
  for (const e of entries) {
    const key = e.uid ? `u:${e.uid}` : `n:${normName(e.name)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }

  const kept = [];
  const merged = [];
  for (const [, list] of groups) {
    if (list.length === 1) {
      const only = list[0];
      kept.push({ name: normName(only.name) || only.name, note: only.note, uid: only.uid });
      continue;
    }
    // 最长那条当底
    const sorted = [...list].sort((a, b) => b.note.length - a.note.length);
    const base = sorted[0];
    let note = base.note;
    let extra = 0;
    for (const other of sorted.slice(1)) {
      for (const s of sentences(other.note)) {
        if (note.includes(s)) continue;
        if (extra >= 2) break;
        note += `；${s}`;
        extra += 1;
      }
      if (extra >= 2) break;
    }
    kept.push({ name: normName(base.name) || base.name, note, uid: base.uid });
    merged.push({ name: base.name, dropped: list.length - 1, uid: base.uid });
  }

  const newSeg = [
    ...(evIdx === -1 ? [] : []), // 占位，保持结构清晰
    ...peoplePart.filter((l) => /^(#{2,3}\s*群友|<!--)/.test(l.trim()) || !l.trim()),
    ...kept.map((k) => `- ${k.name}：${k.note}${k.uid ? ` <!--u:${k.uid}-->` : ''}`),
    '',
    ...restPart,
  ];
  const out = [...lines.slice(0, at.bi + 1), ...newSeg, ...lines.slice(at.ei)].join('\n');
  return { file, before: entries.length, after: kept.length, merged, out, changed: out !== text };
}

const files = [];
for (const base of new Set([knowledgePrivateDir(), KNOWLEDGE_DIR])) {
  try {
    for (const f of readdirSync(join(base, 'groups'))) {
      if (f.endsWith('.md') && !f.includes('.bak')) files.push(join(base, 'groups', f));
    }
  } catch {
    /* 没这个目录 */
  }
  const gm = join(base, 'group-memory.md');
  try {
    readFileSync(gm);
    files.push(gm);
  } catch {
    /* 没有共享群记忆 */
  }
}

let totalBefore = 0;
let totalAfter = 0;
for (const f of files) {
  const r = cleanFile(f);
  if (!r) continue;
  totalBefore += r.before;
  totalAfter += r.after;
  const short = f.replace(process.cwd(), '.').replace(/^\.\\/, '');
  if (!r.changed) {
    console.log(`= ${short}：${r.before} 条，无需改动`);
    continue;
  }
  console.log(`* ${short}：${r.before} 条 → ${r.after} 条`);
  for (const m of r.merged.slice(0, 12)) {
    console.log(`    合并「${m.name}」(${m.uid || '无QQ'})，去掉 ${m.dropped} 条重复`);
  }
  if (WRITE) {
    backupKnowledge(f);
    writeFileSync(f, r.out, 'utf8');
  }
}
console.log(
  `\n合计：${totalBefore} 条 → ${totalAfter} 条${WRITE ? '（已写盘，原文件已备份到 knowledge/_backup/）' : '（只看了清单，加 --write 才真写）'}`,
);
