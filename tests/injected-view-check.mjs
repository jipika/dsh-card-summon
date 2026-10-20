// 端到端：真实 client.js + 真实 host 路由，验证「点状态行 → 看注入原文」
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import http from "node:http";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// ── 起真实 host ──
const hcalls = { routes: [], tools: {} };
const hctx = {
  effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
  on: () => () => {},
  systemPrompt: { section: () => () => {} },
  tools: { register: (d) => { hcalls.tools[d.name] = d; return () => {}; } },
  webServer: { register: (d) => { hcalls.routes.push(d); return () => {}; } },
  agents: { currentInitiator: () => ({ sessionId: "p1", session: { header: { id: "p1" } } }) },
};
const host = await import(ROOT + "/index.js");
await host.apply(hctx, {});
const server = http.createServer((req, res) => { void hcalls.routes[0].handler(req, res); });
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// 先召唤一张，才有注入内容
const sum = await hcalls.tools.card_summon.execute({ fullPath: "umbralshelter/frieren-6f796b947f33" }, {});
console.log(`准备：召唤 ${sum.name}，注入 ${sum.injectedChars} 字符\n`);

// ── 加载真实 client.js，指向真 host ──
const src = readFileSync(ROOT + "/lib/client.js", "utf8");
let reg = null; const styles = [];
globalThis.window = { __ModuleLoader__: { load: (s) => { reg = s; } }, innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
globalThis.document = {
  head: { appendChild(e) { styles.push(e); return e; } }, body: {},
  getElementById: (id) => styles.find((e) => e.id === id) ?? null,
  createElement: () => ({ style: {}, appendChild() {}, remove() {}, setAttribute() {} }),
  addEventListener() {}, removeEventListener() {},
};
const seen = [];
const realFetch = globalThis.fetch.bind(globalThis); // ★ 必须先保存原引用，否则递归爆栈
globalThis.fetch = async (u, i) => {
  const url = String(u);
  const abs = url.startsWith("http") ? url : `http://127.0.0.1:${port}${url}`;
  seen.push(url);
  return realFetch(abs, i);
};
new Function("window", "document", "fetch", src)(globalThis.window, globalThis.document, globalThis.fetch);

let cur = 0; let store = []; const compStores = new WeakMap();
const R = {
  useState(i) { const s = store; const k = cur++; if (s[k] === undefined) s[k] = typeof i === "function" ? i() : i; return [s[k], (v) => { s[k] = typeof v === "function" ? v(s[k]) : v; }]; },
  useRef(i) { const s = store; const k = cur++; if (s[k] === undefined) s[k] = { current: i }; return s[k]; },
  useCallback(f) { const s = store; const k = cur++; if (s[k] === undefined) s[k] = f; return s[k]; },
  // ⚠️ useEffect 必须支持依赖数组：面板的轮询 effect 依赖 [phase, refresh]，
  // 若只跑一次，phase 从 closed → open 后它不会重跑，current 永远是 null
  // （实测导致「当前召唤」行渲染不出来）。这里做浅比较 + 清理函数。
  useEffect(fn, deps) {
    const s = store; const k = cur++;
    const prev = s[k];
    const run = () => { const c = fn(); return typeof c === "function" ? c : undefined; };
    if (prev === undefined) { s[k] = { deps, cleanup: run() }; return; }
    if (deps === undefined) { if (prev.cleanup) prev.cleanup(); s[k] = { deps, cleanup: run() }; return; }
    const same = Array.isArray(prev.deps) && prev.deps.length === deps.length && deps.every((d, j) => Object.is(d, prev.deps[j]));
    if (!same) { if (prev.cleanup) prev.cleanup(); s[k] = { deps, cleanup: run() }; }
  },
  Fragment: Symbol("F"),
  createElement(t, p, ...c) { const fl = []; (function push(x) { Array.isArray(x) ? x.forEach(push) : (x !== null && x !== undefined && x !== false) && fl.push(x); })(c); return { __el: true, type: t, props: { ...(p ?? {}), children: fl.length === 1 ? fl[0] : fl }, children: fl }; },
};
const mod = reg.factory((n) => n === "react" ? R : n === "react-dom" ? { createPortal: (e) => e } : (() => { throw new Error(n); })());
const slots = {};
mod.apply({ effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; }, locale: { register: () => () => {}, bind: () => (k) => k }, slots: { inject: (n, f) => f(), register: (e, c) => { slots[e.name] = c; return () => {}; } } });
const T = (k) => ({ title: "角色卡", srcLocal: "本地卡", search: "搜索", summoned: "已召唤", chars: "注入字符", unsummon: "解除召唤", viewInjected: "点这里看当前注入", injectedTitle: "注入原文", notSummoned: "当前没有注入任何内容。", loading: "加载中…", copy: "复制", empty_field: "（空）", detail: "详情" }[k] ?? k);

