/* ⚠️ 2026-11-20：**本地模型（llama-server）的统一启动器**
 *
 * 用途（三处复用，别再各写一套）：
 *   ① 开机自启（`start-all.ps1` 调它）
 *   ② 界面「本地模型」卡片上的「启动 / 重启」按钮（webui 调它）
 *   ③ 命令行手动起
 *
 * 设计要点：
 *   · **幂等**：端口已经在听就直接返回（不会起第二个，抢显存）
 *   · **零窗口**：用 WMI `Win32_Process Create`（父进程是 WmiPrvSE，脱离调用者的 job）
 *   · **参数集中**：所有资源参数（上下文 / GPU 层 / KV 量化 / 线程 / 思考预算）都在
 *     `CONFIG` 里，改这里一处就生效 —— 界面卡片读的也是这份 ✓
 *   · 起完等 `/health` 通再返回（调用方不用自己轮询）
 *
 * 用法：
 *   node tools/local-model.mjs start        # 起（已在跑就跳过）
 *   node tools/local-model.mjs stop
 *   node tools/local-model.mjs restart
 *   node tools/local-model.mjs status --json
 */
import { existsSync, statSync, openSync, copyFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { dirname } from 'node:path';
import os from 'node:os';

export const CONFIG = {
  /** llama-server 可执行文件（winget 装的 ggml.llamacpp） */
  exe: 'C:\\Users\\<主人>\\AppData\\Local\\Microsoft\\WinGet\\Packages\\ggml.llamacpp_Microsoft.Winget.Source_8wekyb3d8bbwe\\llama-server.exe',
  /** 模型文件 */
  model: 'C:\\Users\\<主人>\\OneDrive - yijia\\文档\\ds1\\qq-ai-bot\\logs\\__llm\\qwen35-4b-q4km.gguf',
  /**
   * ⚠️⚠️⚠️ 2026-11-21 补：**视觉投影器**（llama.cpp 读图必须靠它）
   *
   *   `config.yml` 里 `vision.model: qwen3.5-4b` —— 也就是识图走本地这个模型。
   *   但 **llama-server 启动时从来没带过 `--mmproj`** ⇒ 模型根本没有视觉塔 ⇒
   *   **发给它的图片它一个像素都看不见**，识图结果全靠猜 ✗✗
   *
   *   ⇒ 加 `mmproj` 字段：**文件存在才拼 `--mmproj`**（不存在就照旧起，不会起不来）✓
   *   Qwen3.5-4B 官方配套：`mmproj-F16.gguf`（641 MB，unsloth 在 ModelScope 上发的）
   */
  mmproj: 'C:\\Users\\<主人>\\OneDrive - yijia\\文档\\ds1\\qq-ai-bot\\logs\\__llm\\mmproj-F16.gguf',
  /** 对外暴露的模型名（`/v1/models` 返回这个） */
  alias: 'qwen3.5-4b',
  host: '127.0.0.1',
  port: 18085,
  /**
   * 上下文窗口（token）—— **这是总量，会被 `parallel` 平分**
   *
   * ⚠️⚠️ 2026-11-20 从 65536 降到 **49152**（真事故：生成掉到 2.4 tok/s、回复空）——
   *   现场：`--parallel 2` 时每槽 = 65536/2 = 32768，KV cache 在显存里**翻倍** ⇒
   *     显存 7048/8188（86%），**系统内存只剩 0.6 GB** ⇒ Windows 疯狂换页 ⇒ 推理 2.4 tok/s ✗
   *   ⇒ 49152 时每槽 **24576**，装得下瘦身后的 lite.md（21653）+ 输出，显存也松出来 ✓
   *   ⚠️ 再往下砍就装不下了（lite.md 21653 ⇒ 每槽至少要 23000）✓
   */
  /* ⚠️⚠️⚠️ 2026-11-23 32768 → **40960**（真事故，缓存命中率突然掉到 0%）——
   *
   *   现场：<主人> 本人说话那一轮，提示词 **43,408 字 ≈ 32,247 token**
   *   （比普通群友多 6,337 字，因为「你和 <主人> 的关系」3148 + 「<主人> 专属知识」2841 只有他说话才加载）
   *   而 `config.yml` 的 `llm.maxTokens` 是 **8000** ⇒ 32,247 + 8,000 = **40,247 > 32,768** ✗
   *   ⇒ llama.cpp 装不下 ⇒ **从前面截掉 prompt** ⇒ 前缀全变 ⇒
   *     WebUI 显示「缓存 0，0%」、每次全量重算，还常常首轮生成空（`[思考链] 重跑`）✗✗
   *
   *   ⇒ 抬到 40960：32,247 + 8,000 = 40,247 < 40,960 ✓ 刚好装下
   *   ⚠️ 代价：KV cache 从 32,768 涨到 40,960（q4_0，约 +700MB）
   *   ⚠️ 上面那段"从 65536 降到 49152"的教训是 **parallel 2** 时的，现在 parallel 1 ⇒ 40960 安全 ✓ */
  ctx: 40960,
  /**
   * ⚠️ 2026-11-20 加：**启动后预热哪个号的人设**（`personas/<id>/prompt/lite.md`）
   *   ⚠️ 一个 llama-server 只有一个 cache：三个号的 lite.md 各 ~4.7 万 token，
   *      64k 上下文**装不下三份** ⇒ 只能预热最常用的那个（主号 saki）✓
   *      其他号第一次说话仍要付一次全量 prefill（这是架构限制，除非把 lite.md 砍短）
   */
  warmupPersona: 'saki',
  /** 卸载到 GPU 的层数（99 = 全部） */
  ngl: 99,
  /** CPU 线程数 */
  threads: 10,
  /** KV cache 量化：q4_0 省一半显存（4B + 64k 才塞得进 8G） */
  kvType: 'q4_0',
  /** 思考预算（token）：200 = 想 6 秒左右，剩下的留给正文 */
  reasoningBudget: 200,
  /**
   * ⚠️ 2026-11-21 加：**prefill 加速三件套**（首字延迟的主要成本在 prefill）
   *
   *   实测（`logs/__realish-test.mjs` + `llama-server.log`）：
   *     · 命中缓存时 prefill **0.95 秒**（23.6k token）
   *     · 没命中时 prefill **19.5 秒** ⇒ 1,213 tok/s
   *   1,213 tok/s 对一个 4B-Q4 在 4060 上明显偏低（正常该 3,000+）——
   *   默认 `-ub 512` 太小，每次只喂 512 token 进 GPU，中间不断空转 ✓
   *
   *   · `batch`  / `ubatch`：逻辑批 / 物理微批。抬到 2048/1024 ⇒ GPU 一次吃更多
   *   · `checkpointMinStep`：**最关键的一个** ——
   *     llama.cpp 的上下文检查点默认**每 8192 token 才落一个**（`-cms 8192`），
   *     所以"前缀一样、尾巴变了"时它只能退到 8k 的整数倍边界上复用，
   *     中间那 8k 全白算 ✗ → 降到 1024 ⇒ 复用粒度细 8 倍 ✓
   *     （`--ctx-checkpoints` 默认 32 个/槽，1024 × 32 = 32k，刚好覆盖整个 ctx ✓）
   */
  batch: 2048,
  ubatch: 1024,
  /**
   * ⚠️ 2026-11-21 实测记录（别再重复试这些，全是白费）：
   *   · `-ub 2048`（单独）⇒ 预热 210s、prefill **14s → 110s**、生成 40 → 17 ✗ 显存撑爆
   *   · `-ub 2048` + `-fa on` ⇒ 同样崩
   *   · `-b 4096` + `-ub 2048` ⇒ 起不来（预热超时）
   *   · **`-fa on`（单独）⇒ 1,982 / 1,990 tok/s，跟基线 1,959~1,999 没差别**（auto 本来就开了）
   *   · `-cram 8192 → 11264` / `--cache-reuse 256` ⇒ 不影响 prefill
   *   ⇒ 这台机器（4060 Laptop 8G，显存只剩 2.5G）**`-b 2048 -ub 1024 -fa auto` 就是最优**，
   *     prefill 稳定 **1,959 tok/s**（27,575 token ⇒ 14 秒）✓
   */
  flashAttn: 'auto',
  /* ⚠️⚠️ 2026-11-23 实验：`-cms 1024→512` + `-ctxcp 32→64`。
   *
   *   实测（真实 prompt 37,171 字，两轮只差末尾 0.4%）：
   *     第 1 轮 prefill 14,370ms / 28,169 token
   *     第 2 轮 prefill  7,179ms / **15,336 token**  ← 只复用掉 45%
   *   而两份提示词**公共前缀 37,039 字（99.6%）** ⇒ llama.cpp 只吃到 45%，
   *   和 `f_keep = 0.452` 完全对上 ⇒ 48% 的 token 白算。
   *   猜测是**检查点太稀**：32 个点 × 1024 步，槽里能精确命中的深度有限。
   *   ⇒ 点密度翻倍（64 × 512 = 同样盖住 32k），看 f_keep 能不能抬上去。
   *   ⚠️⚠️ 2026-11-23 **512 又改回 1024**（那次翻倍没抬上去，反而卡死了上限）：
   *
   *   实测：不管提示词多长（31,022 / 32,647 / 34,945），`cached` **恒定 29,708**。
   *   29,708 ≈ 58 × 512 ⇒ **恢复深度 = 实际存下的检查点个数 × 步长**。
   *   `-ctxcp 128` 写着 128 个，实际只存下 ~58 个（被内存 clamp 住）
   *   ⇒ 步长 512 时上限只有 29,696 token ⇒ 提示词一旦超过它，命中率就被钉死 ✗
   *
   *   ⇒ 步长抬回 1024 ⇒ 上限 ~58 × 1024 ≈ 59k ⇒ 完全覆盖 32k 的提示词 ✓
   *   ⚠️ 代价只是恢复粒度变粗（对齐到 1024 边界，少命中几十个 token），可以忽略。
   *   ⚠️ 别再把步长调小 —— 上限会跟着等比缩水，越调越糟 ✗ */
  checkpointMinStep: 1024,
  /**
   * ⚠️⚠️⚠️ 2026-11-21 关键发现（日志里那句是决定性的）：
   *
   *     slot select: selected slot by LCP similarity, f_sim_best = 1.000 (> 0.100 thold), **f_keep = 0.452**
   *
   *   ⇒ **相似度是 1.000（完全匹配），但 f_keep 只有 0.452** —— 一个槽只保留得住 45% 的 token，
   *     另外 55% 被丢掉重算 ✗ 这才是「同一个人连发两条也要等 14 秒」的真正机制，
   *     跟"谁抢槽"、"缓存被淘汰"都没关系 ✓
   *
   *   `f_keep` 由 **checkpoint 数量 × 间隔** 决定：
   *     默认 `-ctxcp 32`（每槽最多几个检查点）× `-cms 1024`（间隔）
   *     ⇒ 32 × 1024 = 32,768，看着刚好盖住 27,575 —— 但实测只保住 45% ✗
   *   ⇒ 把检查点数量抬上去（`-ctxcp`），让它能从更靠前的位置恢复 ✓
   *     ⚠️ 代价：每个检查点多占一点内存（`-cram` 现在 11 GB，够）✓
   */
  /* ⚠️⚠️ 2026-11-23 实验：64 → **128**。
   *
   *   现象：不管提示词多长，`cached` 恒定 **24,498 token** ——
   *     24,498 ÷ 512 ≈ 47.8，几乎正好是 **48 个检查点**的位置。
   *   ⇒ 高度怀疑是"槽里能精确恢复的深度"被检查点数量卡住
   *     （`-cms 512 × 48`，而不是 64 —— 说明实际存的比配置的少）。
   *   ⇒ 抬到 128（= 65,536 token 覆盖），看 `cached` 能不能过 24,498。
   *   ⚠️ `-cram 11264`（11GB RAM）放得下 ✓ */
  checkpointCount: 128,
  /**
   * ⚠️⚠️⚠️ 2026-11-21 加（「找一下首字生成慢的原因，现在还是速度很慢，包括连续发相同的消息」）——
   *
   *   实测证据（`llama-server.log`）：
   *     · 同一条长前缀连打三次 ⇒ prefill 10.88s → **0.08s** ⇒ 缓存机制本身没问题 ✓
   *     · 但真实请求**每次都 24,000~32,000 token 全量**（21.9 秒）✗
   *     · 近 2 万行日志里 `removing oldest entry` **157 次**，每条大 cache **156~252 MiB**，
   *       而 `-cram` 默认只有 **8192 MiB** ⇒ 只装得下 ~50 条 ✗
   *
   *   ⇒ 两个原因叠在一起：
   *     ① **cache 装不下**：三个号 + 好几个群交替 ⇒ 大条目互相挤，saki 那条最常被挤掉；
   *     ② **中间一改就全废**：`-lms` 只会在 1024 边界回退，
   *        而「群资料库」那段排在 lite.md 之后没多远 ⇒ 换群时后面 6,000 token 全重算 ✗
   *
   *   ⇒ ① `cacheRamMiB` 8192 → **11264**（+3G；本机 31.7G、空闲 5.8G，留够余量）
   *      ② **开 `--cache-reuse`**（默认 0 = 彻底禁用）：允许它把"中间变了、后面没变"
   *         的部分用 KV 搬过来 ⇒ 换群/换号时不用从头算 ✓
   *         ⚠️ 它靠 KV shift 实现，会动 RoPE 位置 —— 值的质量要实测，
   *            如果回复变差就把 `cacheReuse` 改回 0（其它参数无关）✓
   */
  /* ⚠️⚠️ 2026-11-23 实验：256 → **0**（禁用中间块复用，只走纯前缀匹配）。
   *
   *   现象：不管 checkpoint 抬到 64 还是 128，`cached` **恒定 24,498 token**
   *   （≈ lite.md 的 96%），提示词 29,255 时也一样 ⇒ 卡点不在检查点数量。
   *   而直接拿同一份 3.8 万字 prompt 连打两次，第 2 次是 **99.9% 命中** ⇒
   *   缓存机制本身没问题 ⇒ 嫌疑落在 `--cache-reuse` 的"块复用 + KV shift"上：
   *   它可能会把槽里的 KV 挪动，挪完就只能恢复到某个位置 ✗
   *   ⇒ 先关掉（0 = 只做纯前缀匹配，最保守也最可预测），看 `cached` 能不能过 24,498。 */
  cacheReuse: 256,
  cacheRamMiB: 11264,
  /**
   * 并发 slot
   * ⚠️⚠️ 2026-11-20 从 1 改成 **2**（真事故：saki 完全不回消息）——
   *   现场日志：
   *     `[04:26:09] 生成失败: fetch failed / UND_ERR_CONNECT_TIMEOUT`
   *     `[04:26:16] [说话判断] 出错（说话判断超时）→ 这 条不接`
   *     `[04:28:35/04:29:13/04:29:17] 说话判断超时 → 不接`
   *   根因：`--parallel 1` 时 llama-server **只有一个处理槽**，
   *     主生成触发 4.7 万 token prefill（实测 108 秒）期间**整个槽被独占**
   *     ⇒ 「说话判断」「润色」这些辅助请求连 TCP 都排不进去
   *     ⇒ `UND_ERR_CONNECT_TIMEOUT` ⇒ 判断失败 ⇒ **判不过就不接** ⇒ 一条都不回 ✗✗
   *   ⇒ 2 个 slot：主生成占一个，辅助请求用另一个，互不堵死 ✓
   *   ⚠️ 代价：KV cache 大概多占 0.9G（64k 上下文 q4），显存要留够 ✓
   */
  parallel: 1,
  /**
   * ⚠️ 2026-11-20 加：**llama-server 自己的日志文件**（用它的 `--log-file`）
   *
   *   原来我把 spawn 的 stdout/stderr 指到一个 fd 上，但那台机器上**文件根本没生成**
   *   ⇒ 出了「生成只有 6.4 tok/s」这种问题**完全看不到原因**（拿不到 offload 报告）✗
   *   ⇒ 改用 llama.cpp 内置的 `--log-file`（它自己写盘，最可靠）
   *   ⚠️ 这份日志还被 `status()` 解析出「**多少层真的进了 GPU**」，显示在卡片上 ✓
   */
  logFile: 'C:\\Users\\<主人>\\OneDrive - yijia\\文档\\ds1\\qq-ai-bot\\logs\\llama-server.log',
  /** 起完等多久算超时 */
  readyTimeoutMs: 120000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`, ...a);

/** 总内存 / 空闲内存（GB，node 原生，零子进程） */
function totalMemGB() {
  return Number((os.totalmem() / 1073741824).toFixed(1));
}
function freeMemGB() {
  return Number((os.freemem() / 1073741824).toFixed(1));
}

/** 端口有人在听吗（不依赖 netstat 的权限） */
async function portAlive(port = CONFIG.port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500) });
    if (r.ok) {
      const j = await r.json().catch(() => null);
      return j?.status === 'ok';
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * ⚠️⚠️ 2026-11-20 加（用户：「**启动之后状态显示明显是正常的，启动不正常一定要能显示和问题**」）——
 *
 *   `/health ok` **只代表 HTTP 服务在听**，不代表能推理：
 *   内存被打满时（实测：java 吃 14.7G，只剩 0.8G）它会接受连接、
 *   然后**推理卡死几十秒**，而卡片上照样显示"正常" ⇒ 用户以为好了，其实一条都回不出来 ✗
 *
 *   ⇒ 这里**真发一次最小推理**（`max_tokens:1`）当探活，这才是"能用"的唯一标准 ✓
 *   ⚠️ 超时给 25 秒：正常 4B 首字 <1 秒；25 秒还没回 = 这台机器现在跑不动它 ✓
 */
export async function probe(timeoutMs = 25000) {
  const t0 = Date.now();
  try {
    const r = await fetch(`http://127.0.0.1:${CONFIG.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: CONFIG.alias,
        messages: [{ role: 'user', content: '数三个数：一、二、三' }],
        /* ⚠️ 2026-11-20 改（用户：「**再显示一下 token 实时速度**」）——
         *   原来 `max_tokens: 1` 拿不到生成速度（`predicted_per_second` 只有 1 个样本，不准）
         *   ⇒ 给 **24 token**：够算出稳定的 tok/s，又不至于让卡片刷新变慢（约 0.5 秒）✓
         *   ⚠️ 结果缓存 30 秒（见 `status()`），别每 2 秒真跑一次 ✓ */
        max_tokens: 24,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Date.now() - t0;
    if (!r.ok) return { ok: false, ms, error: `推理接口返回 HTTP ${r.status}` };
    const j = await r.json().catch(() => null);
    if (!j?.choices?.length) return { ok: false, ms, error: '推理返回里没有 choices（服务异常）' };
    const t = j.timings ?? {};
    return {
      ok: true,
      ms,
      /** 生成速度（token/秒）—— 卡片上那个实时速度就是它 */
      tps: Number(t.predicted_per_second) || 0,
      prefillMs: Number(t.prompt_ms) || 0,
      tokens: Number(t.predicted_n) || 0,
    };
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, error: String(e?.message ?? e) };
  }
}

