/**
 * 黑祥（`sakiko-dark`）的**包级暖色开关**测试 —— 外加一份「saki 一点没被影响」的对照。
 *
 * 2026-09-30 加。用户的原话（分两次说的）：
 *   · 「把所有关心，正向阳光人设的提示词全删了，必须要有强烈反差」
 *   · 「白祥模式也删了，一点都不要留，必须时刻都要带刺」
 *   · 「发表情机制直接在黑祥人设取消」
 *   · 「**注意我刚才说的都是黑祥人设，如果切到原来的 saki 千万不要被影响到了**」
 *   · 「再次检查，黑祥人设千万不要影响到原来小祥的所有行为，**包括表情包，戳一戳**」
 *
 * ## 这个套件为什么值得存在
 *
 * 判据是 `identity.style.warm`（**包级**），不是 `config.persona.ownerException`
 * （那是用户随时会动的**演示开关**）。两者分开是这次的关键设计 ——
 * 所以这里**两个包各跑一遍同样的断言**：
 *   · `sakiko-dark` → 一半断言要求"关掉了"
 *   · `saki`        → 另一半要求"原样都在"
 * 只测一边的套件挡不住"关着关着把 saki 也关了"这类错误。
 *
 * ## 覆盖到的路径
 *
 * | 路径 | 怎么测 |
 * | --- | --- |
 * | 提示词注入（表情 / 口癖 / 括号 / 好感度 / 还击 / 戳一戳 / 白祥） | `buildSystemPrompt()` |
 * | **发送侧**（表情标记会不会真发图） | `warmAllowed()` 拦在 `sendChunk` 里，见下面的说明 |
 * | **戳一戳回拍**（每 3 次拍回去一次） | 直接调 `pokeBack()`，把 `call` 桩掉看有没有 `send_poke` |
 *
 * ⚠️ 「发送侧」那条：`test/face.js` 已经证明 **saki 下发图正常**；
 *    黑祥那半边在 `sendChunk` 里是同一行代码的另一个分支
 *    （`this.warmAllowed() ? pickMarkers(raw) : []`），这里断言它的判据为 false。
 *    真要端到端发一次图得再起一个 bot 子进程 + 假 NapCat，
 *    而这一条的价值主要就是"开关没接错线"，所以用判据 + 上面那套提示词断言兜住。
 *
 * 用法: node test/dark-persona.js
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

const { Bot } = await import('../src/bot.js');
const { config } = await import('../src/config.js');
const persona = await import('../src/persona.js');
const kn = await import('../src/knowledge.js');
const mama = await import('../src/mama.js');

const bot = new Bot();
bot.selfId = String(config.botQQ ?? '');
// ⚠️ 钉住"对主人例外"开关：那是**演示开关**，和这个套件要测的包级开关是两件事。
//    不钉的话，用户界面上一动它，这里的断言就跟着变（哨兵不能取决于用户的开关）。
config.persona = { ...(config.persona || {}), ownerException: true };
// 戳一戳：只测"拍不拍回去"，别让它顺带去跑模型 / 发文字。
// ⚠️ 这里**故意切回老的 `packet` 模式** —— 默认已经是 `'text'`（攒够次数→文字反击），
//    那样"拍不拍"就看不出来了。切回 packet 才能验证 `warm` 那道闸真的在拦。
config.poke = {
  ...(config.poke || {}),
  enable: true,
  countPerBack: 3,
  backMode: 'packet',
  useLLM: false,
  fallbackText: false,
};

const MEMBER = { message_type: 'group', group_id: '200000001', user_id: '30003', sender: { nickname: '小豆', card: '小豆' } };
const pokeEv = { ...MEMBER, _poke: true, _pokeText: '捏一捏', message: [{ type: 'text', data: { text: '[戳一戳:捏一捏]' } }] };
const mamaEv = { ...MEMBER, _mama: 'accept' };
const seg = (t) => [{ type: 'text', data: { text: t } }];
// ⚠️ 骂人那条**必须带上 @ 她** —— 不然 `decide()` 会因为"没人叫她"直接返回 null，
//    那样这条断言测的就成了"群消息不@不回"，跟"骂妈静默"完全不是一回事（第一版就这么假绿/假红过）。
const segAt = (t) => [{ type: 'at', data: { qq: bot.selfId } }, { type: 'text', data: { text: t } }];
// ⚠️ 2026-09-30：用户实测踩到的 —— 「我草你妈就是正事」@ 她，机器人**一个字都不回**。
//    根因是 `decide()` 里那条"骂她妈妈一律不回"（2026-09-17 为客服小祥定的）。
//    黑祥（暖色关）下它必须**放行成还击**，而 saki 下要原样保持沉默。
const momText = '我草你妈就是正事';

function switchTo(pkg) {
  process.env.QQBOT_PERSONA_DIR = join(ROOT, 'personas', pkg);
  kn.reloadKnowledge();
}

/** 把三个场景的提示词都生成出来，省得每个断言各调一次 */
function prompts() {
  return {
    chat: bot.buildSystemPrompt('', MEMBER, null, '在吗'),
    // ⚠️ 一条**会被判成闲聊**的话（走 casual 那段）——「不像黑祥」的反馈就出在这条路上
    chat2: bot.buildSystemPrompt('', MEMBER, null, '哈哈哈哈这个太草了'),
    // ⚠️ 「语气词留着」那段**只在 service 模式**（对方真问服务器的事）里 ——
    //    拿 casual 的话去测它，"没有它"是假绿（那本来就不该有）。
    service: bot.buildSystemPrompt('', MEMBER, null, '服务器怎么进'),
    // ⚠️ 「切温柔」那段**只在 `detectMode()` 判成 gentle 时才注入** ——
    //    必须拿一句真的会触发的话来测（用「在吗」测，"没有它"是假绿：
    //    那本来就不该有，跟开关一点关系都没有。第一版就是这么写错的）。
    upset: bot.buildSystemPrompt('', MEMBER, null, '我太没用了'),
    poke: bot.buildSystemPrompt('', pokeEv, null, '[戳一戳:捏一捏]'),
    // ⚠️ 攒够次数那一次（`_pokeRetort`）—— 里面是**反击语气**那版提示词
    retort: bot.buildSystemPrompt(
      '',
      { ...pokeEv, _pokeRetort: true, _pokeTimes: 3 },
      null,
      '[戳一戳:捏一捏]',
    ),
    mama: bot.buildSystemPrompt('', mamaEv, null, '在吗'),
  };
}

