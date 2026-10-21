/**
 * 「主人最近的近况」短时记忆的套件（2026-10-17 用户要求）。
 *
 * 用户原话：
 *   「加一个对主人的**短时记忆区**，同样计入 `owner.md`，**到 48 小时**前的数据就清除，
 *     主要用于**跨群和私聊**的记忆，所以**只用总结记忆**即可……而且要**记下时间**
 *     以便调用和删除。机器人可以在**没事的时候提一下**里面的东西，但是**不能老是提**」
 *
 * ⚠️ 纯离线：假模型（`ask` 直接注入）+ **临时 owner.md**（绝不动真实那份 ✗）
 * 用法: node test/owner-recent.js
 */
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'logs'), { recursive: true });

// ⚠️ 配置路径必须在 import `src/*` **之前**设好（config.js 是加载时读的）
const CFG_REL = 'logs/__test-owner-recent.yml';
writeFileSync(
  join(ROOT, CFG_REL),
  ['llm:', '  baseURL: http://127.0.0.1:1/v1', '  apiKey: "sk-test"', '  model: test-model'].join(
    '\n',
  ),
  'utf8',
);
process.env.QQBOT_CONFIG = CFG_REL;
// ⚠️⚠️ 关键：**临时 owner.md** —— 绝不能碰用户真实那份 ✗
const OWNER_REL = 'logs/__test-owner.md';
const OWNER_ABS = join(ROOT, OWNER_REL);
process.env.QQBOT_OWNER_FILE = OWNER_REL;
process.env.QQBOT_OWNER_RECENT_FILE = 'logs/__test-owner-recent.json';

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const r = await import('../src/owner-recent.js');
const fmt = (t) => {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

// 造一份假 owner.md（带正文，用来验"正文不会被碰"）
const BODY = '# 测试用（假的，不是真资料）\n\n## 一、他是什么样的人\n- 这条正文**一个字都不许被改**\n';
writeFileSync(OWNER_ABS, BODY, 'utf8');

console.log('\n【1】★ 攒他本人说的话（跨群 / 私聊都算）');
{
  r.__clearBuf();
  check(r.noteOwnerTalk('今晚又得通宵，一早还要把车送去年检', { source: '群200000001' }) === true, '群里说的 → 攒下 ✓');
  check(r.noteOwnerTalk('明天下午有个面试，得早点睡', { source: '私聊' }) === true, '私聊说的 → 也攒下 ✓（这就是"跨群和私聊"✓）');
  check(r.status().buffered === 2, `攒了 2 条（实际 ${r.status().buffered}）`);
  check(r.noteOwnerTalk('在') === false, '★ 太短的语气词不攒 ✓');
  check(r.noteOwnerTalk('[图片]') === false, '★ 纯图片段不攒 ✓');
  check(
    r.noteOwnerTalk('我的手机号是 13800138000') === false,
    '★★ 敏感信息（11 位号码）**不收** ✓',
  );
  check(r.noteOwnerTalk('邮箱 <主人>@example.com') === false, '★★ 邮箱也不收 ✓');
}

console.log('\n【2】★★★ 攒够了 ⇒ 模型**总结**成短句写进 owner.md（不是照抄 ✗）');
{
  r.__clearBuf();
  r.noteOwnerTalk('今晚又得通宵', {});
  r.noteOwnerTalk('一早还要把车送去黄牛那儿年检', {});
  r.noteOwnerTalk('反正说了也不听', {});
  r.noteOwnerTalk('明天下午还有个面试', {});
  let asked = null;
  const n = await r.maybeSummarize({
    // ⚠️ 2026-10-19：`MIN_ITEMS` 从 4 提到 **12**（用户：「**看起来明显不像是总结出来的，
    //    而是有一条消息就记一条**」—— 攒 4 句就吐 3 条，效果上就是一条消息一条 ✗）
    //    ⇒ 这里只攒了 4 条，得**强制**跑一次才验得到总结逻辑本身 ✓
    force: true,
    ask: async (opts) => {
      asked = opts;
      return '{"items":["今晚通宵，一早要把车送去年检","明天下午有面试"]}';
    },
  });
  check(n === 2, `总结出 2 条（实际 ${n}）`);
  check(!!asked && /总结/.test(asked.user) && /只写关于他的事/.test(asked.user), '★★ 提示词里要求"总结"+"只写关于他的事" ✓');
  check(!!asked && /敏感信息/.test(asked.system), '★★ 提示词里也写明不许写敏感信息 ✓');
  const md = readFileSync(OWNER_ABS, 'utf8');
  check(md.includes('今晚通宵，一早要把车送去年检'), '★★★ 短句写进了 owner.md ✓');
  check(/OWNER-RECENT:BEGIN/.test(md) && /OWNER-RECENT:END/.test(md), '★★ 用的是那个自维护区块（定界标记在 ✓）');
  check(md.startsWith(BODY.slice(0, 20)), '★★★ **正文没被碰**（只在末尾追加 ✓）');
  check(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(md), '★★★ **每条都带了时间**（用户要求"记下时间"✓）');
  check(r.status().buffered === 0, '★ 总结完把攒的清空 ✓');
}

console.log('\n【3】★★★ 超过 48 小时的会被清掉（用户：「到 48 小时前的数据就清除」）');
{
  const old = Date.now() - 50 * 60 * 60 * 1000; // 50 小时前
  const fresh = Date.now() - 2 * 60 * 60 * 1000; // 2 小时前
  writeFileSync(
    OWNER_ABS,
    BODY +
      '\n## 三、他最近的近况（短时记忆 · 只保留 48 小时）\n\n' +
      '<!-- OWNER-RECENT:BEGIN（下面由机器人自己写）-->\n' +
      `- ${fmt(old)} ｜ 五十小时前的老事\n` +
      `- ${fmt(fresh)} ｜ 两小时前的新事\n` +
      '<!-- OWNER-RECENT:END -->\n',
    'utf8',
  );
  const items = r.list();
  check(items.length === 1 && items[0].text === '两小时前的新事', '★★★ 50 小时前那条被清掉、2 小时前留着 ✓', `剩 ${items.length} 条`);
  const md = readFileSync(OWNER_ABS, 'utf8');
  check(!md.includes('五十小时前的老事'), '★★ 而且**从文件里也删掉了**（不是只在内存里过滤 ✓）');
  check(md.includes('两小时前的新事'), '★ 新的那条还在 ✓');
}

console.log('\n【4】★★ 她提过就记一笔（用户：「可以提，但不能老是提」）');
{
  check(r.noteRaised(0) === true, '★ 记一次"提过了" ✓');
  check(r.noteRaised(0) === true, '★ 再记一次 ✓');
  const md = readFileSync(OWNER_ABS, 'utf8');
  check(/提过 2 次/.test(md), '★★ 文件里能看见"提过 2 次"⇒ 她拼提示词时看得见、不会反复提 ✓');
  check(/\d{2}:\d{2}/.test(md.split('提过')[1] ?? ''), '★ 还记了**最近提的时间** ✓');
  check(r.noteRaised(99) === false, '★ 越界不炸 ✓');
}

console.log('\n【5】★ 模型挂了 ⇒ 不炸、也不乱写');
{
  r.__clearBuf();
  r.noteOwnerTalk('今晚又得通宵', {});
  r.noteOwnerTalk('一早还要把车送去年检', {});
  const before = readFileSync(OWNER_ABS, 'utf8');
  const n = await r.maybeSummarize({
    ask: async () => {
      throw new Error('模型超时');
    },
  });
  check(n === 0, '★★ 调用失败 ⇒ 返回 0（这次不写）✓');
  check(readFileSync(OWNER_ABS, 'utf8') === before, '★★ 文件没被写坏 ✓');
  const n2 = await r.maybeSummarize({ ask: async () => '这不是 JSON' });
  check(n2 === 0, '★ 返回不是 JSON ⇒ 跳过，不炸 ✓');
}

console.log('\n【6】★ 接线：攒的地方、定时器都在（防"写了模块忘了接"）');
{
  const bot = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const idx = readFileSync(join(ROOT, 'src', 'index.js'), 'utf8');
  check(/ownerRecent\.noteOwnerTalk\(/.test(bot), '★★ bot.js 里在他说话时攒 ✓');
  check(/config\.ownerQQ && String\(event\?\.user_id/.test(bot), '★★ 只攒**他本人**的（别人不进这块 ✓）');
  check(/ownerRecent/.test(idx) && /maybeSummarize\(/.test(idx), '★★ index.js 里定时总结 ✓');
  check(/ownerRecent/.test(idx) && /\.sweep\(\)/.test(idx), '★★ index.js 里定时清过期的 ✓');
}

console.log(
  '\n【7】★★★ 他说"记错了" ⇒ **让模型判断**并删掉那条（2026-10-17 用户要求：要用模型判断是否删除）',
);
{
  const block = (rows) =>
    BODY +
    '\n## 三、他最近的近况（短时记忆 · 只保留 48 小时）\n\n' +
    '<!-- OWNER-RECENT:BEGIN（下面由机器人自己写）-->\n' +
    rows.join('\n') +
    '\n<!-- OWNER-RECENT:END -->\n';
  const t1 = Date.now() - 30 * 60 * 1000;
  const t2 = Date.now() - 60 * 60 * 1000;
  const t3 = Date.now() - 90 * 60 * 1000;
  writeFileSync(
    OWNER_ABS,
    block([
      `- ${fmt(t1)} ｜ 今晚又得通宵`,
      `- ${fmt(t2)} ｜ 一早要把车送去年检`,
      `- ${fmt(t3)} ｜ 明天下午有面试`,
    ]),
    'utf8',
  );

  // ① 模型判出"第 2 条记错了" ⇒ 删掉它（索引从 1 开始 ✓）
  let sawList = '';
  const r1 = await r.judgeAndFix('那个年检是明天，不是一早，你记错了', {
    ask: async (opts) => {
      sawList = opts.user;
      return '{"remove":[2],"why":"他说年检是明天"}';
    },
  });
  check(/编号从 1 开始/.test(sawList), '★★ 提示词里把每条都编号给了模型 ✓');
  check(/只是闲聊/.test(sawList), '★★ 提示词里写明"只是闲聊就不要删" ✓');
  check(r1.removed === 1, `★★★ 删掉 1 条（实际 ${r1.removed}）`);
  check(String(r1.texts[0]).includes('年检'), '★★★ 删的正是"年检"那条 ✓', String(r1.texts[0]));
  const md1 = readFileSync(OWNER_ABS, 'utf8');
  check(!md1.includes('年检'), '★★ 文件里也没了 ✓');
  check(md1.includes('今晚又得通宵') && md1.includes('明天下午有面试'), '★★ 其它两条没被误删 ✓');
  check(md1.startsWith(BODY.slice(0, 20)), '★★ 正文还是没被碰 ✓');

  // ② 闲聊 ⇒ 一条都不删（模型说 remove 为空 ✓）
  const r2 = await r.judgeAndFix('今天天气不错', {
    ask: async () => '{"remove":[],"why":"闲聊"}',
  });
  check(r2.removed === 0, '★★★ 闲聊 ⇒ 一条都不删 ✓');

  // ③ 模型给了越界编号 ⇒ 不删、不炸
  const r3 = await r.judgeAndFix('随便说说', { ask: async () => '{"remove":[99]}' });
  check(r3.removed === 0, '★★ 越界编号 ⇒ 不删（不被模型带偏 ✓）');

  // ④ 模型挂了 / 回的不是 JSON ⇒ 一律不动
  const r4 = await r.judgeAndFix('你记错了', {
    ask: async () => {
      throw new Error('模型超时');
    },
  });
  check(r4.removed === 0, '★★ 模型失败 ⇒ 不动它 ✓');
  const r5 = await r.judgeAndFix('你记错了', { ask: async () => '我看不懂' });
  check(r5.removed === 0, '★★ 回的不是 JSON ⇒ 不动它 ✓');

  // ⑤ 接线：他说话时会调它（而且不 await，不许挡正常回复）
  const botSrc = readFileSync(join(ROOT, 'src', 'bot.js'), 'utf8');
  const seg = botSrc.slice(botSrc.indexOf('judgeAndFix'), botSrc.indexOf('judgeAndFix') + 900);
  check(botSrc.includes('ownerRecent') && /judgeAndFix\(saidNow\)/.test(botSrc), '★★ bot.js 里接上了 ✓');
  check(/void ownerRecent\s*[\r\n\s]*\.judgeAndFix/.test(botSrc), '★★ 是**后台跑**的（没 await ⇒ 不挡她回话 ✓）');
  // ⚠️ 用户 2026-10-17 明确要求：「**不要专门说一遍，就正常聊天回话即可**」
  //    ⇒ 删完**不许**再专门发一条"我记岔了"这种（她那句正常回复就是回应 ✓）
  check(
    !/那是我记岔了|记岔了哈/.test(botSrc),
    '★★★ 删完**不专门发一句**（就让她正常聊天回话 ✓）',
  );
}

console.log(
  '\n【8】★★★ 他说"某个细节不对" ⇒ 按他说的**改**；完全记错才删（用户 2026-10-17：都交给模型判断）',
);
{
  const mk = (rows) =>
    writeFileSync(
      OWNER_ABS,
      BODY +
        '\n## 三、他最近的近况（短时记忆 · 只保留 48 小时）\n\n' +
        '<!-- OWNER-RECENT:BEGIN（下面由机器人自己写）-->\n' +
        rows.join('\n') +
        '\n<!-- OWNER-RECENT:END -->\n',
      'utf8',
    );
  const T = (m) => fmt(Date.now() - m * 60 * 1000);
  const three = [
    `- ${T(30)} ｜ 今晚又得通宵`,
    `- ${T(60)} ｜ 一早要把车送去年检`,
    `- ${T(90)} ｜ 明天下午有面试`,
  ];

  // ① 只是细节不对、还值得记 ⇒ **改**成他说的（其它条不动）
  mk(three);
  let sawSys = '';
  const r1 = await r.judgeAndFix('年检其实是明天，不是一早', {
    ask: async (opts) => {
      sawSys = opts.system;
      return '{"update":[{"n":2,"text":"明天要把车送去年检"}],"remove":[],"why":"他说是明天"}';
    },
  });
  check(/三种情况/.test(sawSys) && /仍然值得记/.test(sawSys), '★★★ 提示词里写清三种情况（改/删/不动）✓');
  check(r1.updated === 1, `★★★ 改成他说的那条（实际 ${r1.updated}）`);
  const md1 = readFileSync(OWNER_ABS, 'utf8');
  check(md1.includes('明天要把车送去年检'), '★★★ 内容按他说的换了 ✓');
  check(!md1.includes('一早要把车送去年检'), '★★ 旧那条没了 ✓');
  check(md1.includes('今晚又得通宵') && md1.includes('明天下午有面试'), '★★ 别的条没被顺手改 ✓');
  check(md1.startsWith(BODY.slice(0, 20)), '★★ 正文还是没被碰 ✓');

  // ② 完全记错 / 改完不值得记 ⇒ **删**
  mk(three);
  const r2 = await r.judgeAndFix('我根本没通宵啊', {
    ask: async () => '{"update":[],"remove":[1],"why":"他说根本没这回事"}',
  });
  check(r2.removed === 1, '★★★ 完全记错 ⇒ 删掉 ✓');
  check(!readFileSync(OWNER_ABS, 'utf8').includes('今晚又得通宵'), '★★ 文件里也没了 ✓');

  // ③ 闲聊 / 这几条都没问题 ⇒ 什么都不动
  mk(three);
  const before3 = readFileSync(OWNER_ABS, 'utf8');
  const r3 = await r.judgeAndFix('今天天气不错', {
    ask: async () => '{"update":[],"remove":[],"why":"闲聊"}',
  });
  check(r3.updated === 0 && r3.removed === 0, '★★★ 闲聊 ⇒ 一条都不动 ✓');
  check(readFileSync(OWNER_ABS, 'utf8') === before3, '★★ 文件一个字都没变 ✓');

  // ④ 模型给的 update 不合法（太短 / 含敏感）⇒ 丢掉，不写
  mk(three);
  const r4 = await r.judgeAndFix('你记错了', {
    ask: async () => '{"update":[{"n":1,"text":"嗯"}],"remove":[]}',
  });
  check(r4.updated === 0, '★★ update 太短（<2 字）⇒ 丢掉 ✓');
  const r5 = await r.judgeAndFix('你记错了', {
    ask: async () => '{"update":[{"n":1,"text":"他的手机是13800138000"}],"remove":[]}',
  });
  check(r5.updated === 0, '★★ update 里带敏感信息 ⇒ 丢掉 ✓');

  // ⑤ 越界编号 ⇒ 不动
  mk(three);
  const r6 = await r.judgeAndFix('随便', {
    ask: async () => '{"update":[{"n":99,"text":"乱改的"}],"remove":[99]}',
  });
  check(r6.updated === 0 && r6.removed === 0, '★★ 越界编号 ⇒ 都不动 ✓');
}

try {
  rmSync(join(ROOT, CFG_REL), { force: true });
  rmSync(OWNER_ABS, { force: true });
  rmSync(join(ROOT, 'logs/__test-owner-recent.json'), { force: true });
} catch {}

console.log(`\n结果: ${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}\n`);
process.exit(failures === 0 ? 0 : 1);
