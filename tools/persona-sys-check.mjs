/**
 * 验一个人设包的**开场白**对不对（`personas/<id>/prompt/system.md` 生效了没有）
 * —— 2026-10-23 加。
 *
 * 为什么需要它
 * ─────────────
 *   `buildSystemPrompt()` 的第一行是 `persona.promptFile('system') || config.llm.systemPrompt`，
 *   而 `config.yml` 那份写的是**默认那个角色**（现在是祥子）。
 *   ⇒ **换了人设却没写 `prompt/system.md` 的号，提示词开头还在说"你是祥子"**，跟 `persona.md` 打架。
 *   2026-10-23 实测（本地跑剧情 20 轮）：模型在思考链里整段纠结"我到底是哪个"，
 *   最后**整轮空回复** ✗ —— 这毛病只在换过人设的号上出现，从群里很难看出来。
 *
 * ⚠️⚠️ 一个**必踩的坑**：光改 `config.persona.id` 验不出来。
 *   人设正文（`personas/<id>/persona.md`）的路径是在 **import 那一刻**算死的，
 *   只有"每次现读"的 `prompt/system.md` 会跟着 `persona.id` 换 ⇒
 *   结果是「开头是爱音、正文还是祥子」，看着像好了，其实没验到 ✗
 *   ⇒ 所以这个脚本**先设 `QQBOT_PERSONA_DIR`，再动态 import** ✓
 *
 * 用法
 * ─────
 *   node tools/persona-sys-check.mjs                 # 查当前配置里那个人设
 *   node tools/persona-sys-check.mjs --id=anon       # 查某个包
 *   node tools/persona-sys-check.mjs --id=anon --full   # 把整份提示词也打出来（很长）
 */
const argv = process.argv.slice(2);
const arg = (name, dflt = '') => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return dflt;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : '1';
};
const hasFlag = (n) => argv.includes(`--${n}`);

// ⚠️ 必须在 import 之前（原因见文件头）
const ID = String(arg('id', '')).trim();
if (ID) process.env.QQBOT_PERSONA_DIR = `personas/${ID}`;

const { config } = await import('../src/config.js');
const persona = await import('../src/persona.js');
const { Bot } = await import('../src/bot.js');

if (ID) config.persona = { ...(config.persona ?? {}), id: ID };
persona.reload();

const id = String(config.persona?.id ?? 'saki');
const me = persona.selfName() || persona.charName() || id;

const bot = new Bot();
const ev = {
  message_type: 'group',
  group_id: '999000777',
  user_id: '10000001',
  message: [{ type: 'text', data: { text: '在吗' } }],
  raw_message: '在吗',
};
const sys = bot.buildSystemPrompt('', ev, null, '在吗');

console.log(`人设包：${id}（自称 ${me}）`);
console.log(`用的是：${persona.promptFile('system') ? 'personas/' + id + '/prompt/system.md' : 'config.yml 的 llm.systemPrompt（回落到默认角色）'}`);
console.log(`提示词总长：${sys.length} 字`);
console.log('\n—— 开头 300 字 ——');
console.log(sys.slice(0, 300));

// ── 判定 ───────────────────────────────────────────────
let bad = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) bad++;
};
console.log('\n—— 判定 ——');
// 人设包自己的名字出现得够早（前 300 字），说明开场白是它自己的
check(sys.slice(0, 300).includes(me), '开头就是这个角色', `（找「${me}」）`);
// 正文里"别的人设"只该剩正常提及，不该有「你就是〈别人〉」这种身份声明
const wrongId = /你就是\s*\*{0,2}(丰川祥子|千早爱音|长崎素世)(?!.*自称)/.test(sys);
check(!wrongId || sys.slice(0, 300).includes(me), '没有别人的身份声明');
check(!/客服小祥/.test(sys.slice(0, 300)), '开头没有「客服小祥」这种默认人设的叫法');

// 提到别人的行：列出来让人肉看是不是正常提及
const othersMention = sys
  .split(/\r?\n/)
  .filter((l) => /祥子|爱音|素世|灯|乐奈|立希/.test(l) && !l.includes(me))
  .slice(0, 5);
console.log(`  ℹ️ 提到别的角色的行（前 5 行，正常该是"同校 / 称呼"这种）：`);
for (const l of othersMention) console.log('     · ' + l.trim().slice(0, 88));
if (!othersMention.length) console.log('     （没有）');

if (hasFlag('full')) {
  console.log('\n—— 整份提示词 ——\n');
  console.log(sys);
}

console.log(`\n结果：${bad ? `${bad} 项需要注意 ❌` : '全部通过 ✅'}`);
process.exit(0);