/**
 * ⚠️⚠️ 2026-11-20 加：**预热前缀**（把 lite.md 的 prompt cache 先算好）
 *
 *   实测（`logs/__cache-test.mjs`）：
 *     · 首次（缓存空）：prefill **108.6 秒**（47438 token）
 *     · 之后相同前缀：prefill **0.6 秒**（命中 47434 token）
 *   ⇒ 每次重启 llama-server，缓存全清 ⇒ **第一条消息要等 108 秒**
 *     （而 `llm.timeout` 是 120 秒，就卡在边缘）✗✗
 *
 *   ⇒ 服务起来后**立刻**把 lite.md 当 system 喂一次（`max_tokens:1`），
 *     让这段最长的固定前缀先算进 cache ⇒ 用户第一条消息只付增量 ✓
 *
 *   ⚠️ 超时给 180 秒（首次真的慢）；失败只记一笔，不影响"启动成功"的判定 ✓
 *   ⚠️ 只喂 lite.md（`personas/<id>/prompt/lite.md` 三个号内容不同）
 *     ⇒ 三个号各自预热一次（谁的进程起来就预热谁那份）✓
 *
 * ⚠️⚠️⚠️ 2026-11-21 重写（**原来这份预热一点用都没有**）——
 *
 *   实测：Qwen 的 chat template 把 tools **放在最前面的那条 system 里**
 *   （`{%- if tools %}{{- '<|im_start|>system\n' -}}{{- "# Tools\n..." }}`）⇒
 *   带 tools 的请求和不带 tools 的请求，**从第 0 个 token 就不同**
 *   ⇒ 原来只喂 `lite.md`（没 tools）算出来的缓存，
 *     对真实的聊天请求（带 19/24 个 tools）**一个字都用不上** ✗
 *
 *   实测数据（`logs/__latency-probe.mjs`）：
 *     · 不带 tools 的 prompt 总长 21,389 token
 *     · 带 19 个 tools 的 23,593 token（+2,204）
 *     · 两者的公共前缀 = **0**（cache_n 交叉验证过）
 *
 *   ⇒ 现在按**真实请求的形状**预热，而且把最常出现的两种工具口径都热一遍：
 *     · 群友口径（`owner:false`，19 个）—— 绝大多数消息
 *     · 主人口径（`owner:true`，24 个）—— 他说话时
 *     ⚠️ 两遍都是 21k+ token 的 prefill，首次约 15~25 秒/遍（
 *        缓存已有的话只要 0.2 秒）；放在**启动流程**里，不占用户的时间 ✓
 */
