/**
 * 修表情库里的**重名 tag**。
 *
 * 为什么必须修：tag 是模型选图的键（它写 `[表情:标签]`），
 * 两张图同名的话只会命中其中一张，另一张等于永远用不上。
 * 自动补注释时很容易撞（「思考」「疑惑」这种通用词）。
 *
 * 规则：**保留先入库的那张**（人工起的名），给后来的重新起一个不重名的。
 *
 * 用法：node test/fix-face-tags.js [--dry]
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../src/config.js';
import { streamChat } from '../src/llm.js';

const LIB = join(ROOT, 'library');
const INDEX = join(LIB, 'index.json');
const DRY = process.argv.includes('--dry');

function load() {
  return JSON.parse(readFileSync(INDEX, 'utf8'));
}
function save(idx) {
  const tmp = `${INDEX}.tmp`;
  writeFileSync(tmp, JSON.stringify(idx, null, 2), 'utf8');
  renameSync(tmp, INDEX);
}

async function collect(messages) {
  let out = '';
  for await (const d of streamChat(messages)) out += d;
  return out;
}

/** 让模型起一个不重名的短标签 */
async function rename(face, taken) {
  const raw = await collect([
    {
      role: 'system',
      content: [
        '你在给 QQ 机器人的表情包起**短标签**（模型靠这个标签选图）。',
        '',
        '要求：',
        '- **两个汉字**，好记、能和别的图区分开。',
        '- 必须准确反映这张图的画面/情绪（看下面的描述）。',
        '- **不能和已占用的重名**（下面会给出已占用的列表）。',
        '- 只输出这两个字，不要引号、不要解释。',
        '',
        '⚠️ 特别提醒：',
        '- 如果是**界面截图 / 加载提示 / 梗图**（不是动漫角色），',
        '  标签要贴它实际的意思，例如「加载中」「思考中」「问号」——',
        '  **不要起成跟画面无关的情绪词**（比如明明是加载界面却叫「装死」）。',
        '- 如果是动漫角色，可以起情绪词（但别和已占用的重复）。',
        '',
        `已占用的标签：${taken.join('、')}`,
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `当前想用的名字：${face.tag}（已重名）`,
        `画面：${face.desc || face.who || ''}`,
        `适用场合：${face.when || ''}`,
      ].join('\n'),
    },
  ]);
  const t = String(raw).replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '').slice(0, 6);
  return t;
}

async function main() {
  const idx = load();
  const faces = idx.faces ?? [];

  // 找出重名的组，每组保留第一个（先入库的），其余待改
  const byTag = new Map();
  for (const f of faces) {
    if (!byTag.has(f.tag)) byTag.set(f.tag, []);
    byTag.get(f.tag).push(f);
  }
  const todo = [];
  for (const [tag, list] of byTag) {
    if (list.length <= 1) continue;
    // 保留第一个，其余重命名
    for (const f of list.slice(1)) todo.push({ face: f, oldTag: tag });
  }

  console.log(`共 ${faces.length} 张，${todo.length} 张需要改名`);
  if (!todo.length) return;

  // ⚠️ 用「独立的已分配集合」而不是每次都重算 faces。
  //    原因：--dry 模式不写回 face.tag，重算就永远不含前面刚起的新名字，
  //    于是两张重名的会被起成同一个名字（踩过：两张都变成「琢磨」）。
  const assigned = new Set(faces.map((x) => x.tag));
  // 待改名的先把旧名字从集合里腾出来
  for (const { face, oldTag } of todo) {
    // 如果旧名字只有它自己在用，可以腾；否则保留
    const others = faces.filter((x) => x !== face && x.tag === oldTag);
    if (!others.length) assigned.delete(oldTag);
  }

  for (const { face, oldTag } of todo) {
    let name = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      const cand = await rename(face, [...assigned]);
      if (cand && !assigned.has(cand)) {
        name = cand;
        break;
      }
    }
    if (!name) {
      // 模型一直撞，就加个后缀兜底，别卡死
      let n = 2;
      while (assigned.has(`${oldTag}${n}`)) n++;
      name = `${oldTag}${n}`;
    }
    assigned.add(name); // 关键：立刻占位，后面不能再起同一个
    console.log(`  ${face.file}`);
    console.log(`    ${oldTag} → ${name}   （${(face.who || face.desc || '').slice(0, 40)}）`);
    if (!DRY) face.tag = name;
  }

  if (!DRY) {
    save(idx);
    console.log('\n已写入 index.json');
  } else {
    console.log('\n（--dry 模式，没写入）');
  }
}

main().catch((e) => {
  console.error('出错：', e.message);
  process.exit(1);
});
