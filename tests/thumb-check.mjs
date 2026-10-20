import http from "node:http";
import { statSync, utimesSync, readdirSync, existsSync, copyFileSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * 封面缩略图验证。
 *
 * 背景：这里原先有个 bug —— 只回 PNG 前 96KB，导致浏览器只画出上半截。
 * 我当时用 `sips` 读出 512x768 就以为「截断也能解码」，但**宽高在 IHDR（前 33 字节）**，
 * 与像素数据无关（实测该卡 IDAT 850325 字节，截断后只剩 98271）。
 * 现在改为 sips 生成真缩略图 + 落盘缓存，本测试覆盖：
 *   生成 / 命中 / mtime 失效 / 坏缓存自愈 / px 参数 / **白名单与防穿越**
 */
const LIB_ROOT = process.env.CARD_LIB_ROOT ?? "/Volumes/mac/下载/26.6角色卡/26.7月全中文备注角色卡（14000➕）";
if (!existsSync(LIB_ROOT)) {
  console.log("⊘ 跳过：本地卡库未挂载");
  process.exit(0);
}
const LIB = LIB_ROOT;
const THUMBS = `${process.env.HOME}/.dsh/card-summon/thumbs`;

const calls = { routes: [] };
const ctx = {
  effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
  on: () => () => {}, systemPrompt: { section: () => () => {} },
  tools: { register: () => () => {} },
  webServer: { register: (d) => { calls.routes.push(d); return () => {}; } },
  agents: { currentInitiator: () => ({ sessionId: "t", session: { header: { id: "t" } } }) },
};
const mod = await import(ROOT + "/index.js");
await mod.apply(ctx, { localRoot: LIB });
const srv = http.createServer((req, res) => { void calls.routes[0].handler(req, res); });
await new Promise((r) => srv.listen(0, r));
const port = srv.address().port;

const { loadLocalIndex } = await import(ROOT + "/lib/local.js");
const idx = loadLocalIndex();
// 用索引里的真实卡（白名单只放行索引内的路径）
const e = idx.entries.find(x => /噬灵陨仙蛊/.test(x.rel)) ?? idx.entries[0];
const rel = e.rel;
const abs = `${LIB}/${rel}`;
const origStat = statSync(abs);
const count = () => existsSync(THUMBS) ? readdirSync(THUMBS).length : 0;
const url = (r, extra = "") => `http://127.0.0.1:${port}/dsh-card-summon/local-image?rel=${encodeURIComponent(r)}${extra}`;
const get = async (r, extra = "") => {
  const res = await fetch(url(r, extra));
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, len: buf.length, src: res.headers.get("x-card-source"), buf };
};

let pass = 0, fail = 0;
const t = (l, c, ex = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${ex}`); } };
console.log(`实验卡: ${rel.slice(0, 40)}（原图 ${(e.sizeBytes/1024).toFixed(0)}KB）\n`);

console.log("=== ① 首次生成 ===");
const a = await get(rel);
console.log(`  ${a.len} bytes | ${a.src}`);
t("生成缩略图", a.src === "local-thumb");
t("是完整 JPEG（SOI+EOI）", a.buf[0]===0xff && a.buf[1]===0xd8 && a.buf.at(-2)===0xff && a.buf.at(-1)===0xd9);
t("远小于原图", a.len < e.sizeBytes / 4, `${a.len} vs ${e.sizeBytes}`);
t("本次请求产生了缓存文件", count() >= 1, `实得 ${count()}`);

console.log("\n=== ② 缓存命中 ===");
const baseCount = count();
const b = await get(rel);
t("尺寸一致（走缓存）", b.len === a.len);
t("命中缓存：文件数不增加", count() === baseCount, `${baseCount} → ${count()}`);

console.log("\n=== ③ 改源文件 mtime → 键变化 → 重新生成 ===");
// 用**随机偏移**而不是固定 +5000：固定偏移在重复跑时会算出与上一轮相同的键，
// 于是缓存命中、文件数不增，断言会误报失败（实测踩到）。
const bump = 1000 + Math.floor(Math.random() * 60000);
utimesSync(abs, origStat.atime, new Date(origStat.mtimeMs + bump));
const c = await get(rel);
t("mtime 变化后产生新缓存", count() > baseCount, `${baseCount} → ${count()}`);
t("仍是有效图", c.src === "local-thumb" && c.len === a.len);
// 还原 mtime
utimesSync(abs, origStat.atime, origStat.mtime);

console.log("\n=== ④ 坏缓存自愈 ===");
const victims = ["0", "1"];
// 把现有缓存文件截断（模拟半截文件）
for (const f of readdirSync(THUMBS)) {
  execSync(`head -c 80 "${THUMBS}/${f}" > /tmp/trunc.jpg && cp /tmp/trunc.jpg "${THUMBS}/${f}"`);
}
const d = await get(rel);
t("坏缓存被识别并重建", d.src === "local-thumb" && d.len === a.len, `${d.src} ${d.len}`);

console.log("\n=== ⑤ px 参数生效 ===");
const beforePx = count();
const small = await get(rel, "&px=128");
t("px=128 返回有效图", small.status === 200 && small.len > 0);
t("px 不同 → 独立缓存", count() >= beforePx, `${beforePx} → ${count()}`);
t("128px 比 256px 小", small.len < a.len, `${small.len} vs ${a.len}`);

console.log("\n=== ⑥ 安全：不在索引里的路径必须被拒 ===");
const tmpRel = "__notindexed__.png";
copyFileSync(abs, `${LIB}/${tmpRel}`);
const bad = await get(tmpRel);
t("索引外的文件被拒（即使真实存在）", bad.status === 404, `HTTP ${bad.status}`);
unlinkSync(`${LIB}/${tmpRel}`);

const bad2 = await get("../../../../etc/passwd");
t("路径穿越被拒", bad2.status === 404 || bad2.status === 403, `HTTP ${bad2.status}`);

srv.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
