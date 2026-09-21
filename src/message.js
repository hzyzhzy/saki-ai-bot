/**
 * OneBot v11 消息段工具。
 * 消息既可能是 CQ 码字符串，也可能是消息段数组，两种都要能处理。
 */

/**
 * 这个图片段是「动画表情 / 表情包」，还是普通图片（截图、照片、报错图）。
 *
 * ⚠️⚠️ **字段名按协议端不同 —— 别再猜，两边源码都读过了**（2026-09-20）：
 *
 * | 协议端 | 字段 | 形态 | 源码 |
 * | --- | --- | --- | --- |
 * | NapCat | `sub_type` | **数字** `1` | 内部 `picSubType` 直接映射 |
 * | LLBot（ob11） | `subType` | **驼峰**、数字 `1` | 收图 L16181 `subType: picElement.picSubType` |
 *
 * 另：LLBot 的**私有** API / Milky 那套用字符串 `sub_type: 'sticker'`
 * （`llbot.js` L37923 的 `_enum(["normal","sticker"])`、L38512），
 * **那条路机器人不走**，但留作保险 —— 各家实现都在往这个口径上靠。
 *
 * 判定**只在这一个函数里**：以后换协议端、或者哪家又改名，只改这里。
 */
export function isStickerSeg(seg) {
  const d = seg?.data;
  if (!d) return false;
  if (Number(d.sub_type) === 1) return true; // NapCat
  if (Number(d.subType) === 1) return true; // LLBot（ob11）
  const s = String(d.sub_type ?? d.subType ?? '').toLowerCase();
  return s === 'sticker'; // LLBot 私有 API / Milky
}

/** 把任意形态的消息统一成消息段数组 */
export function toSegments(message) {
  if (Array.isArray(message)) return message;
  if (typeof message !== 'string') return [];
  return parseCQ(message);
}

/** 解析 CQ 码字符串 */
export function parseCQ(text) {
  const segs = [];
  const re = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ type: 'text', data: { text: text.slice(last, m.index) } });
    const data = {};
    const args = m[2].replace(/^,/, '');
    if (args) {
      for (const pair of args.split(',')) {
        const i = pair.indexOf('=');
        if (i === -1) continue;
        data[pair.slice(0, i)] = unescapeCQ(pair.slice(i + 1));
      }
    }
    segs.push({ type: m[1], data });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ type: 'text', data: { text: text.slice(last) } });
  return segs;
}

