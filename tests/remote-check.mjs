import http from "node:http";
import { execSync } from "node:child_process";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * 远程卡库验证（需要 GitHub token，从 `gh auth token` 取）。
 * 依赖已推送的私有仓库 jipika/dsh-card-library（索引 / 正文 / 图片三分支）。
 * 无 token 或仓库不可达时跳过并说明 —— 不假装通过。
 *
 * 实测要点（都踩过）：
 *   · 私有仓库 raw 无 token 返回 **404 而非 403**，极易误判成文件不存在
 *   · `api.github.com/contents` 对 >1MB 文件不返回 content → 一律走 raw
 *   · manifest 的 `cover` 自带 `images/` 前缀，拼接时要剥掉
 *   · 索引的 `rel` 与 manifest 的 `src` 必须一致（否则取卡 404）
 */
let tokenOk = true;
try { execSync("gh auth token", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { tokenOk = false; }
if (!tokenOk) {
  console.log("⊘ 跳过：取不到 GitHub token（需要 `gh auth login`）");
  process.exit(0);
}
const calls = { routes: [], tools: {} };
const ctx = {
  effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
  on: () => () => {},
  systemPrompt: { section: () => () => {} },
  tools: { register: (d) => { calls.tools[d.name] = d; return () => {}; } },
  webServer: { register: (d) => { calls.routes.push(d); return () => {}; } },
  agents: { currentInitiator: () => ({ sessionId: "r1", session: { header: { id: "r1" } } }) },
};
const mod = await import(ROOT + "/index.js");
await mod.apply(ctx, { remoteRepo: "jipika/dsh-card-library" }); // 故意不配 localRoot

const srv = http.createServer((req, res) => { void calls.routes[0].handler(req, res); });
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;
const call = async (p) => (await fetch(`http://127.0.0.1:${port}${p}`)).json();

let pass = 0, fail = 0;
const t = (l, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

console.log("=== ① 索引：远端拉取 ===");
let t0 = Date.now();
const s = await call("/dsh-card-summon/search?source=local&pageSize=5");
const ms = Date.now() - t0;
console.log(`  total=${s.total} | 本页 ${s.items?.length} | ${(ms/1000).toFixed(1)}s`);
console.log(`  notes: ${(s.notes||[]).join(" / ")}`);
t("远端索引可用（11480 张）", s.total === 11480, `实得 ${s.total}`);
t("返回了条目", (s.items?.length ?? 0) > 0);

console.log("\n=== ② 取卡正文：走远程 ===");
const e0 = s.items[0];
console.log(`  用索引第一条: ${JSON.stringify(e0.fullPath).slice(0,60)}`);
t("条目带 fullPath", typeof e0.fullPath === "string" && e0.fullPath.startsWith("local://"));

console.log("\n=== ③ 用「原始磁盘路径」取卡（这才是 manifest 的 key）===");
// manifest 的 src 是带月份前缀的原始路径；索引的 rel 也是，只是首条恰好归一了
const { fetchRemoteIndex, setTokenResolver } = await import(ROOT + "/lib/remote.js");
setTokenResolver(() => execSync("gh auth token", {encoding:"utf8"}).trim());
const idx = await fetchRemoteIndex({ cfg: { repo: "jipika/dsh-card-library" } });
const withMonth = idx.entries.find(x => /^(1|3|4|5|6)-/.test(x.rel) || x.rel.startsWith("2025-"));
console.log(`  挑一条带月份前缀的: ${JSON.stringify(withMonth.rel).slice(0,60)}`);
try {
  const sum = await calls.tools.card_summon.execute({ fullPath: `local://${withMonth.rel}` }, {});
  t("远程取卡并注入成功", sum.ok === true && sum.injectedChars > 0, `ok=${sum.ok} chars=${sum.injectedChars}`);
  console.log(`      name=${JSON.stringify(sum.name)} 注入 ${sum.injectedChars} 字符`);
} catch (e) {
  t("远程取卡并注入成功", false, e.message.slice(0, 90));
}

console.log("\n=== ④ 封面：本地未配置 → 必须走远程 ===");
const rel = withMonth.rel;
const r = await fetch(`http://127.0.0.1:${port}/dsh-card-summon/local-image?rel=${encodeURIComponent(rel)}`);
if (r.ok) {
  const buf = Buffer.from(await r.arrayBuffer());
  const isPng = buf.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  t("封面从远端取到且为有效 PNG", isPng, `HTTP ${r.status} ${buf.length}B`);
  console.log(`      HTTP ${r.status} | X-Card-Source: ${r.headers.get("x-card-source")} | ${(buf.length/1024).toFixed(0)}KB`);
} else {
  t("封面从远端取到", false, `HTTP ${r.status}`);
}

console.log("\n=== ⑤ card_read 也能走远程 ===");
try {
  const r2 = await calls.tools.card_read.execute({ fullPath: `local://${withMonth.rel}`, field: "personality", maxChars: 100 }, {});
  t("card_read 远程可用", typeof r2.text === "string", JSON.stringify(r2).slice(0,80));
  console.log(`      name=${JSON.stringify(r2.name)} personality 前 40: ${JSON.stringify((r2.text||"").slice(0,40))}`);
} catch (e) {
  t("card_read 远程可用", false, e.message.slice(0, 90));
}

srv.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
