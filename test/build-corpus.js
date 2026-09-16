// 把精华消息、群公告、群历史整理成可读的纯文本，便于分析。
import { readFileSync, writeFileSync } from 'node:fs';

const seg2text = (segs = []) =>
  segs
    .map((s) => {
      const t = s.type;
      if (t === 'text') return s.data?.text ?? '';
      if (t === 'image') return '[图片]';
      if (t === 'face') return '[表情]';
      if (t === 'at') return `@${s.data?.qq}`;
      if (t === 'reply') return '[回复]';
      if (t === 'file') return `[文件:${s.data?.name ?? ''}]`;
      return `[${t}]`;
    })
    .join('');

const clean = (s) =>
  String(s ?? '')
    .replace(/&#10;/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();

const fmtTime = (sec) => (sec ? new Date(sec * 1000).toLocaleString('zh-CN', { hour12: false }) : '?');

const out = [];

// ── 精华消息 ──
const ess = JSON.parse(readFileSync('test/essence.json', 'utf8'));
out.push(`# 群精华消息（${ess.length} 条）\n`);
ess
  .slice()
  .sort((a, b) => a.operator_time - b.operator_time)
  .forEach((e, i) => {
    out.push(`## ${i + 1}. ${e.sender_nick} (${e.sender_id}) · ${fmtTime(e.operator_time)}`);
    out.push(clean(seg2text(e.content)));
    out.push('');
  });

// ── 群历史 ──
const hist = JSON.parse(readFileSync('test/gh-full.json', 'utf8'));
out.push(`\n\n# 群聊天记录（去重后 ${new Set(hist.map((m) => m.message_id)).size} 条）\n`);
const seen = new Set();
for (const m of hist.sort((a, b) => a.time - b.time)) {
  if (seen.has(m.message_id)) continue;
  seen.add(m.message_id);
  const who = m.sender?.card || m.sender?.nickname || m.user_id;
  out.push(`[${fmtTime(m.time)}] ${who}(${m.user_id}): ${clean(seg2text(m.message))}`);
}

writeFileSync('test/corpus.txt', out.join('\n'), 'utf8');
console.log(`已写出 test/corpus.txt，共 ${out.length} 行`);
console.log(`精华 ${ess.length} 条，历史唯一消息 ${seen.size} 条`);
