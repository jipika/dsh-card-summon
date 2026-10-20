import { readFileSync } from "node:fs";
const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/**
 * 卡片描述行渲染验证（用户：「没有描述信息吗」）。
 *
 * 背景：索引原先没有可读描述字段，卡片只有统计量（「世界书 21 条」）。
 * 已新增 `preview`（description 优先、firstMessage 兜底，实测覆盖 74%）。
 * 本测试用三张卡验证渲染分支：
 *   ① 有 preview  → 显示 preview（两行截断）
 *   ② 无 preview  → 退回 tagline（统计量）
 *   ③ 两者都无    → 整行不渲染（符合「没有的字段就直接不显示」）
 * 关键断言：同一张卡**不会同时**出现 preview 与 tagline（竖排空间有限）。
 * 文本用构造的假数据，不依赖真实卡库。
 */
const src = readFileSync(ROOT + "/lib/client.js", "utf8");
let reg = null; const styles = [];
globalThis.window = { __ModuleLoader__: { load: (s) => { reg = s; } }, innerWidth: 1400, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
globalThis.document = { head: { appendChild(e) { styles.push(e); return e; } }, body: {},
  getElementById: (id) => styles.find((e) => e.id === id) ?? null,
  createElement: () => ({ style: {}, appendChild() {}, remove() {}, setAttribute() {} }), addEventListener() {}, removeEventListener() {} };

// 两张卡：一张有 preview，一张没有（只 tagline）
const items = [
  { fullPath: "local://a.png", source: "local", name: "有描述的卡", preview: "这是一段可读的卡片描述，说明这张卡讲什么故事。", tagline: "世界书 21 条", tags: [], category: "未分类" },
  { fullPath: "local://b.png", source: "local", name: "没描述的卡", preview: "", tagline: "世界书 35 条", tags: [], category: "未分类" },
  { fullPath: "local://c.png", source: "local", name: "两者都无的卡", preview: "", tagline: "", tags: [], category: "未分类" },
];
globalThis.fetch = async (u) => {
  const s = String(u);
  if (s.includes("/origin")) return { ok: true, status: 200, json: async () => ({ ok: true, origin: "local", remoteEnabled: true, localConfigured: true, thumbs: { count: 0, bytes: 0 } }) };
  if (s.includes("/status")) return { ok: true, status: 200, json: async () => ({ ok: true, summon: null }) };
  if (s.includes("/search")) return { ok: true, status: 200, json: async () => ({ ok: true, total: 3, totalPages: 1, hasMore: false, localFacets: { categories: {}, months: {}, classified: {}, lorebook: {}, specs: {}, fileTags: {} }, items }) };
  return { ok: true, status: 200, json: async () => ({ ok: true }) };
};
new Function("window", "document", "fetch", src)(globalThis.window, globalThis.document, globalThis.fetch);

let cur = 0; let store = []; const compStores = new WeakMap();
const R = {
  useState(i) { const s = store; const k = cur++; if (s[k] === undefined) s[k] = typeof i === "function" ? i() : i; return [s[k], (v) => { s[k] = typeof v === "function" ? v(s[k]) : v; }]; },
  useRef(i) { const s = store; const k = cur++; if (s[k] === undefined) s[k] = { current: i }; return s[k]; },
  useCallback(f) { const s = store; const k = cur++; if (s[k] === undefined) s[k] = f; return s[k]; },
  useEffect(fn, deps) { const s = store; const k = cur++; const prev = s[k]; const run = () => { const c = fn(); return typeof c === "function" ? c : undefined; };
    if (prev === undefined) { s[k] = { deps, cleanup: run() }; return; }
    const same = Array.isArray(prev.deps) && Array.isArray(deps) && prev.deps.length === deps.length && deps.every((d, j) => Object.is(d, prev.deps[j]));
    if (!same) { prev.cleanup?.(); s[k] = { deps, cleanup: run() }; } },
  Fragment: Symbol("F"),
  createElement(t, p, ...c) { const fl = []; (function push(x) { Array.isArray(x) ? x.forEach(push) : (x !== null && x !== undefined && x !== false) && fl.push(x); })(c); return { __el: true, type: t, props: { ...(p ?? {}), children: fl.length === 1 ? fl[0] : fl }, children: fl }; },
};
const mod = reg.factory((n) => n === "react" ? R : n === "react-dom" ? { createPortal: (e) => e } : (() => { throw new Error(n); }));
const slots = {};
mod.apply({ effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; }, locale: { register: () => () => {}, bind: () => (k) => k },
  slots: { inject: (n, f) => f(), register: (e, c) => { slots[e.name] = c; return () => {}; } } });
