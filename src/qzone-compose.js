/**
 * 生成 QQ 空间说说。
 *
 * 给小祥一份「群聊素材 + 服务器状态 + 最近发过的」，让它自己判断：
 *   ① 有没有值得发的
 *   ② 发什么（趣事 / 汇总 / 感想）
 *   ③ 配哪张表情
 *
 * 注意：发布的权限判断不在这里（在 qzone.js），这里只管「写什么」。
 */
import { config } from './config.js';
import { log } from './log.js';
import {streamChat, isLiteActive } from './llm.js';
import { knowledgeText } from './knowledge.js';
import { faceMenuText } from './faces.js';
import { queryServer, describe } from './status.js';
import * as digest from './digest.js';
import * as persona from './persona.js';

/** 空间说说的写作要求 —— 和群里聊天完全不同，这里是对着好友广播 */
// ⚠️ 2026-09-21：说说的写作指南（131 行的人设文案）搬到了
//    `personas/<id>/prompt/qzone-guide.md` —— 长段放 JSON 里要转义换行、没法读、
//    界面上也没法编辑，所以**短句走 identity.prompt，长段走这里的 md**。
export function postGuide() {
  return persona.promptFile('qzone-guide');
}

/**
 * 让模型写一条说说。
 * @param {{liveStatus?: string}} opts
 * @returns {Promise<{post:boolean, type:string, content:string, faces:string[], reason:string}>}
 */