export async function warmup(personaId = 'saki', timeoutMs = 180000) {
  try {
    const fs = await import('node:fs');
    const { readFileSync, existsSync, readdirSync, statSync } = fs;
    const { join } = await import('node:path');

    /* ⚠️⚠️ 2026-11-23 改：**优先用"最近一次真实拼出来的 system"预热**。
     *
     *   原来只喂 `personas/<id>/prompt/lite.md`（≈25,700 token），
     *   可真实请求的 system 是 `buildLitePrompt()` 拼出来的（≈28,900 token）——
     *   多出来的群友表 / 识图 / 此刻状态 / 历史 / 她刚说的那些**全在 lite.md 之外**
     *   ⇒ 预热只能覆盖前 85%（实测重启后第一轮 cached 24,675 / 28,894 = 85.4%）✗
     *
     *   `bot.js` 每轮都会把真实 system 落盘到 `logs/_prompt-<群>.last.txt`
     *   ⇒ **拿它当预热 prompt**，覆盖度到 ~96%，重启后第一轮不用再吃一次冷启动 ✓
     *   ⚠️ 没有 dump（全新环境）就回退 lite.md，老行为不变 ✓ */
    let sys = '';
    let warmSource = '';
    try {
      const dir = join(process.cwd(), 'logs');
      const cands = readdirSync(dir)
        .filter((f) => /^_prompt-.+\.last\.txt$/.test(f))
        .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (cands.length) {
        const t = readFileSync(join(dir, cands[0].f), 'utf8');
        // 太短的 dump 不靠谱（可能是半截），至少 20,000 字才用
        if (t && t.length > 20000) {
          sys = t;
          warmSource = cands[0].f;
        }
      }
    } catch {}

    if (!sys) {
      const f = join(process.cwd(), 'personas', personaId, 'prompt', 'lite.md');
      if (!existsSync(f)) return { ok: false, error: `没有 ${f}` };
      sys = readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
      warmSource = 'lite.md';
    }
    if (!sys) return { ok: false, error: '预热内容为空' };

    /* ⚠️ 工具清单：必须和 `bot.js` 那次 `buildTools({group,owner,workChat,hasUpload,lite})`
     *   **一模一样**，否则前缀又对不上。取值按最常见的群里场景：
     *   `group:true / workChat:false / hasUpload:false / lite:false`
     *   （`lite` 是"极简模式下不给工具"，而 `config.llm.lite.tools` 为 true 时会给，
     *     这里按"给"来算 —— 也就是 bot.js 里 `lite: false` 那个分支 ✓） */
    let toolSets = [];
    try {
      const { buildTools } = await import('../src/tools-fc.js');
      const base = { group: true, workChat: false, hasUpload: false, lite: false };
      /* ⚠️⚠️ 2026-11-23 顺序**必须是「先主人、后群友」** ——
       *   `-parallel 1` 只有一个槽，**最后一次预热的那份才留在槽里**。
       *   原来先群友后主人 ⇒ 槽里最后是"主人"那套 tools ⇒ 群友一说话，
       *   tools 就对不上 ⇒ 整个 prompt 从开头就不一样 ⇒ cached 直接 0（实测重启后第一轮 0%）✗
       *   而群里绝大多数是**群友**说话 ⇒ 让群友那套最后跑，占住槽 ✓ */
      toolSets = [
        { name: '主人', tools: buildTools({ ...base, owner: true }) },
        { name: '群友', tools: buildTools({ ...base, owner: false }) },
      ];
    } catch (e) {
      /* 拿不到 tools 就退回"只热文本"（至少比什么都不热强） */
      toolSets = [{ name: '无 tools', tools: [] }];
    }

    const t0 = Date.now();
    const detail = [];
    for (const ts of toolSets) {
      const r = await fetch(`http://127.0.0.1:${CONFIG.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: CONFIG.alias,
          messages: [
            { role: 'system', content: sys },
            { role: 'user', content: 'hi' },
          ],
          ...(Array.isArray(ts.tools) && ts.tools.length ? { tools: ts.tools, tool_choice: 'auto' } : {}),
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) {
        detail.push(`${ts.name}: HTTP ${r.status}`);
        continue;
      }
      const j = await r.json().catch(() => null);
      const tt = j?.timings ?? {};
      detail.push(`${ts.name}: 新算 ${tt.prompt_n ?? '?'} 命中 ${tt.cache_n ?? '?'}`);
    }
    const ms = Date.now() - t0;
    return { ok: detail.length > 0, ms, detail, source: warmSource, chars: sys.length };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }
}

/**
 * ⚠️ 2026-11-20 加（用户：「**如果因为内存不够就执行一次内存清理，可以把不重要的进程移到虚拟内存**」）——
 *
 *   做法：对**明确不重要**的那些进程调 `EmptyWorkingSet`（把工作集刷进页面文件），
 *   进程不死、只是下次访问要读回（会慢一下）✓
 *
 *   ⚠️ 白名单很窄：**只碰浏览器/聊天/壁纸这类**，`java`（MC 服务端）、`llama-server`、
 *      `node`（机器人自己）、`explorer`、系统进程**一律不碰** ✗
 *   ⚠️ 只有"启动失败 + 内存不足"时才调一次（不是定时跑，避免抖）✓
 *   ⚠️ 用 PowerShell 调 API（node 没有 Windows 内存 API）—— 只在这一刻起一个进程，
 *      而且带 `windowsHide`；比起"每 2 秒弹一次"已经好太多 ✓
 */
/**
 * ⚠️ 2026-11-20（用户：「**如果因为内存不够就执行一次内存清理，可以把不重要的进程移动进虚拟内存**」）——
 *
 *   实现搬到 `tools/trim-memory.mjs`：用**独立 .ps1 + Win32 EmptyWorkingSet**。
 *   为什么不在这个文件里内联：`Add-Type -TypeDefinition @"…"@` 的 here-string
 *   **必须独占一行**，用 `;` 拼成一行会直接语法错（实测踩过两次）✗
 *
 *   ⚠️ 白名单很窄：只碰浏览器 / 聊天 / 壁纸类；
 *      `java`(MC 服务端) / `llama-server` / `node`(机器人自己) / `explorer` 一律不碰 ✓
 *   ⚠️ 只在"启动后推理不响应、且内存不足"时调一次（不是定时跑）✓
 */
let _trimFn = null;
async function trimMemory() {
  try {
    if (!_trimFn) {
      const m = await import('./trim-memory.mjs');
      _trimFn = m.trimMemoryNow;
    }
    return _trimFn();
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e).slice(0, 160) };
  }
}

/**
 * 找出占着这个端口的 llama-server（**不用 PowerShell**）
 *
 * ⚠️⚠️ 2026-11-20 改（用户：「**那个黑窗是弹出来马上闪退的**」）——
 *   原来这里用 `powershell Get-CimInstance Win32_Process` 查进程：
 *     · 每调一次就起一个 PowerShell ⇒ 控制台窗口闪一下（`windowsHide` 在这台机器上没完全挡住）
 *     · 卡片**每 2 秒轮询一次** ⇒ 每 2 秒闪一个 ✗✗
 *   ⇒ 改用 **`netstat -ano`**：纯文本、不起控制台、几十毫秒返回 ✓
 *   ⚠️ 代价：拿不到 CommandLine（卡片上"完整命令行"那一栏会空着；
 *      真实参数在 `CONFIG` 里，卡片已经逐项列出来了）✓
 */
export function processes() {
  try {
    const out = execFileSync('netstat', ['-ano'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
    });
    const pids = new Set();
    for (const line of String(out).split('\n')) {
      if (!line.includes(`:${CONFIG.port}`)) continue;
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0) pids.add(pid);
    }
    return [...pids].map((pid) => ({ ProcessId: pid }));
  } catch {
    return [];
  }
}

/**
 * ⚠️⚠️ 2026-11-20 加（用户：「**百分之多少在 GPU 上也要显示出来**」）——
 *
 *   从 llama-server 日志里解析「**到底多少层真的卸载到了 GPU**」。
 *   为什么必须显示：`-ngl 99` 只是"请求全部卸载"，**显存不够时 llama.cpp 会自己少卸几层**
 *   并且只在日志里说一句 ⇒ 页面上看着"正常"，实际有一半在 CPU 上跑 ⇒
 *   生成只有 6.4 tok/s（正常 47）✗ 这种问题**光看卡片发现不了**。
 *
 *   ⚠️ 日志里那行的形态（不同版本略有差异，都认）：
 *     `load_tensors: offloaded 33/33 layers to GPU`
 *     `llm_load_tensors: offloaded 25/33 layers to GPU`
 *     `offloading 33 repeating layers to GPU`
 *   ⚠️ 解析不到 ⇒ 返回 null（卡片显示"未知"，不编一个数）✓
 */
export function gpuLayers() {
  try {
    if (!existsSync(CONFIG.logFile)) return null;
    /* ⚠️ 2026-11-20 修：llama-server 一直占着日志文件（Windows 独占写），
     *   `readFileSync` 会抛 EBUSY/EPERM ⇒ 原来一直返回 null ✗
     *   ⇒ **先复制一份**（copyFile 通常能成功，它用共享读），再读副本 ✓ */
    let text = '';
    try {
      text = readFileSync(CONFIG.logFile, 'utf8');
    } catch {
      const tmp = `${CONFIG.logFile}.read`;
      try {
        copyFileSync(CONFIG.logFile, tmp);
        text = readFileSync(tmp, 'utf8');
      } catch (e2) {
        lastGpuLayersError = `读不到日志（${String(e2?.message ?? e2).slice(0, 80)}）`;
        return null;
      }
    }
    const hay = text.slice(0, 400000) + '\n' + text.slice(-100000);
    const m1 = hay.match(/offloaded\s+(\d+)\s*\/\s*(\d+)\s+layers?\s+to\s+GPU/i);
    if (m1) {
      const off = Number(m1[1]);
      const total = Number(m1[2]);
      return { offloaded: off, total, percent: total ? Math.round((off / total) * 100) : 0 };
    }
    // ② 次选 `offloading N repeating layers to GPU` + `n_layer = M`
    const m2 = tail.match(/offloading\s+(\d+)\s+repeating\s+layers?\s+to\s+GPU/i);
    const m3 = tail.match(/n_layer\s*=\s*(\d+)/i);
    if (m2 && m3) {
      const off = Number(m2[1]);
      const total = Number(m3[1]);
      return { offloaded: off, total, percent: total ? Math.round((off / total) * 100) : 0 };
    }
    return null;
  } catch (e) {
    /* ⚠️ 2026-11-20：**把错误说出来** —— 原来静默返回 null，
     *   结果"日志明明有 offloaded 33/33 却解析不出来"查了很久（是 Windows 上文件被独占读不了）✗ */
    lastGpuLayersError = String(e?.message ?? e).slice(0, 120);
    return null;
  }
}
let lastGpuLayersError = '';
/** ⚠️ 2026-11-20：探活结果缓存（卡片 2 秒刷新，不能每次都真跑推理） */
let probeCache = { at: 0, v: { ok: false, error: '还没测' } };

export async function status() {
  const procs = processes();
  const alive = await portAlive();
  let models = [];
  if (alive) {
    try {
      const r = await fetch(`http://127.0.0.1:${CONFIG.port}/v1/models`, { signal: AbortSignal.timeout(2500) });
      const j = await r.json();
      models = (j?.data ?? []).map((x) => x.id);
    } catch {}
  }
  /* ⚠️ 2026-11-20：「health ok」**不等于能用**（见 probe() 那段）——
   *   · `alive` = HTTP 服务在听
   *   · `infer` = **真能推理**（会真发一次 24 token 的小请求）
   *   ⚠️ 结果**缓存 30 秒**：卡片是 2 秒刷新的，每 2 秒真跑一次推理会白烧 GPU ✓
   *   ⚠️ 速度（tok/s）就是这次探活测出来的 —— 卡片上那个"实时速度"✓ */
  const now = Date.now();
  if (alive && !(probeCache.at && now - probeCache.at < 30000)) {
    probeCache = { at: now, v: await probe(25000) };
  }
  const pr = alive ? probeCache.v : { ok: false, ms: 0, error: '没在跑' };
  const size = existsSync(CONFIG.model) ? statSync(CONFIG.model).size : 0;
  return {
    ok: alive,
    infer: pr.ok,
    inferMs: pr.ms,
    inferError: pr.ok ? '' : pr.error,
    /** ⚠️ 生成速度（token/秒）—— 卡片上的「实时速度」 */
    tps: pr.ok ? pr.tps : 0,
    /** ⚠️ 这次探活的 prefill 耗时（验证 prompt cache 有没有命中） */
    prefillMs: pr.ok ? pr.prefillMs : 0,
    gpuLayers: alive ? gpuLayers() : null,
    port: CONFIG.port,
    alias: CONFIG.alias,
    model: CONFIG.model,
    modelName: String(CONFIG.model).split(/[\\/]/).pop(),
    modelGB: +(size / 1073741824).toFixed(2),
    models,
    pids: procs.map((p) => Number(p.ProcessId)),
    startedAt: procs[0]?.CreationDate ? String(procs[0].CreationDate) : '',
    /* ⚠️⚠️ 2026-11-20 修（用户截图：「**完整命令行**」那栏显示「（没在跑）」，可模型明明在跑）——
     *   根因：`processes()` 为了不弹窗改用了 `netstat -ano`，**拿不到 CommandLine** ⇒
     *   这里 `String(procs[0]?.CommandLine ?? '')` 永远是空串 ⇒ 卡片判定成"没在跑" ✗
     *   ⇒ 拿不到就**按 CONFIG 拼一条等效的**（参数就是实际在用的那份）✓ */
    cmd:
      String(procs[0]?.CommandLine ?? '').trim() ||
      (alive
        ? [
            `"${CONFIG.exe}"`,
            '-m', `"${CONFIG.model}"`,
            ...(CONFIG.mmproj && existsSync(CONFIG.mmproj) ? ['--mmproj', `"${CONFIG.mmproj}"`] : []),
            '--host', CONFIG.host,
            '--port', String(CONFIG.port),
            '-c', String(CONFIG.ctx),
            '-t', String(CONFIG.threads),
            '-ngl', String(CONFIG.ngl),
            '--parallel', String(CONFIG.parallel),
            '-a', CONFIG.alias,
            '-ctk', CONFIG.kvType,
            '-ctv', CONFIG.kvType,
            '--reasoning-budget', String(CONFIG.reasoningBudget),
            '-b', String(CONFIG.batch),
            '-ub', String(CONFIG.ubatch),
            '-cms', String(CONFIG.checkpointMinStep),
            '--log-file', CONFIG.logFile,
          ].join(' ')
        : ''),
    config: { ...CONFIG },
  };
}

export async function start() {
  if (await portAlive()) return { ok: true, already: true, ...(await status()) };
  if (!existsSync(CONFIG.exe)) throw new Error(`llama-server 不存在：${CONFIG.exe}`);
  if (!existsSync(CONFIG.model)) throw new Error(`模型文件不存在：${CONFIG.model}`);

  /* ⚠️⚠️ 2026-11-20 重写（用户：「**连续弹窗**」+「**刚才我点启动内置模型又启动**」）——
   *
   *   原来用 `execFileSync('powershell', WMI Create)` 起 llama-server：
   *   每点一次「启动」就**起一个 PowerShell 进程** ⇒ 闪一个窗 ✗✗
   *
   *   ⇒ 改成 **node 原生 `spawn`**：`detached + windowsHide + stdio:'ignore'`
   *     - `detached:true`：活过本进程（卡片接口是 webui 进程，重启 webui 不该带走模型）
   *     - `windowsHide:true`：**零窗口**（这条在 node 直接 spawn 上有效；powershell 5.1 反而无效）
   *   ⚠️ 日志重定向到文件：进程是 detached 的，出错只能靠日志看 ✓
   */
  const args = [
    '-m', CONFIG.model,
    /* ⚠️⚠️ 2026-11-22 补：**视觉投影器**（`--mmproj`）。
     *   2026-11-22 12:xx 之前这条**从来没拼过**（`CONFIG.mmproj` 只定义了字段），
     *   所以模型虽然挂着 `vision.model: qwen3.5-4b`，**根本没有视觉塔**：
     *   任何带 `image_url` 的请求都 500「image input is not supported - hint: ... provide the mmproj」✗
     *   ⇒ 文件存在才拼（不存在照旧起，不会起不来），`-ngl` 会把它一起放进显存 ✓ */
    ...(CONFIG.mmproj && existsSync(CONFIG.mmproj) ? ['--mmproj', CONFIG.mmproj] : []),
    '--host', CONFIG.host,
    '--port', String(CONFIG.port),
    '-c', String(CONFIG.ctx),
    '-t', String(CONFIG.threads),
    '-ngl', String(CONFIG.ngl),
    '--parallel', String(CONFIG.parallel),
    '-a', CONFIG.alias,
    '-ctk', CONFIG.kvType,
    '-ctv', CONFIG.kvType,
    '--reasoning-budget', String(CONFIG.reasoningBudget),
    /* ⚠️ 2026-11-21 加：批大小 + 检查点粒度（见 CONFIG 里那段注释） */
    '-b', String(CONFIG.batch),
    '-ub', String(CONFIG.ubatch),
    '-cms', String(CONFIG.checkpointMinStep),
    /* ⚠️ 2026-11-21：每槽检查点数量（默认 32 ⇒ 实测 f_keep 只有 0.452，抬到 128 试） */
    '-ctxcp', String(CONFIG.checkpointCount ?? 32),
    /* ⚠️ 2026-11-21：中间段复用（默认 0=禁用）+ 加大 prompt cache 容量（见 CONFIG 里那段注释） */
    '--cache-reuse', String(CONFIG.cacheReuse ?? 0),
    '-cram', String(CONFIG.cacheRamMiB ?? 8192),
    /* ⚠️ 2026-11-21：单独测 Flash Attention（不动 ubatch） */
    '-fa', String(CONFIG.flashAttn ?? 'auto'),
    /* ⚠️ 2026-11-20：日志交给 llama.cpp 自己写（`--log-file`）——
     *   用 spawn 的 fd 重定向在这台机器上没生效过（文件压根没生成）✗
     * ⚠️⚠️ **千万别开 `--log-verbose`**：它会**每个 token 写一行日志**（实测日志 500KB+），
     *   生成速度直接从 40+ 掉到 **6.4 tok/s** —— 磁盘 IO 把推理拖死了 ✗✗
     *   只留默认级别，够看到 `offloaded 33/33 layers to GPU` 那几行就够 ✓ */
    '--log-file', CONFIG.logFile,
  ];
  const logFile = CONFIG.logFile || `${CONFIG.model}.server.log`;
  let outFd = 'ignore';
  try {
    outFd = openSync(logFile, 'a');
  } catch {}
  const child = spawn(CONFIG.exe, args, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', outFd, outFd],
    cwd: dirname(CONFIG.exe),
  });
  child.unref();
  const pid = Number(child.pid) || 0;

  const t0 = Date.now();
  /* ⚠️ 2026-11-20 改：**判活标准从 /health 改成"真能推理"**（见 `probe()` 那段注释）
   *   /health ok 但推理卡死 ⇒ 卡片显示"正常"、实际一条都回不出来 ✗ */
  while (Date.now() - t0 < CONFIG.readyTimeoutMs) {
    if (await portAlive()) {
      const p = await probe();
      if (p.ok) {
        /* ⚠️⚠️ 2026-11-20 加（用户：「**不要第一条消息再 prefill，启动之后自动 prefill**」）——
         *   预热放在**启动流程里**，不留给第一条真实消息：
         *     首次 prefill 47438 token = **108 秒**（实测），而 llm.timeout 是 120 秒 ⇒
         *     用户发第一条消息时要干等近两分钟，还容易撞超时 ✗
         *   ⇒ 起来后立刻把 lite.md 喂一遍（`max_tokens:1`），把这段最长前缀先算进 cache；
         *     之后真实消息只付增量（实测 0.6 秒）✓
         *   ⚠️ 预热失败**不算启动失败**（模型能用，只是第一条慢点）✓ */
        let warm = null;
        try {
          log('  预热 prompt cache（首次约 100 秒，之后每条只付增量）…');
          warm = await warmup(CONFIG.warmupPersona || 'saki');
          log(warm.ok ? `  ✅ 预热完成（${(warm.ms / 1000).toFixed(0)} 秒｜用 ${warm.source ?? '?'} ${warm.chars ?? '?'} 字｜${(warm.detail || []).join(' · ')}）` : `  ⚠️ 预热失败：${warm.error}`);
        } catch (e) {
          log(`  ⚠️ 预热异常：${String(e?.message ?? e).slice(0, 120)}`);
        }
        return { ok: true, pid, ms: Date.now() - t0, probe: p, warmup: warm, ...(await status()) };
      }
      // 起来了但不能推理 ⇒ 先清一次内存再试（用户要求：「内存不够就执行一次内存清理」）
      log(`  health ok 但推理不响应（${p.error}）⇒ 清一次内存再试`);
      const trimmed = await trimMemory();
      log(`  内存整理：${trimmed.ok ? `释放 ${trimmed.freedMB} MB / ${trimmed.processes} 个进程` : `失败 ${trimmed.error}`}`);
      const total = totalMemGB();
      const free = freeMemGB();
      if (free < 1.5) {
        throw new Error(
          `内存不足（总 ${total} GB，只剩 ${free} GB）⇒ 模型起来了但推理卡住。` +
            `已尝试整理内存（释放 ${trimmed.freedMB ?? 0} MB）仍不够 —— 请关掉占内存大的程序（MC 服务端 / 浏览器）后重试`,
        );
      }
      const p2 = await probe();
      if (p2.ok) return { ok: true, pid, ms: Date.now() - t0, probe: p2, trimmed, ...(await status()) };
      throw new Error(`模型能连上但**推理不响应**（${p2.error}，${Math.round(p2.ms / 1000)} 秒）—— 多半是内存/显存不够`);
    }
    await sleep(2000);
  }
  throw new Error(`等了 ${Math.round(CONFIG.readyTimeoutMs / 1000)} 秒还没就绪（PID ${pid}，日志：${logFile}）`);
}

