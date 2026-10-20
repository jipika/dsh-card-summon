import http from "node:http";
import { existsSync } from "node:fs";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * 分类筛选验证（面板 chip 点击 → /search?category=…）。
 *
 * 注意链路：host 侧 `localFilters.categories` 已经读 `category` 参数并透传给
 * `queryLocalIndex` 的 `categories`，所以面板只需把 category 拼进 URL。
 * 用户要求「分类的我要全部」→ 33 个分类都要能筛，不是只放 3 个。
 */
const calls = { routes: [] };
const ctx = {
  effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
  on: () => () => {}, systemPrompt: { section: () => () => {} },
  tools: { register: () => () => {} },
  webServer: { register: (d) => { calls.routes.push(d); return () => {}; } },
  agents: { currentInitiator: () => ({ sessionId: "c", session: { header: { id: "c" } } }) },
};
const mod = await import(ROOT + "/index.js");
const LIB = process.env.CARD_LIB_ROOT ?? "/Volumes/mac/下载/26.6角色卡/26.7月全中文备注角色卡（14000➕）";
if (!existsSync(LIB)) {
  console.log("⊘ 跳过：本地卡库未挂载");
  process.exit(0);
}
await mod.apply(ctx, { localRoot: LIB });
const srv = http.createServer((req, res) => { void calls.routes[0].handler(req, res); });
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;
const call = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

let pass = 0, fail = 0;
const t = (l, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

console.log("=== ① 无筛选 ===");
const all = await call("/dsh-card-summon/search?source=local&pageSize=3");
console.log(`  total=${all.total}`);
t("返回全部", all.total > 8000, `total=${all.total}`);
t("有 facets.categories", all.localFacets?.categories !== undefined);
console.log(`  分类数: ${Object.keys(all.localFacets?.categories ?? {}).length}`);

console.log("\n=== ② 单分类筛选 ===");
const one = await call("/dsh-card-summon/search?source=local&pageSize=3&category=" + encodeURIComponent("古风"));
console.log(`  total=${one.total}`);
t("筛选后总数变小", one.total < all.total, `${one.total} vs ${all.total}`);
const allGuFeng = (one.items ?? []).every(x => x.category === "古风");
t("返回的卡分类都是「古风」", allGuFeng, JSON.stringify((one.items??[]).map(x=>x.category)));

console.log("\n=== ③ 多分类（叠加）===");
const two = await call("/dsh-card-summon/search?source=local&pageSize=3&category=" + encodeURIComponent("古风") + "&category=" + encodeURIComponent("同人"));
console.log(`  total=${two.total}`);
t("两分类合计 ≥ 单分类", two.total >= one.total, `${two.total} vs ${one.total}`);
const cats = new Set((two.items ?? []).map(x => x.category));
t("返回项只含这两类", [...cats].every(c => c === "古风" || c === "同人"), JSON.stringify([...cats]));

console.log("\n=== ④ 分类 + 关键词叠加 ===");
const kw = await call("/dsh-card-summon/search?q=" + encodeURIComponent("师尊") + "&source=local&pageSize=3");
const kwc = await call("/dsh-card-summon/search?q=" + encodeURIComponent("师尊") + "&source=local&pageSize=3&category=" + encodeURIComponent("古风"));
console.log(`  关键词 ${kw.total} → 加分类后 ${kwc.total}`);
t("分类叠加后收窄", kwc.total <= kw.total, `${kwc.total} vs ${kw.total}`);

srv.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