export async function compose({ liveStatus = '' } = {}) {
  const material = digest.materialText();
  if (!material) {
    return { post: false, type: '', content: '', faces: [], reason: '素材库是空的' };
  }

  // 服务器状态：能查到就带上，让它有「汇总」的素材
  let serverLine = liveStatus;
  if (!serverLine) {
    try {
      const cfgStatus = config.status ?? {};
      if (cfgStatus.enable && cfgStatus.host) {
        const data = await queryServer(cfgStatus.host, cfgStatus.cacheSeconds * 1000);
        serverLine = describe(data, cfgStatus.displayName ?? '服务器');
      }
    } catch (e) {
      log.debug(`说说取服务器状态失败：${e.message}`);
    }
  }

  const kb = knowledgeText();
  const faces = faceMenuText();
  const posted = digest.recentPostsText();

  /* ⚠️⚠️⚠️ 2026-11-21（用户：「**空间就照现在的配置就行了，是极简就极简，不是就不是，
   *   但是极简的同时要加上空间独有的提示词**」）——
   *   现场：空间生成 400 Bad Request，request (74,122 tokens) exceeds the available context
   *   真因：服务器知识库全文 + 全部素材 都没截断 => 撑爆
   *   => 截断；但 postGuide()（空间独有提示词）一个字不动 ✓ */
  /* ⚠️⚠️⚠️ 2026-11-21（用户：「**其他模型空间不能极简**」）——
   *   原来无条件截断（kb 3000 / 素材 6000）⇒ 那是给**本地小模型**的
   *   ⇒ 现在：**只有 lite 模式才截**；其他模型（中转站/官方）用**全量** ✓ */
  const _isLite = (() => {
    try {
      return isLiteActive();
    } catch {
      return false;
    }
  })();
  const _kbCap = _isLite ? 3000 : 0;
  const _matCap = _isLite ? 6000 : 0;
  const kbCut = String(kb || '（空）');
  const kbSafe =
    _kbCap > 0 && kbCut.length > _kbCap
      ? kbCut.slice(0, _kbCap) + '\n…（后面省略 ' + (kbCut.length - _kbCap) + ' 字）'
      : kbCut;
  const _matRaw = String(material ?? '');
  const materialSafe =
    _matCap > 0 && _matRaw.length > _matCap
      ? _matRaw.slice(0, _matCap) + '\n…（后面省略 ' + (_matRaw.length - _matCap) + ' 字）'
      : _matRaw;
  try {
    log.info(
      '[空间] 提示词规模（' + (_isLite ? '极简' : '全量') + '）：知识库 ' + kbCut.length + ' 字（截到 ' + (_kbCap ? Math.min(kbCut.length, _kbCap) : kbCut.length) + '）' +
        '｜素材 ' + _matRaw.length + ' 字（截到 ' + Math.min(_matRaw.length, _matCap) + '）',
    );
  } catch {}

  const system = [
    postGuide(),
    '',
    '# 【服务器知识库】（写汇总时只能依据这里的内容，不要编）',
    kbSafe,
    '',
    serverLine ? `# 【服务器实时状态】\n${serverLine}` : '',
    '',
    faces ? `# 【可用表情】（faces 字段只能用这些标签）\n${faces}` : '',
    '',
    posted
      ? [
          '# 【最近已经发过的说说】⚠️ 这些话题**绝对不要再发一遍**',
          posted,
          '',
          '上面每一条都已经在空间里了。**同一个话题、同一个梗、同一件事，换多少种说法都算重复** ——',
          '比如已经发过「群友拿轻薄本开整合包卡成 PPT」，就**不许再发**这个，',
          '不管是换个措辞、还是换个角度（吐槽分辨率、吐槽帧数）都算重复。',
          '**宁可今天不发，也别重发聊过的事。**',
        ].join('\n')
      : '',
  ]
    .filter((x) => x !== null && x !== undefined)
    .join('\n');

  const user = [
    `# 【今天群里攒下来的素材】（共 ${digest.stats().count} 条）`,
    '',
    materialSafe,
    '',
    '根据上面的素材，决定发不发说说，以及发什么。只输出 JSON。',
  ].join('\n');

  let raw = '';
  let timedOut = false;
  /* ⚠️⚠️⚠️ 2026-11-21（「修一下 QQ 空间无法发送，大概率是模型超时」）——
   *   `config.yml` 里本地那家 provider 的 timeout 是 **90 秒**，而这条路要做的事
   *   是「读上千字素材 + 想 + 吐一整段 JSON」—— 慢的时候 90 秒真的不够 ✗
   *   而原来这里还有个 `> 90000 break` 和它**同时到点** ⇒ 半截 JSON ⇒ 判"没返回 JSON" ✗
   *   ⇒ ① 显式给 streamChat 放宽到 190 秒（`opts.timeoutMs` 会覆盖 provider 的）
   *      ② 兜底 break 设 200 秒（比它长，正常情况轮不到我切）
   *      ③ 中断时**别扔已有内容** —— JSON 尾巴闭合就照用 ✓ */
  const STREAM_TIMEOUT_MS = 190000;
  const LIMIT_MS = 200000;
  const t0 = Date.now();
// ⚠️⚠️ 2026-11-13（用户：「空间和总结有思考链吗？如果有的话也计入思考链卡片」）：
//    这条路原来**没传 report** ⇒ 模型吐的 reasoning_content 直接扔掉 ✗
//    现在挂进 webui 那张卡片：原因写"定时任务"，正文写生成的说说。
const report = {};
let tlId = '';
try {
  tlId = thinkLog.start({
    from: '（QQ空间）',
    msgText: '看这批素材，决定发不发说说、发什么',
    reason: '定时任务：QQ空间自动发说说',
  });
  report.onReasoning = (c) => thinkLog.appendThink(tlId, c);
} catch {}
try {
  for await (const piece of streamChat(
    [{ role: 'system', content: system }, { role: 'user', content: user }],
    undefined,
    { report, timeoutMs: STREAM_TIMEOUT_MS },
  )) {
    raw += piece;
    if (Date.now() - t0 > LIMIT_MS) {
      timedOut = true;
      break;
    }
  }
} catch (e) {
  /* ⚠️ 超时/网络中断是**抛**出来的，原来直接冒到调用方 ⇒ 已有内容全丢 ✗ */
  timedOut = true;
  try {
    const closed = raw.indexOf('{') >= 0 && raw.lastIndexOf('}') > raw.indexOf('{');
    log.warn(`[空间] 模型中断：${e.message}（已出 ${raw.length} 字，${closed ? 'JSON 已闭合，照用 ✓' : 'JSON 不完整 ✗'}）`);
  } catch {}
} finally {
  try {
    if (tlId) thinkLog.finish(tlId, {
      reply: raw,
      usage: report.usage,
      cost: report.cost,
      // ⚠️ 2026-11-26：卡片上要能看出这条是哪个模型写的（`streamChat` 写进 report 的）
      model: report.model,
      modelNote: report.degraded ? '（已自动降级）' : '',
      failed: !raw.trim(),
    });
  } catch {}
}

  /* ⚠️ 超时以后别一律当"没返回" —— JSON 尾巴要是已经闭合，就是整条都生成完了 ✓
   *    只有真的缺尾巴才判失败，并且**把"超时"写进 reason**（别让用户以为是模型决定不发）✗ */
  const result = parseCompose(raw);
  if (timedOut) {
    const closed = raw.lastIndexOf('}') > raw.indexOf('{') && raw.indexOf('{') >= 0;
    try {
      log.warn(
        `[空间] 模型 ${Math.round(LIMIT_MS / 1000)} 秒没写完（已出 ${raw.length} 字）⇒ ` +
          (closed ? 'JSON 尾巴已闭合，照用 ✓' : 'JSON 不完整 ✗'),
      );
    } catch {}
    if (!closed && !result.reason) result.reason = `模型超时：${Math.round(LIMIT_MS / 1000)} 秒只出到 ${raw.length} 字`;
  }
  return result;
}