function unescapeCQ(s) {
  return s
    .replace(/&#44;/g, ',')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&amp;/g, '&');
}

/**
 * 把只有占位符的内容看成「没有文字」。
 * 例：`[图片]`、`[表情包]`、`[图片] [表情包]` → 空串；`[图片]这个怎么弄` → `这个怎么弄`。
 * 用途：判断对方到底有没有打字（纯发表情包和「发图+提问」要区别对待）。
 */
export function stripPlaceholders(text) {
  return String(text ?? '')
    .replace(/\[(图片|表情包|QQ表情|语音|视频|文件:[^\]]*)\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 这段内容里有没有图片/表情（用于判断要不要走图片话术） */
export function hasMediaPlaceholder(text) {
  return /\[(图片|表情包|QQ表情)\]=?/.test(String(text ?? ''));
}

/** 取出纯文本内容（@ 和图片等会被替换成占位或忽略） */
export function extractText(segments, { atPlaceholder = '' } = {}) {
  const parts = [];
  for (const seg of segments) {
    switch (seg.type) {
      case 'text':
        parts.push(seg.data?.text ?? '');
        break;
      case 'at':
        parts.push(atPlaceholder);
        break;
      case 'image':
        // 区分表情包和截图（字段名各协议端不同 → 统一走 isStickerSeg）。
        // 这个区别对回答方式影响很大 —— 表情包是「在玩笑」，截图是「有问题要问」。
        parts.push(isStickerSeg(seg) ? '[表情包]' : '[图片]');
        break;
      case 'face':
        parts.push('[QQ表情]');
        break;
      case 'record':
        parts.push('[语音]');
        break;
      case 'video':
        parts.push('[视频]');
        break;
      case 'file':
        parts.push(`[文件:${seg.data?.name ?? seg.data?.file ?? ''}]`);
        break;
      case 'forward':
        // 合并转发的聊天记录。⚠️ 光有这个段是**看不到内容**的，
        //    要拿 data.id 去调 get_forward_msg 才能取到里面的消息（见 bot.js 的 expandForwards）。
        //    这里先放个占位，让上层知道「这条消息里有转发」。
        parts.push('[合并转发]');
        break;
      case 'node':
        parts.push('[转发节点]');
        break;
      case 'json':
      case 'xml': {
        // 分享卡片。能抠出标题和简介就抠，抠不到就算了。
        const d = seg.data?.data ?? seg.data ?? '';
        const title = String(d).match(/"title"\s*:\s*"([^"]{2,60})"/)?.[1];
        const desc = String(d).match(/"desc"\s*:\s*"([^"]{2,80})"/)?.[1];
        if (title) parts.push(`[分享:${title}${desc ? `｜${desc}` : ''}]`);
        else parts.push('[分享]');
        break;
      }
      case 'poke':
        parts.push('[戳一戳]');
        break;
      case 'reply':
        // ⚠️ 2026-09-13：引用内容**现在会保留**（用户要求「引用段能不能保留，
        //    很多时候都需要机器人读取引用内容来回答问题」）。
        //
        //    ⚠️ 但 NapCat 给的 reply 段**只有 `id`**，没有发送者也没有原文：
        //        { type: "reply", data: { id: "100310452", seq: 123 } }
        //        所以要拿引用内容，必须**用这个 id 去调 get_msg**（异步）。
        //        这里只把 id 提取出来（同步），真正的查询在 bot.js 里做。
        //
        //    ⚠️⚠️ 别写错变量名！这个循环里是 `seg`，**不是 `s`**。
        //        我第一版写成了 `s.data?.id` —— `s` 不在作用域里，
        //        于是**任何带引用段的消息都会让 extractText 抛
        //        `ReferenceError: s is not defined`**。
        //        后果（用户报的「QQ空间填充不了内容」）：
        //          · 空间那条路要调 extractText 回填素材 → 直接抛 → 面板报
        //            「出错：s is not defined」
        //          · 更要命的是**群里只要有人用「引用回复」，机器人处理那条消息时
        //            也会抛**（extractText 是消息处理的主干路径）。
        //        查了很久（错误抛在 try/catch 外面，webui 只拿到 message 没栈）。
        if (seg.data?.id) parts.push(`[引用#${seg.data.id}]`);
        break;
      default:
        break;
    }
  }
  return parts.join('');
}

/** 取出消息里所有合并转发的 id（可能不止一个） */
export function forwardIds(segments) {
  return (segments ?? [])
    .filter((s) => s.type === 'forward' && s.data?.id)
    .map((s) => String(s.data.id));
}

/** 消息里有没有合并转发 */
export function hasForward(segments) {
  return forwardIds(segments).length > 0;
}

/**
 * 判断一个 reply/node 段里是不是真正的合并转发。
 * 有时候转发会包在 json 卡片里（`"app":"com.tencent.multimsg"`）。
 */
export function forwardIdFromJson(segments) {
  for (const s of segments ?? []) {
    if (s.type !== 'json' && s.type !== 'xml') continue;
    const raw = String(s.data?.data ?? '');
    // com.tencent.multimsg 卡片里带 resId / fileName
    const m = raw.match(/"resid"\s*:\s*"([^"]+)"/i) ?? raw.match(/"resId"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
    if (/multimsg|合并转发|聊天记录/i.test(raw)) {
      return '__json_card__'; // 标明这是个合并转发卡片，但拿不到 id
    }
  }
  return null;
}

/**
 * 把 get_forward_msg 返回的节点整理成可读文本。
 *
 * ⚠️ 关键：**必须递归提取** —— 转发里可能还嵌着转发、图片、表情包。
 *    只取 text 段会丢掉大半内容（这是「看不了转发」的另一个原因）。
 *
 * @param {object} data get_forward_msg 的返回
 * @returns {string} 形如 "昵称：内容\n昵称：内容"
 */
