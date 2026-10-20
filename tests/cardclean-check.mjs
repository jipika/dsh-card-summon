import http from "node:http";
import { existsSync } from "node:fs";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * 卡片字段清洁度验证（用户：「没有的字段就直接不显示，不要空的留在那里」）。
 *
 * 背景：截图里卡片显示过三种噪音，都定位到具体来源并修掉：
 *   · 「未分类 · 人设 0 字 / 开场白 1448 字」← lib/local.js 的 tagline 拼串（非简介，是元数据堆砌）
 *   · 「local:」      ← creator 回退到 fullPath.split("/")[0]，对 local:// 取首段得 "local:"
 *   · 「未分类」chip ← 目录默认值占 8212/11480，不是真分类
 * 本测试断言 host 返回的数据里这些噪音都不再出现。
 */
const LIB = "/Volumes/mac/下载/26.6角色卡/26.7月全中文备注角色卡（14000➕）";
const calls = { routes: [], tools: {} };
const ctx = {
  effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
  on: () => () => {}, systemPrompt: { section: () => () => {} },
  tools: { register: (d) => { calls.tools[d.name] = d; return () => {}; } },
  webServer: { register: (d) => { calls.routes.push(d); return () => {}; } },
  agents: { currentInitiator: () => ({ sessionId: "cc", session: { header: { id: "cc" } } }) },
};
const mod = await import(ROOT + "/index.js");
if (!existsSync(LIB)) {
  console.log("⊘ 跳过：本地卡库未挂载");
  process.exit(0);
}
await mod.apply(ctx, { localRoot: LIB });

console.log("=== ① host 返回的数据里还有没有噪音 ===");
const srv = http.createServer((req, res) => { void calls.routes[0].handler(req, res); });
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;
const call = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

let pass = 0, fail = 0;
const t = (l, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

const s = await call("/dsh-card-summon/search?source=local&pageSize=8");
const items = s.items ?? [];
console.log(`  取 ${items.length} 张（默认排序）`);

const hasJunkTag = items.some(x => (x.tags ?? []).includes("未分类"));
t("没有卡再把「未分类」当标签", !hasJunkTag, JSON.stringify(items.find(x=>(x.tags??[]).includes("未分类"))?.tags));

const junkMonth = items.some(x => (x.tags ?? []).some(v => /^\d+-\d+月$/.test(v) || /^\d{4}年\d+月前?$/.test(v)));
t("没有卡把月份当标签", !junkMonth);

const hasStatTagline = items.some(x => /人设 \d+ 字/.test(String(x.tagline ?? "")));
t("tagline 不再堆「人设 N 字」元数据", !hasStatTagline, JSON.stringify(items.map(x=>x.tagline).slice(0,3)));

t("tagline 为空时不编造内容", items.every(x => typeof x.tagline === "string"));

console.log("\n  样例（改后卡片会渲染的内容）:");
for (const it of items.slice(0, 4)) {
  console.log(`    ${JSON.stringify(it.name).slice(0, 30)}`);
  console.log(`      tagline: ${JSON.stringify(it.tagline)}`);
  console.log(`      tags:    ${JSON.stringify(it.tags)}`);
}

console.log("\n=== ② 「古风」卡的 tagline 应含分类名 ===");
const g = await call("/dsh-card-summon/search?source=local&pageSize=2&category=" + encodeURIComponent("古风"));
t("真分类卡的 tagline 带分类名", (g.items ?? []).every(x => String(x.tagline).includes("古风")), JSON.stringify((g.items??[]).map(x=>x.tagline)));

console.log("\n=== ③ 「2025年3月前」这种归档名不再充当分类 ===");
const a = await call("/dsh-card-summon/search?source=local&pageSize=2&category=" + encodeURIComponent("2025年3月前"));
const noFakeTag = (a.items ?? []).every(x => !(x.tags ?? []).includes("2025年3月前"));
t("归档名不再当标签", noFakeTag, JSON.stringify((a.items??[]).map(x=>x.tags)));

srv.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