/** 解析模型返回的 JSON（容忍 markdown 代码块和前后废话） */
export function parseCompose(raw) {
  const text = String(raw ?? '').trim();
  // 抠出第一个 { ... } 块
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    return { post: false, type: '', content: '', faces: [], reason: `模型没返回 JSON：${text.slice(0, 80)}` };
  }
  let j;
  const _rawText = text.slice(start, end + 1); // ⚠️ 提到外层：下面诊断日志要用
  try {
    /* ⚠️⚠️⚠️ 2026-11-21 修（用户：「**看一下 QQ 空间为什么没发送成功**」）——
     *   日志：JSON 解析失败：Expected ',' or '}' after property value…
     *   根因：4B 输出的 JSON 里**字符串没转义好**（换行/引号）⇒ JSON.parse 直接抛 ✗
     *   ⇒ 宽松解析：修常见毛病（未转义换行、尾逗号、单引号）再试 ✓ */
    const _raw = _rawText;
    const _looseJson = (s) => {
      let x = String(s ?? '');
      // ① 去掉字符串内部的裸换行（JSON 不允许）
      x = x.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"/g, (m0, inner) =>
        '"' + inner.replace(/\r?\n/g, '\\n').replace(/\t/g, '\\t') + '"',
      );
      // ② 去掉尾逗号
      x = x.replace(/,\s*([}\]])/g, '$1');
      // ③ 单引号 → 双引号（只在没有双引号包着的键上粗暴换）
      x = x.replace(/'/g, '"');
      return x;
    };
    try {
      j = JSON.parse(_raw);
    } catch (e1) {
      try {
        j = JSON.parse(_looseJson(_raw));
        log.info(`[空间] JSON 原样解析失败（${e1.message}）⇒ **宽松修复后成功** ✓`);
      } catch (e2) {
        /* ⚠️⚠️⚠️ 2026-11-21（「修一下 QQ 空间无法发送，大概率是模型超时」）——
         *   日志里**还在**出现：`JSON 解析失败：Expected ',' or '}' after property value
         *   in JSON at position 150 (line 4 column 69)`
         *   ⇒ 那是 content 里写了**没转义的双引号**（「他说"手机砸脸"」这种）✗
         *   上面 `_looseJson` 的正则认不出字符串**内部**的双引号 ⇒ 修不动 ✗
         *   ⇒ 加第三层：**不靠 JSON.parse，按字段边界扫**
         *     字符串真正的结束 = 后面紧跟 `,` / `}` / `]`，中间的双引号一律算内容 ✓ */
        const _field = (k) => {
          const s = String(_raw ?? '');
          const head = s.search(new RegExp('"' + k + '"\\s*:'));
          if (head < 0) return '';
          let i = s.indexOf(':', head) + 1;
          while (i < s.length && /\s/.test(s[i])) i++;
          // ⚠️ 非字符串值（`true` / 数字 / `null`）⇒ 读到 , 或 } 为止
          //    （post 本身就是布尔，不能按字符串扫，否则会扫到下一个键 ✗）
          if (s[i] !== '"') {
            let end = i;
            while (end < s.length && !/[,}\]]/.test(s[end])) end++;
            return s.slice(i, end).trim();
          }
          i += 1;
          let out = '';
          while (i < s.length) {
            const ch = s[i];
            if (ch === '\\') {
              out += ch + (s[i + 1] ?? '');
              i += 2;
              continue;
            }
            if (ch === '"') {
              if (/^\s*[,}\]]/.test(s.slice(i + 1))) break; // 真结束
              out += '"';
              i += 1;
              continue; // 内部引号，照收
            }
            out += ch;
            i += 1;
          }
          return out.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').trim();
        };
        const _post = _field('post') || _field('send') || _field('发');
        const _content = _field('content') || _field('text') || _field('say');
        const _reason = _field('reason');
        if (_content && /^(true|yes|y|1|是|发|要)$/i.test(_post)) {
          try {
            log.warn(`[空间] JSON 整条坏掉（${e2.message}）⇒ **按字段扫出来了**（正文 ${_content.length} 字）✓`);
          } catch {}
          j = { post: true, content: _content, type: _field('type') || 'funny', reason: _reason };
        } else {
          try {
            log.warn(`[空间] JSON 解析失败（${e2.message}）｜原文前 300 字：${String(_raw).slice(0, 300)}`);
          } catch {}
          return {
            post: false,
            type: '',
            content: '',
            faces: [],
            reason:
              `JSON 解析失败：${e2.message}` +
              (_content ? `（正文扫到 ${_content.length} 字，但 post 不是 true）` : ''),
          };
        }
      }
    }
  } catch (e) {
    return { post: false, type: '', content: '', faces: [], reason: `JSON 解析失败：${e.message}` };
  }

  /* ⚠️⚠️⚠️ 2026-11-21 修（「修一下 QQ 空间无法发送，大概率是模型超时」）——
   *   日志里出现**自相矛盾**的行：
   *     「决定了不发：「手机砸脸」这个设计稿有具体画面，能自嘲，是个轻包袱；
   *        跟已发过的五条都不重样，长度也偏短，不是模板腔。」
   *   ⇒ reason 全是**好评**、结论却是不发 —— 说明模型**是想发的** ✗
   *   两个真实原因（都不是超时）：
   *     ① `j.post === true` 太死 —— 模型给 `"post": "true"` / `1` / `"是"` 全判成不发 ✗
   *     ② content 空（内容写进了 `text` / `say` 之类）⇒ 长度闸把它掐掉 ✗
   *   ⇒ ① post 宽松认 true/1/yes/是/发
   *      ② content 兜底试 text / say / body / message / content_cn
   *      ③ 想发但没有正文 ⇒ **单独报一行**（别伪装成"决定了不发"）
   */
  const _truthy = (v) =>
    v === true || v === 1 || /^(true|yes|y|1|是|发|要)$/i.test(String(v ?? '').trim());
  const content = String(
    j.content ?? j.text ?? j.say ?? j.body ?? j.message ?? j.content_cn ?? '',
  ).trim();
  const postWanted = _truthy(j.post) || _truthy(j['发']) || _truthy(j.send) || _truthy(j.should_send);
  const post = postWanted && content.length > 0;
  if (postWanted && !content.length) {
    try {
      log.warn(
        `[空间] 模型想发但正文是空的｜字段只有：${Object.keys(j).join(',') || '(空)'}｜` +
          `原文前 300 字：${_rawText.slice(0, 300)}`,
      );
    } catch {}
  }
  // ⚠️ 一条说说**只配一张图**（用户明确要求）。
  //    以前这里读的是 faces 数组，现在只取第一张，兼容模型偶尔返回数组的情况。
  const faceList = (Array.isArray(j.faces) ? j.faces : j.face ? [j.face] : [])
    .map((x) => String(x).trim())
    .filter(Boolean);
  // 尽量别跟最近几条用过同一个标签（否则看起来老是同一张图）
  const recentlyUsed = new Set(
    (digest.posts?.() ?? []).slice(0, 3).map((p) => String(p.face ?? '').trim()).filter(Boolean),
  );
  const face = faceList.find((f) => !recentlyUsed.has(f)) ?? faceList[0] ?? '';
  return {
    post,
    type: ['funny', 'summary', 'thought'].includes(j.type) ? j.type : 'funny',
    content,
    face,
    faces: face ? [face] : [],
    reason: String(j.reason ?? '').trim(),
  };
}