export async function stop() {
  const procs = processes();
  for (const p of procs) {
    try {
      process.kill(Number(p.ProcessId));
    } catch {}
  }
  // 等端口真的放掉
  for (let i = 0; i < 15; i++) {
    if (!(await portAlive())) return { ok: true, killed: procs.length };
    await sleep(800);
  }
  // 还不掉就强杀
  for (const p of procs) {
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', `Stop-Process -Id ${Number(p.ProcessId)} -Force -ErrorAction SilentlyContinue`], { timeout: 10000, windowsHide: true });
    } catch {}
  }
  return { ok: !(await portAlive()), killed: procs.length };
}

export async function restart() {
  await stop();
  await sleep(1500);
  return start();
}

// ── CLI ──
const isCli = (() => {
  try {
    return process.argv[1] && /local-model\.mjs$/.test(process.argv[1]);
  } catch {
    return false;
  }
})();

if (isCli) {
  const cmd = String(process.argv[2] ?? 'status').toLowerCase();
  const json = process.argv.includes('--json');
  try {
    let r;
    if (cmd === 'start') r = await start();
    else if (cmd === 'stop') r = await stop();
    else if (cmd === 'restart') r = await restart();
    else r = await status();
    if (json) console.log(JSON.stringify(r, null, 2));
    else if (cmd === 'status') console.log(`本地模型：${r.ok ? '在跑' : '没跑'}｜端口 ${r.port}｜模型 ${r.modelName} (${r.modelGB} GB)｜PID ${r.pids.join(',') || '-'}`);
    else console.log(`${cmd} 完成：`, JSON.stringify(r));
    process.exit(0);
  } catch (e) {
    console.error(`${cmd} 失败：${e.message}`);
    process.exit(1);
  }
}