/** 连戳三次 → 看有没有 `send_poke`（用户要求"戳 3 次回拍一次"） */
async function pokedBack() {
  bot.pokeCount = new Map();
  const calls = [];
  bot.call = async (action, params) => {
    calls.push({ action, params });
    return {};
  };
  bot.scheduleHandle = async () => {};
  bot.sendToGroup = async () => ({});
  for (let i = 0; i < 3; i++) {
    await bot.pokeBack({ user_id: '30003', group_id: '200000001', raw_info: { action: '拍', suffix: '了拍' } });
  }
  return calls.some((c) => c.action === 'send_poke');
}

// ══════════════════════════════════════════════════════════
console.log('\n[1] 黑祥（sakiko-dark / style.warm=false）→ 暖色必须全关');
switchTo('sakiko-dark');
check(persona.warm() === false, 'persona.warm() 是 false');
{
  const p = prompts();
  // ⚠️⚠️ 系统提示词的整段覆盖。用户截图反馈「这个回话也不像黑祥」（她回
  //    「急哭的是你吧，我这儿还闲着呢」），头号元凶就是 `config.llm.systemPrompt`：
  //    它开头写「粉丝叫她客服小祥」，末尾还钉着「别省语气词…真人闲聊是松的」。
  check(p.chat.includes('你话极少，而且冷'), '★ 用的是黑祥自己的 system.md（整段覆盖）');
  check(!p.chat.includes('粉丝叫她客服小祥'), '★ 全局那句"客服小祥"没进来');
  check(!p.chat.includes('短可以，但别省语气词'), '★ 也没进来"别省语气词"那条');
  // ⚠️ casual 段里那句自称"这是大部分时候的你"的活泼指导，黑祥下必须换掉
  check(!p.chat2.includes('语气活泼点，可以傲娇、可以嘴碎'), '★ 不再被要求"语气活泼点、可以嘴碎"');
  check(p.chat2.includes('这个版本的你，**不陪聊**'), '　└ 换成了"不陪聊"那版');
  check(!p.chat2.includes('参考这种口气，但自己换着说'), '　└ 也不再教她"哟，来了啊"这种招呼口气');
  check(!p.chat.includes('先夸'), '★ 晒图也不捧场（"先夸"那套没进来）');
  check(!p.service.includes('语气词留着'), '★ 服务模式也不再说"语气词留着"');
  check(p.service.includes('不加语气词'), '　└ 换成了"不加语气词"那版');
  check(!p.chat.includes('扎人是俏皮，不是刻薄'), '★ 对群友不再要"俏皮"，改成"不留情面"');
  check(p.chat.includes('不留情面'), '　└ "不留情面"那版进来了');
  check(!p.chat.includes('你的表情包'), '提示词里没有表情包教学');
  check(p.chat.includes('你不发表情包'), '反而有"你一张都不发"的明令');
  check(!p.chat.includes('偶尔加个口癖'), '没有教她用「（」');
  check(p.chat.includes('不用「（」'), '反而明令禁用「（」');
  check(
  !p.chat.includes('句尾缀个「捏」') && !p.chat.includes('「捏」要省着用'),
  '没有口癖教学（捏）；verbalTics 也是空的',
);
  check(!p.chat.includes('你对这个人的好感度'), '好感度不注入（群友也一样）');
  check(!p.upset.includes('别问技术细节，别提服务器'), '对方说难受也不切温柔');
  check(p.chat.includes('还击是你的默认反应'), '还击改成了"默认反应、更密集"那版');
  check(p.chat.includes('阴阳怪气') && p.chat.includes('典。'), '还击放宽到阴阳怪气 + 贴吧话术');
  check(!p.chat.includes('有人直接骂你，你还回去'), '客服小祥那版还击话术不在里面');
  check(p.poke.includes('把界线钉回去'), '戳一戳换成"反击越界"那版');
  check(!p.poke.includes('别捏了，痒'), '戳一戳不再是打情骂俏那版');
  check(!p.mama.includes(mama.acceptHint().slice(0, 10)), '喊妈不会认（白祥模式没了）');
  check(p.retort.includes('他已经连着戳你 3 次'), '攒够次数那一次会换成"反击语气"提示词');
  check(p.retort.includes('你手长我身上了'), '　└ 而且是黑祥那版（更狠的那套）');
  check(await pokedBack() === false, '连戳 3 次也**不拍回去**（哪怕显式配了 packet）');
  {
    // 骂她妈：**不许静默**，要放行成还击
    const ev = { ...MEMBER, message: segAt(momText) };
    const d = bot.decide(ev);
    check(!!d, '★ 骂她妈时**不静默**（`decide()` 放行，交给她还击）');
    check(ev._swearAtMom === true, '　└ 并打上 `_swearAtMom`（提示词据此注入还击指导）');
    const sys = bot.buildSystemPrompt('', { ...ev, _swearAtMom: true }, null, momText);
    check(sys.includes('他刚才骂的是你妈'), '　└ 提示词里注入了「骂的是你妈」那段');
    check(sys.includes('不许拿"妈"去回敬他'), '　└ 而且明令：不带脏字、不拿「妈」回敬');
  }
}