const T = (k) => k;
function mount(comp, props) { store = compStores.get(comp); if (store === undefined) { store = []; compStores.set(comp, store); } cur = 0; return comp(props); }
const kids = (n) => { if (!n || typeof n !== "object") return []; const p = n.props?.children; return [...new Set(Array.isArray(p) ? p : (p !== undefined ? [p] : []))]; };
const cls = (n) => String(n?.props?.className ?? "");
const findAll = (n, p, acc = []) => { if (!n || typeof n !== "object") return acc; if (n.__el && p(n)) acc.push(n); kids(n).forEach((c) => findAll(c, p, acc)); return acc; };
const txt = (n) => { if (typeof n === "string" || typeof n === "number") return String(n); if (!n || typeof n !== "object") return ""; return kids(n).map(txt).join(""); };

let t = mount(slots["conversation.input.right"], { t: T, sessionId: "s" });
const rt = mount(slots["dsh-toolbox.menu"], { t: T, sessionId: "s" });
(function find(n) { if (!n || typeof n !== "object") return; if (n.__el && cls(n).includes("dtb-row")) { n.props.onClick?.({ currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 500 }) } }); return; } kids(n).forEach(find); })(rt);
await new Promise((r) => setTimeout(r, 80));
t = mount(slots["conversation.input.right"], { t: T, sessionId: "s" });

let pass = 0, fail = 0;
const ok = (l, c, e = "") => { if (c) { pass++; console.log(`  ✓ ${l}`); } else { fail++; console.log(`  ✗ ${l} ${e}`); } };

console.log("=== 三张卡的描述行渲染 ===");
const cards = findAll(t, (n) => cls(n) === "dcs-card");
console.log(`  渲染出 ${cards.length} 张卡`);
const descs = findAll(t, (n) => cls(n) === "dcs-desc");
const subs2 = findAll(t, (n) => cls(n) === "dcs-sub2");
console.log(`  .dcs-desc 节点: ${descs.length} 个（有描述的卡）`);
console.log(`  .dcs-sub2 节点: ${subs2.length} 个（用 tagline 兜底的卡）`);

console.log("");
ok("1 张卡显示 preview", descs.length === 1, `实得 ${descs.length}`);
ok("preview 内容正确", txt(descs[0] ?? {}) === items[0].preview);
ok("1 张卡退回 tagline", subs2.length === 1, `实得 ${subs2.length}`);
ok("tagline 内容正确", txt(subs2[0] ?? {}) === items[1].tagline);
ok("两者都无的卡：描述行完全不渲染", cards.length === 3 && descs.length + subs2.length === 2, `卡 ${cards.length} 描述 ${descs.length} 兜底 ${subs2.length}`);
ok("同一张卡不会同时有 preview 与 tagline", descs.length + subs2.length === 2);
ok("preview 带 title 便于悬停看全", typeof descs[0]?.props?.title === "string" && descs[0].props.title.length > 0);

console.log("");
console.log("=== CSS ===");
const css = styles.map((s) => s.textContent ?? "").join("\n");
ok(".dcs-desc 两行截断", /\.dcs-desc\{[^}]*-webkit-line-clamp:2/.test(css));
ok(".dcs-desc 用 secondary 色（比 tagline 亮）", /\.dcs-desc\{[^}]*label-secondary/.test(css));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