export function forwardNodeText(data) {
  const nodes = data?.messages ?? data?.message ?? data ?? [];
  if (!Array.isArray(nodes)) return '';

  const lines = [];
  for (const node of nodes) {
    if (!node) continue;
    // 节点可能是 { nickname, message: [...] }，也可能是 OB11 的 message 事件
    // （带 sender.nickname / sender.card）。几种都要认，不然会解析成空昵称。
    const nick =
      node.nickname ||
      node.sender?.card ||
      node.sender?.nickname ||
      node.user_id ||
      '某人';
    const segs = Array.isArray(node.message) ? node.message : [];
    if (!segs.length) continue;

    // 递归提取：内层 forward 用占位符表示，避免无限递归
    const text = segs
      .map((s) => {
        if (s.type === 'text') return s.data?.text ?? '';
        if (s.type === 'at') return `@${s.data?.qq ?? ''}`;
        if (s.type === 'image') return isStickerSeg(s) ? '[表情包]' : '[图片]';
        if (s.type === 'face') return '[QQ表情]';
        if (s.type === 'forward') return '[里面还有一个转发]';
        if (s.type === 'record') return '[语音]';
        if (s.type === 'video') return '[视频]';
        if (s.type === 'file') return `[文件:${s.data?.name ?? ''}]`;
        if (s.type === 'json' || s.type === 'xml') return '[分享]';
        return '';
      })
      .join('')
      .replace(/\s+/g, ' ')
      .trim();

    if (text) lines.push(`${nick}：${text}`);
  }
  return lines.join('\n');
}

/** 消息里是否 @ 了指定 QQ */
export function isAt(segments, qq) {
  const target = String(qq);
  return segments.some((s) => s.type === 'at' && String(s.data?.qq) === target);
}

/** 消息里是否 @ 了全体成员 */
export function isAtAll(segments) {
  return segments.some((s) => s.type === 'at' && s.data?.qq === 'all');
}

/** 去掉 @机器人 留下的多余空白 */
export function tidy(text) {
  return text.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 剥掉**开头的文本形式 @**（2026-09-17 用户截图报的）。
 *
 * 场景：用户发的是「`@saki酱saki酱saki酱saki酱saki酱` 这是什么猫」——
 * 那串名字是**纯文本**（不是 `at` 段），`extractText` 会原样保留它，
 * 提示词里就带着一整串名字。她于是答「**连发五遍名字**，就为了一只猫（」，
 * 把那串名字当成了**消息内容**，而它其实只是**在叫她**。
 *
 * ⚠️⚠️ **为什么不能直接改 `tidy`**（我第一版就是那么干的，被套件拦下了）：
 *    `tidy` 是个到处都在用的共享函数，连"判断 @ 的是不是别人、我该不该插嘴"
 *    那条逻辑也用它。把文本 `@<主人>` 一剥，那条判断就**失去依据**，
 *    于是她开始接别人的话（`test/at-other.js` 4 项失败）。
 *    → 所以剥 @ **只用在"存进上下文 / 当作当前这句话"这两个地方**。
 *
 * ⚠️ 要剥的原因和判断是两回事：判断"@ 的是谁"要用**原文本**，
 *    而"这句话的内容是什么"要用**剥过的**。
 *
 * ⚠️ 规则：剥掉**开头连续的 `@词`**，且那个 `@词` 后面**必须跟空白**
 *    （QQ 里 @ 完会自动补空格）。这样「@了他半天没反应」这种正常句子不会被误伤
 *    —— 那是我写测试用例时发现的。
 * ⚠️ 只剥**开头**的：正文中间的 @ 是内容（「你 @<主人> 一下」）。
 */
export function stripLeadingAt(text) {
  return String(text ?? '').replace(/^\s*(?:@[^\s@]{1,40}[ \t\u00a0]+)+/, '');
}
