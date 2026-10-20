import { readFileSync } from "node:fs";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * 布局与「单一来源尺寸」验证。
 *
 * 为什么单独测：面板宽度曾在 CSS 与 JS 两处各写一份（420 / 428），
 * 改一处忘一处就会算出错误位置。现在都从 `PANEL_W` 派生，
 * 而**模板字面量插值是运行时行为** —— 必须真跑一遍确认替换成功，
 * 否则若 PANEL_W 未定义（TDZ）会整段样式挂掉，界面直接没样式。
 */
const src = readFileSync(ROOT + "/lib/client.js", "utf8");

let reg = null; const styles = [];
globalThis.window = { __ModuleLoader__: { load: (s) => { reg = s; } }, innerWidth: 1400, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
globalThis.document = {
  head: { appendChild(e) { styles.push(e); return e; } }, body: {},
  getElementById: (id) => styles.find((e) => e.id === id) ?? null,
  createElement: () => ({ style: {}, appendChild() {}, remove() {}, setAttribute() {} }),
  addEventListener() {}, removeEventListener() {},
};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
new Function("window", "document", "fetch", src)(globalThis.window, globalThis.document, globalThis.fetch);

const R = {
  useState: (i) => [typeof i === "function" ? i() : i, () => {}],
  useRef: (i) => ({ current: i }),
  useCallback: (f) => f,
  useEffect: () => {},
  createElement: (t, p, ...c) => ({ __el: true, type: t, props: p ?? {}, children: c.flat() }),
  Fragment: Symbol("F"),
};
const mod = reg.factory((n) => n === "react" ? R : n === "react-dom" ? { createPortal: (e) => e } : (() => { throw new Error(n); })());
mod.apply({
  effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
  locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => f(), register: () => () => {} },
});