function mount(comp, props) { store = compStores.get(comp); if (store === undefined) { store = []; compStores.set(comp, store); } cur = 0; return comp(props); }
function kids(n) { if (!n || typeof n !== "object") return []; const p = n.props?.children; return [...new Set(Array.isArray(p) ? p : (p !== undefined ? [p] : []))]; }
const findAll = (n, p, acc = []) => { if (!n || typeof n !== "object") return acc; if (n.__el && p(n)) acc.push(n); kids(n).forEach((c) => findAll(c, p, acc)); return acc; };
const findByClass = (n, cls) => findAll(n, (x) => String(x.props?.className ?? "").includes(cls))[0] ?? null;
const txt = (n) => { if (typeof n === "string" || typeof n === "number") return String(n); if (!n || typeof n !== "object") return ""; return kids(n).map(txt).join(""); };

console.log("--- 1) 打开面板，看「当前召唤」行 ---");
let tree0 = mount(slots["conversation.input.right"], { t: T, sessionId: "p1" });
const rowTree = mount(slots["dsh-toolbox.menu"], { t: T, sessionId: "p1" });
findByClass(rowTree, "dtb-row").props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 500 }) } });
await new Promise((r) => setTimeout(r, 40));
// 再挂一次让 phase→open 的 effect 重跑（触发 refresh 请求）
tree0 = mount(slots["conversation.input.right"], { t: T, sessionId: "p1" });
await new Promise((r) => setTimeout(r, 80)); // 等 /status 异步返回并 setCurrent
tree0 = mount(slots["conversation.input.right"], { t: T, sessionId: "p1" }); // 这次树里才有 current
console.log(`  [诊断] 面板存在: ${findByClass(tree0, "dcs-panel") !== null}`);
console.log(`  [诊断] 已发请求: ${seen.join(" | ")}`);
try {
  const st = await fetch(`http://127.0.0.1:${port}/dsh-card-summon/status?sessionId=p1`).then(r => r.json());
  console.log(`  [诊断] /status → summon=${JSON.stringify(st.summon)?.slice(0,90)} injected=${st.injected}`);
} catch (e) { console.log("  [诊断] /status 失败:", e.message); }
const nowRow = findByClass(tree0, "dcs-now");
console.log(`  「当前召唤」行存在: ${nowRow !== null}`);
console.log(`  行内文字: ${JSON.stringify(txt(nowRow))}`);

console.log("\n--- 2) 找可点击的状态行（注入字符数那行）---");
const subBtn = findByClass(tree0, "dcs-sub-btn");
console.log(`  可点入口存在: ${subBtn !== null}`);
console.log(`  文字: ${JSON.stringify(txt(subBtn))}`);
console.log(`  title: ${JSON.stringify(subBtn?.props?.title)}`);

console.log("\n--- 3) 点它 → 应请求 /section 并显示注入原文 ---");
seen.length = 0;
subBtn.props.onClick({});
await new Promise((r) => setTimeout(r, 80));
console.log(`  发出的请求: ${seen.filter((x) => x.includes("/section")).join(" | ") || "(无)"}`);
tree0 = mount(slots["conversation.input.right"], { t: T, sessionId: "p1" });
const pre = findByClass(tree0, "dcs-field-tall");
const body = pre?.props?.children ?? "";
console.log(`  注入原文已显示: ${pre !== null}`);
console.log(`  文本长度: ${String(body).length} 字符（召唤时是 ${sum.injectedChars}）`);
console.log(`  首行: ${JSON.stringify(String(body).split("\n")[0])}`);
console.log(`  与召唤字符数一致: ${String(body).length === sum.injectedChars ? "✓" : "✗"}`);

let pass = 0, fail = 0;
const t = (label, cond, extra = "") => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label} ${extra}`); } };
console.log("\n=== 断言 ===");
t("当前召唤行渲染出来了", nowRow !== null);
t("行内有可点击的注入入口", subBtn !== null);
t("入口有 tooltip", typeof subBtn?.props?.title === "string" && subBtn.props.title.length > 0);
t("点击发出 /section 请求", seen.some((x) => x.includes("/section")));
t("注入原文已显示", pre !== null);
t("显示长度 = 实际注入长度", String(body).length === sum.injectedChars, `${String(body).length} vs ${sum.injectedChars}`);
t("内容确实是注入段（首行是 main 槽的一句话）", String(body).startsWith("写「"), String(body).slice(0, 24));
t("不再有文档式骨架（旧版首行 # 本会话已召唤角色卡）", !String(body).startsWith("# 本会话已召唤角色卡"));

server.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