// ══════════════════════════════════════════════════════════
console.log('\n[2] saki（style.warm 默认 true）→ 一个字都不许少');
switchTo('saki');
check(persona.warm() === true, 'persona.warm() 是 true');
{
  const p = prompts();
  check(p.chat.includes('粉丝叫她客服小祥'), '★ saki 还是用全局那份 systemPrompt（没被覆盖）');
  check(!p.chat.includes('你话极少，而且冷'), '★ 黑祥的 system.md 没串进来');
  check(p.chat2.includes('语气活泼点，可以傲娇、可以嘴碎'), '★ "语气活泼点"那套照旧在');
  check(p.chat.includes('先夸'), '★ 晒图照样捧场');
  check(p.service.includes('语气词留着'), '★ 服务模式照样"语气词留着"');
  check(p.chat.includes('扎人是俏皮，不是刻薄'), '★ 对群友照样"俏皮、不刻薄"');
  check(p.chat.includes('你的表情包'), '表情包教学还在');
  check(!p.chat.includes('你不发表情包'), '没有被塞进黑祥那条禁令');
  check(p.chat.includes('偶尔加个口癖'), '「（」的口癖教学还在');
  check(!p.chat.includes('不用「（」'), '没有被塞进黑祥那条禁用');
  // ⚠️ 2026-10-01：文案变了 —— 用户反馈「捏的频率太高」之后，标题从
  //    「句尾缀个「捏」」改成了「句尾的「捏」要省着用」。断言跟着改。
  check(
    p.chat.includes('「捏」要省着用') || p.chat.includes('句尾缀个「捏」'),
    '口癖教学（捏）还在',
  );
  check(p.chat.includes('你对这个人的好感度'), '好感度照常注入群友');
  check(p.upset.includes('别问技术细节，别提服务器'), '切温柔那套还在');
  check(p.chat.includes('有人直接骂你，你还回去'), '还击还是原来那版（对等、收住）');
  check(!p.chat.includes('还击是你的默认反应'), '没有被塞进黑祥那版还击');
  check(!p.poke.includes('把界线钉回去'), '戳一戳没有被换成反击版');
  check(p.poke.includes('痒'), '戳一戳还是原来那套（痒 / 别捏了）');
  check(p.mama.includes(mama.acceptHint().slice(0, 10)), '喊妈照样能认、白祥模式还在');
  check(p.retort.includes('他已经连着戳你 3 次'), '攒够次数那一次也会换成"反击语气"提示词');
  check(p.retort.includes('戳够了没有'), '　└ 而且是 saki 那版（带点凶、但不打闹）');
  check(await pokedBack() === true, '连戳 3 次照样拍回去（packet 模式下）');
  {
    // 骂她妈：**saki 必须原样保持沉默**（2026-09-17 用户定的老规矩，不许被黑祥的改动带跑）
    const ev = { ...MEMBER, message: segAt(momText) };
    const d = bot.decide(ev);
    check(d === null, '★ 骂她妈时 saki 照旧**一律不回**（老规矩没被带跑）');
    check(ev._swearAtMom === undefined, '　└ 也不会打上 `_swearAtMom`');
  }
}

console.log(
  failures === 0
    ? '\n结果: 全部通过 ✅（黑祥全关、saki 一点没动）'
    : `\n结果: ${failures} 项失败 ❌`,
);
process.exit(failures === 0 ? 0 : 1);
