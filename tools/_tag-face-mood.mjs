/**
 * 给表情库加 `mood`（语义类别），让匹配**只在同一类里挑** ——
 * 用户：「把类似的表情分类，这样不会发和需要发的表情类型完全无关的情况」。
 *
 * 为什么需要：`matchFaces()` 用的是字集相似度，跨类很容易沾上
 * （写「害羞」可能挑到「呆萌」，写「无语」可能和「猪头」有点重合）。
 * 加上类别后，只在**同一类**里轮换 ⇒ 至少不会发到完全无关的那种。
 *
 * 用法：node tools/_tag-face-mood.mjs [--write]   默认 dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(root, 'library', 'index.json');

/** tag → 类别（9 类）。同类之间可以互换，跨类不许串。 */
const MOOD = {
  // 笑 / 开心 / 庆祝
  大笑: '笑', 憨笑: '笑', 憋笑: '笑', 爆炸笑: '笑', 狂笑: '笑', 呆笑: '笑',
  欢呼: '笑', 握拳: '笑', 燃烧: '笑', 比耶: '笑', 狗奶: '笑',
  // 无语 / 无奈 / 冷淡
  无语: '无语', 扶额: '无语', 无语看手机: '无语', 无奈: '无语', 呆滞: '无语',
  冷眼: '无语', 盯着: '无语', 走了: '无语', 慵懒: '无语', 猫问: '无语',
  // 疑惑 / 思考 / 琢磨
  疑惑: '疑惑', 思考: '疑惑', 深思: '疑惑', 托腮: '疑惑', 品鉴: '疑惑',
  参谋: '疑惑', 几何: '疑惑',
  // 害羞 / 亲昵 / 撒娇
  害羞: '害羞', 摸头: '害羞', 抱抱: '害羞', 送花: '害羞', 紧张: '害羞',
  嘟嘴: '害羞', 裹冬: '害羞', 呆萌: '害羞',
  // 生气 / 威胁 / 嘲弄
  生气: '生气', 小猪名单: '生气', 猪头: '生气', 小猪: '生气', 得意: '生气',
  // 难过 / 委屈 / 崩了
  哭哭: '难过', 崩溃: '难过', 哭诉: '难过',
  // 震惊 / 佩服 / 强烈喜欢
  这么强: '震惊', 震惊: '震惊', 磕到了: '震惊', 磕到美的: '震惊',
  超喜欢: '震惊', 认同: '震惊',
  // 围观 / 看戏 / 划水
  吃瓜: '围观', 蹲坑: '围观', 阅读: '围观', 吃喝: '围观',
  // 动作 / 状态 / 就位
  比手: '动作', 出手: '动作', 挥手: '动作', 就绪: '动作', 到岗: '动作',
  嚼嚼: '动作',
};

const j = JSON.parse(fs.readFileSync(file, 'utf8'));
const arr = Array.isArray(j) ? j : (j.items ?? j.faces ?? []);
const WRITE = process.argv.includes('--write');
let miss = [];
let changed = 0;
for (const it of arr) {
  const m = MOOD[String(it.tag ?? '').trim()];
  if (!m) {
    miss.push(it.tag);
    continue;
  }
  if (it.mood !== m) {
    it.mood = m;
    changed++;
  }
}
const byMood = {};
for (const it of arr) if (it.mood) (byMood[it.mood] ??= []).push(it.tag);

console.log(`共 ${arr.length} 条，设了类别 ${arr.length - miss.length} 条，改动 ${changed} 条`);
if (miss.length) console.log('⚠️ 没分类的 tag：' + [...new Set(miss)].join(' / '));
for (const [m, tags] of Object.entries(byMood)) console.log(`  ${m}（${tags.length}）：${[...new Set(tags)].join(' ')}`);

if (WRITE && changed) {
  const bak = file + '.bak-加mood-' + new Date().toISOString().slice(5, 16).replace(/[-:T]/g, '');
  fs.copyFileSync(file, bak);
  fs.writeFileSync(file, JSON.stringify(j, null, 2) + '\n', 'utf8');
  console.log(`\n已写回；备份 → ${path.basename(bak)}`);
} else if (!WRITE) {
  console.log('\n（dry-run，加 --write 才真的写）');
}
