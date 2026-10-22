import { config } from "./src/config.js";
import * as quest from "./src/quest.js";
const cur = (config.llm.providers || [])[0];
const MODEL = "step-5-preview";
console.log("用模型:", MODEL, "|", cur.baseURL);
const ask = async (sys, user) => {
  for (let k = 0; k < 3; k++) {
    try {
      const r = await fetch(cur.baseURL.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + cur.apiKey },
        body: JSON.stringify({ model: MODEL, messages: [{ role: "system", content: sys }, { role: "user", content: user }], max_tokens: 900 }),
      });
      const j = await r.json();
      const c = String(j?.choices?.[0]?.message?.content ?? "").trim();
      if (c) return c;
    } catch (e) {}
    await new Promise((s) => setTimeout(s, 1000));
  }
  return "【失败】";
};
const lines = ["雨一直没停，回不去了，我就在爱音这儿，她那间屋子就一张床，两个人坐在床边，灯关了一半，都没提睡的事。我先开口，说她今天一直不太对劲，她过了很久才回我一句，你也没好到哪去。"];
const roles = ["丰川祥子（Saki）", "千早爱音（Anon）"];
for (let i = 0; i < 20; i++) {
  const who = roles[i % 2];
  const brief = quest.chatBrief("999000777", { recentLines: lines.slice(-80) });
  const sys = [`你就是${who}，第一人称，在群里跟另一个角色演同一条剧情。你写的话就是台词。`, brief].join("\n\n");
  const out = await ask(sys, `对方刚说：「${lines[lines.length - 1]}」\n\n轮到你接。`);
  lines.push(out);
  console.log(`\n[${i + 1} ${who.slice(0, 2)}] ${out.length > 210 ? out.slice(0, 210) + "…" : out}`);
}
