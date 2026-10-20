import http from "node:http";
import { existsSync } from "node:fs";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * 取数来源切换（本地磁盘 / GitHub）验证。
 *
 * 两侧是**同一批 11480 张卡**（实测 rel 集合完全相同），只是取数路径不同。
 * 默认 remote —— 用户明确要求「都连到远程」。
 * 覆盖：默认值 / 双向切换 / 非法值拒绝 / search 参数临时切换 / 缩略图缓存读写。
 */
const LIB = process.env.CARD_LIB_ROOT ?? "/Volumes/mac/下载/26.6角色卡/26.7月全中文备注角色卡（14000➕）";
if (!existsSync(LIB)) {
  console.log("⊘ 跳过：本地卡库未挂载");
  process.exit(0);
}
const calls = { routes: [], tools: {} };
const ctx = {
  effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
  on: () => () => {}, systemPrompt: { section: () => () => {} },
  tools: { register: (d) => { calls.tools[d.name] = d; return () => {}; } },
  webServer: { register: (d) => { calls.routes.push(d); return () => {}; } },
  agents: { currentInitiator: () => ({ sessionId: "o", session: { header: { id: "o" } } }) },
};
const mod = await import(ROOT + "/index.js");
await mod.apply(ctx, { remoteRepo: "jipika/dsh-card-library", localRoot: LIB });
const srv = http.createServer((req, res) => { void calls.routes[0].handler(req, res); });
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;
const call = async (p, m = "GET", b) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: m,
    headers: b ? { "content-type": "application/json" } : undefined,
    body: b ? JSON.stringify(b) : undefined,
  });
  return r.json();
};

let pass = 0, fail = 0;
const t = (l, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

console.log("=== ① 默认来源 ===");
const o1 = await call("/dsh-card-summon/origin");
console.log(`  origin=${o1.origin} remoteEnabled=${o1.remoteEnabled} localConfigured=${o1.localConfigured}`);
t("默认是 remote（用户要求「都连到远程」）", o1.origin === "remote", `实得 ${o1.origin}`);
t("汇报了 thumbs 统计", o1.thumbs !== undefined);

console.log("\n=== ② 切到 local ===");
const o2 = await call("/dsh-card-summon/origin", "POST", { origin: "local" });
t("切换返回 local", o2.origin === "local", JSON.stringify(o2));
const o3 = await call("/dsh-card-summon/origin");
t("后续 GET 读到 local（状态保持）", o3.origin === "local", `实得 ${o3.origin}`);

console.log("\n=== ③ 切回 remote ===");
await call("/dsh-card-summon/origin", "POST", { origin: "remote" });
const o4 = await call("/dsh-card-summon/origin");
t("切回 remote 生效", o4.origin === "remote");

console.log("\n=== ④ 非法值被拒（不能把状态搞坏）===");
await call("/dsh-card-summon/origin", "POST", { origin: "garbage" });
const o5 = await call("/dsh-card-summon/origin");
t("非法值被忽略，仍是 remote", o5.origin === "remote", `实得 ${o5.origin}`);

console.log("\n=== ⑤ /search 带 origin 参数能临时切 ===");
await call("/dsh-card-summon/search?source=local&pageSize=2&origin=local");
const o6 = await call("/dsh-card-summon/origin");
t("search 带 origin=local 后状态变 local", o6.origin === "local", `实得 ${o6.origin}`);
await call("/dsh-card-summon/search?source=local&pageSize=2&origin=remote");
const o7 = await call("/dsh-card-summon/origin");
t("search 带 origin=remote 后变回 remote", o7.origin === "remote", `实得 ${o7.origin}`);

console.log("\n=== ⑥ 缩略图缓存查看与清理 ===");
const s1 = await call("/dsh-card-summon/thumbs");
console.log(`  缓存 ${s1.count} 个 / ${(s1.bytes/1024).toFixed(0)}KB`);
t("能读到缓存统计", typeof s1.count === "number");
const c = await call("/dsh-card-summon/thumbs-clear", "POST", {});
t("能清理缓存", typeof c.removed === "number", JSON.stringify(c));
const s2 = await call("/dsh-card-summon/thumbs");
t("清理后归零", s2.count === 0, `实得 ${s2.count}`);

srv.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