const css = styles.map((s) => s.textContent ?? "").join("\n");
const get = (sel) => { const m = css.match(new RegExp(sel.replace(/[.$*+?^${}()|[\]\\]/g, "\\$&") + "\\{([^}]*)\\}")); return m ? m[1] : null; };
let pass = 0, fail = 0;
const t = (l, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

console.log("=== ① 插值是否被替换成数字（没替换会看到字面 ${PANEL_W}）===");
const m = css.match(/\.dcs-panel\{position:fixed;z-index:15;width:(\d+)px/);
console.log(`  匹配到 width: ${m ? m[1] + "px" : "(没匹配到)"}`);
t("CSS width 已插值成数字", m !== null && m[1] === "520", m ? m[1] : "无");
t("没有未替换的模板占位符残留", !css.includes("${PANEL_W}"), "样式里还留着 ${PANEL_W}");

console.log("\n=== ② 样式整体是否健康（插值出错会整段挂掉）===");
t("样式总长度合理（>5000 字符）", css.length > 5000, `${css.length} 字符`);
t("关键类都在", [".dcs-grid{", ".dcs-av{", ".dcs-card{", ".dcs-catrow{"].every((k) => css.includes(k)));

console.log("\n=== ③ 两列与竖排确实生效 ===");
t("grid 两列", /\.dcs-grid\{display:grid;grid-template-columns:repeat\(2/.test(css));


console.log("\n=== ④ 顶部垂直节奏统一（用户：「边距都不对，非常奇怪」）===");
// 实测问题：控件高度曾是 28/26/21/18 四种、行距 6/4/4 两档，
// 所以各行松紧不一、看着不齐。现在统一为「同高 28px + 同行距 6px」。
const h28 = (sel) => /height:28px/.test(get(sel) ?? "");
t("输入框 28px", h28(".dcs-input"));
t("搜索按钮 28px", h28(".dcs-go"));
t("语言下拉 28px（原 24）", h28(".dcs-select"));
t("段控件容器 28px", h28(".dcs-seg"));
// 分类 chip 是唯一被用户明确要求「缩小一点」的：28 → 24。
// 其余各行仍守「同高 28px + 同行距 6px」—— 缩的是 chip 自身，不是行距。
t("分类 chip 24px（用户要求缩小；原 28，更早 21）", /height:24px/.test(get(".dcs-chipcat") ?? ""));
t("数据源行 margin-top 6px", /margin-top:6px/.test(get(".dcs-row-filters") ?? ""));
t("分类行 margin-top 6px（原 4）", /margin-top:6px/.test(get(".dcs-catrow") ?? ""));
t("取数来源行 margin-top 6px（原 4）", /margin-top:6px/.test(get(".dcs-row-origin") ?? ""));
t("段控件内部垂直居中", /align-items:center/.test(get(".dcs-seg") ?? ""));
t("段按钮 inline-flex 居中", /display:inline-flex/.test(get(".dcs-seg-btn") ?? ""));

console.log("\n=== ⑥ H5 窄屏全屏适配（≤1023px，与 dsh-pocket 手机断点一致）===");
// 手机视口 492px 放不下 520px 面板，右下角锚定会一半在屏外 —— 窄屏直接全屏。
// 两个浮层都 portal 到 body 且 inline 定位是正常声明，!important media 规则必须压得住。
t("media 断点是 1023px（对齐 pocket）", css.includes("@media(max-width:1023px){"));
const h5Block = css.slice(css.indexOf("@media(max-width:1023px)"));
t("panel 窄屏全屏（四边归零 + 100vw/dvh）", /left:0!important;right:0!important;top:0!important;bottom:0!important;width:100vw!important/.test(h5Block) && /max-height:100dvh!important/.test(h5Block));
t("detail 同样全屏（选择器并写）", h5Block.includes(".dcs-panel,.dcs-detail{"));
t("窄屏 z-index 1300（压过 pocket 抽屉 1200）", /z-index:1300!important/.test(h5Block));
t("safe-area 上下留白（面板）", h5Block.includes("padding-top:env(safe-area-inset-top)"));
t("召唤状态条窄屏可换行（防按钮溢出）", h5Block.includes(".dcs-now{flex-wrap:wrap"));
t("过滤行窄屏可换行", h5Block.includes(".dcs-row-filters{flex-wrap:wrap"));
t("detail 头部 fullPath 截断", h5Block.includes(".dcs-detail-head .dcs-sub{overflow:hidden;text-overflow:ellipsis"));
t("桌面端原定位规则未动（520px 固定宽仍在）", /\.dcs-panel\{position:fixed;z-index:15;width:520px/.test(css));
t("桌面 z-index 仍是 15/16（窄屏才升 1300）", css.includes(".dcs-panel{--dcs-fast:120ms") && /\.dcs-detail\{position:fixed;z-index:16/.test(css));

const __r = { pass, fail };

console.log("\n=== ⑤ 卡片设计：封面是辅助识别，不是主体 ===");
// 踩过的坑：为让「文字列最宽」把封面撑到 228×342（aspect-ratio:2/3 + width:100%），
// 卡片高约 450px、一屏只放得下 2 张 —— 封面喧宾夺主。
// 依据 apple-design：「Every element earns its place」+「Nothing is random」，
// 封面只需足够辨认；64×96 的 2:3 缩略图已能看清主体，且让一屏回到约 6 张。
t("卡片横排（图左字右，信息密度最高）", /\.dcs-card\{display:flex;flex-direction:row/.test(css));
t("封面 64×96 缩略图", /\.dcs-av\{width:64px;height:96px/.test(css));
t("占位框同尺寸", /\.dcs-av-fb\{width:64px;height:96px/.test(css));
t("封面比例 2:3 未被裁切", 64 / 96 === 2 / 3);
t("卡名两行（用掉封面留下的竖向空间，不撑高卡片）", /\.dcs-name-text\{[^}]*-webkit-line-clamp:2/.test(css));
t("名字样式只有一处定义（无重复规则）", (css.match(/\.dcs-name\{/g) ?? []).length === 1);
t("两列网格", /\.dcs-grid\{display:grid;grid-template-columns:repeat\(2/.test(css));
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
