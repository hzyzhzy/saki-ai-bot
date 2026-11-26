// 把 AGENTS 里三小节（客户端组件 / 已知缺口 / 座位要点）搬进 anode 文档，给"项目文档怎么用"腾预算。
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

// ① 追加到 anode 文档
const annex = `

---

## 从 AGENTS.md 搬过来的（2026-11-27，为"项目文档怎么用"那条规矩腾预算）

### 客户端模式（Anon 这条路）的组件

要点：\`qq-onebot.mjs\` 是假 OneBot（6700 给 bot 连）、\`qq-daemon.py\` 座位读屏、
\`看门狗（隐藏）.vbs\` 卡死自动重启、\`启动Saki全流程（隐藏）.vbs\` 零窗口一键。

### 已知缺口（客户端模式才有，SL 那边不受影响）

- **私聊读不到也发不出** ✗ · **引用只能读不能发** ✗
- **QQ 空间**：客户端侧栏那个图标是内嵌 WebView，登录态共享 ⇒ 可做 UIA 自动化 ✓
- 完整清单见本文件上面那几节（19 个 action / \`src\` 里 35 个调用）

### 座位（anode）要点

**\`anode status\` 报 \`Anode is not running\` 就是整个座位没了**（QQ / daemon 全死，看起来"完全离线"）。
租约 \`--ttl 600\` 最长 10 分钟、\`anode display\` 绑租约；座位 session 号会变（见过 2 和 3），别硬编码。
`;
appendFileSync('docs/anode模式-能力清单与长期目标.md', annex, 'utf8');

// ② AGENTS 里那三小节压成两行指路
const p = 'AGENTS.md';
let t = readFileSync(p, 'utf8');
const start = t.indexOf('### 客户端模式（Anon 这条路）的组件');
const end = t.indexOf('租约 `--ttl 600` 最长 10 分钟、`anode display` 绑租约；座位 session 号会变（见过 2 和 3），别硬编码。');
if (start < 0 || end < 0) throw new Error('锚点找不到');
const endAt = end + '租约 `--ttl 600` 最长 10 分钟、`anode display` 绑租约；座位 session 号会变（见过 2 和 3），别硬编码。'.length;

const shrunk = `### 客户端模式（anode）的细节都在文档里

组件 / 已知缺口（私聊读不到发不出、引用只能读不能发、QQ空间可做 UIA）/ 座位要点（\`anode status\` 说 not running 就是整座没了）：
📎 \`docs/anode模式-能力清单与长期目标.md\`（搜「从 AGENTS.md 搬过来的」）`;

t = t.slice(0, start) + shrunk + t.slice(endAt);
writeFileSync(p, t, 'utf8');
console.log('已搬走三小节；AGENTS 现在', t.length, '字节');
