/**
 * 面板「虚构声明」开关的渲染级验证（加载**真实** client.js，不是复刻逻辑）。
 *
 * 为什么单独一个文件：client-runtime-check.mjs 里那套假 React 桩的 hook 槽位在同一个
 * 模块实例里反复 openPanel 会错位（它自己 §11 的注释记了这条），而本用例要的正是
 * **干净的一个面板实例** —— 与其去挤它的配额，不如给开关一条独立的渲染链路。
 *
 * 锁死四件事：
 *   ① 开关行真的被画出来（角色卡面板里有 role="switch" 的按钮）
 *   ② aria-checked / data-on 与 /status 回传的生效态一致
 *   ③ 点一下发出 POST /settings，body 是**目标值**（不是取反指令）
 *   ④ 后台回传的态被采纳（面板不自己猜），并把 aria-checked 翻过来
 *
 * 跑法：node tests/fiction-frame-ui-check.mjs   （fetch 全 stub，不联网）
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const t = (label, cond, extra = "") => {
	if (cond) {
		pass += 1;
		console.log(`  ✓ ${label}`);
	} else {
		fail += 1;
		console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ""}`);
	}
};

/* ─────────────── 最小 DOM stub ─────────────── */
const styleTags = [];
function makeElement(tag) {
	return {
		tagName: String(tag).toUpperCase(),
		children: [],
		style: {},
		dataset: {},
		_attrs: {},
		textContent: "",
		id: "",
		className: "",
		appendChild(c) {
			this.children.push(c);
			return c;
		},
		removeChild(c) {
			this.children = this.children.filter((x) => x !== c);
			return c;
		},
		remove() {},
		setAttribute(k, v) {
			this._attrs[k] = v;
		},
		getAttribute(k) {
			return this._attrs[k];
		},
		querySelector() {
			return null;
		},
		addEventListener() {},
		removeEventListener() {},
	};
}
const documentStub = {
	head: { appendChild: (el) => styleTags.push(el) },
	body: { appendChild() {}, removeChild() {} },
	createElement(tag) {
		return makeElement(tag);
	},
	getElementById(id) {
		return styleTags.find((e) => e.id === id) ?? null;
	},
	addEventListener() {},
	removeEventListener() {},
};

/* ─────────────── fetch stub ─────────────── */
const requests = [];
/** /status 回什么 —— 开关态从这里来。初始：开、来源 config。 */
let frameState = { enabled: true, source: "config", custom: false, file: "/tmp/settings.json" };
globalThis.fetch = async (url, init) => {
	const u = String(url);
	requests.push({ url: u, method: init?.method ?? "GET", body: init?.body });
	if (u.includes("/settings")) {
		const body = init?.body ? JSON.parse(init.body) : {};
		// 模拟后台：采纳目标值并回传新态（与 index.js 的 /settings 语义一致）
		if (body.fictionFrame === true || body.fictionFrame === false) {
			frameState = { ...frameState, enabled: body.fictionFrame, source: "panel" };
		}
		return { ok: true, status: 200, json: async () => ({ ok: true, fictionFrame: frameState, touched: ["s1"] }) };
	}
	if (u.includes("/status")) {
		return { ok: true, status: 200, json: async () => ({ ok: true, summon: null, injected: 0, fictionFrame: frameState }) };
	}
	return { ok: true, status: 200, json: async () => ({ ok: true, items: [], count: 0 }) };
};

/* ─────────────── 最小 React stub（与 client-runtime-check 同语义） ─────────────── */
// hooks 按调用序分配槽位；**每个组件一份 store** —— host 与菜单行是两个组件，
// 共用一个 store 会互相覆盖槽位（实测直接 TypeError: prev.deps of null）。
let hookStore = [];
/** @type {WeakMap<Function, Array>} */
const compStores = new WeakMap();
let hookCursor = 0;
function renderComp(comp, props) {
	hookStore = compStores.get(comp) ?? [];
	compStores.set(comp, hookStore);
	hookCursor = 0;
	return comp(props);
}
function useState(init) {
	// ⚠️ 必须先把 store 抓成本地快照：setter 是异步/跨组件调用的，
	// 若在里面读模块级 hookStore，那时它可能已指向**另一个组件**的 store
	// （实测：菜单行点击后 setPhase 写进了菜单行的 store，host 的 phase 永远 closed）。
	const store = hookStore;
	const i = hookCursor++;
	if (store[i] === undefined) store[i] = typeof init === "function" ? init() : init;
	const set = (v) => {
		store[i] = typeof v === "function" ? v(store[i]) : v;
	};
	return [store[i], set];
}
function useRef(init) {
	const store = hookStore;
	const i = hookCursor++;
	if (store[i] === undefined) store[i] = { current: init };
	return store[i];
}
function sameDeps(a, b) {
	if (!a || !b || a.length !== b.length) return false;
	for (let k = 0; k < a.length; k += 1) if (!Object.is(a[k], b[k])) return false;
	return true;
}
function useCallback(fn, deps) {
	const store = hookStore;
	const i = hookCursor++;
	const prev = store[i];
	const hasDeps = Array.isArray(deps);
	if (prev === undefined || (hasDeps && !sameDeps(prev.deps, deps))) {
		store[i] = { fn, deps: hasDeps ? deps : null };
		return fn;
	}
	return prev.fn;
}
function useEffect(fn, deps) {
	const store = hookStore;
	const i = hookCursor++;
	const hasDeps = Array.isArray(deps);
	const prev = store[i];
	if (prev === undefined || (hasDeps && !sameDeps(prev.deps, deps))) {
		if (prev !== undefined && typeof prev.cleanup === "function") prev.cleanup();
		const cleanup = fn();
		store[i] = { deps: hasDeps ? deps : null, cleanup: typeof cleanup === "function" ? cleanup : null };
	}
}
function createElement(type, props, ...children) {
	const flat = [];
	const push = (c) => {
		if (Array.isArray(c)) c.forEach(push);
		else if (c !== null && c !== undefined && c !== false) flat.push(c);
	};
	children.forEach(push);
	const p = { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat };
	return { __el: true, type, props: p, children: flat };
}
const ReactStub = { useState, useRef, useCallback, useEffect, createElement, Fragment: Symbol("Fragment") };

/* ─────────────── 加载真实 client.js ─────────────── */
let registered = null;
const win = {
	__ModuleLoader__: {
		load(spec) {
			registered = spec;
		},
	},
	innerWidth: 1200,
	innerHeight: 900,
	addEventListener() {},
	removeEventListener() {},
	confirm: () => true,
};
const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
new Function("window", "document", "fetch", src)(win, documentStub, globalThis.fetch);

t("client.js 注册了 module", registered !== null);

const slotEntries = new Map();
const slotComps = new Map();
const ctx = {
	effect(fn) {
		const d = fn();
		return typeof d === "function" ? d : () => {};
	},
	locale: { register: () => () => {}, bind: () => (k) => k },
	slots: {
		inject(name, fn) {
			fn();
		},
		register(entry, comp) {
			slotEntries.set(entry.name, entry);
			slotComps.set(entry.name, comp);
			return () => {};
		},
	},
};
/**
 * 官方 Switch 的桩：形状逐项照 packages/client/ui-primitives/src/Switch.tsx —
 * 关键是 `aria-checked` 传的是**布尔**（真 React 序列化成 "true"/"false"，
 * 但在元素 props 上仍是布尔）。我方兜底版传的是字符串 + data-on。
 * 所以「aria-checked 是布尔」「没有 data-on」这两条能证明用的是官方原语。
 */
const SwitchStub = (props) =>
	ReactStub.createElement(
		"button",
		{
			type: "button",
			role: "switch",
			"aria-checked": props.checked,
			"aria-label": props.label,
			title: props.title,
			disabled: props.disabled === true,
			className: "switch-stub",
			onClick: () => props.onChange(!props.checked),
		},
		ReactStub.createElement("span", { className: "switch-stub-thumb" }),
	);

const loaded = registered.factory((n) => {
	if (n === "react") return ReactStub;
	if (n === "react-dom") return { createPortal: (el) => el };
	if (n === "@deepseek-ai/dsh-client-ui-primitives") return { Switch: SwitchStub };
	throw new Error(`未预期的 require: ${n}`);
});
loaded.apply(ctx);
const hostComp = slotComps.get("conversation.input.right");
const rowComp = slotComps.get("dsh-toolbox.menu");
t("host + 菜单行组件已注册", typeof hostComp === "function" && typeof rowComp === "function");

/* ─────────────── 工具 ─────────────── */
const T = (k) =>
	({
		title: "角色卡",
		fictionFrameLabel: "虚构声明",
		fictionFrameSwitch: "虚构声明开关",
		fictionFrameHint: "注入一段声明。",
		fictionFrameSourcePanel: "面板已手动设置",
		fictionFrameSourceConfig: "跟随插件配置",
		fictionFrameFailed: "切换失败",
	})[k] ?? k;

function kids(node) {
	if (node === null || typeof node !== "object") return [];
	const src2 = Array.isArray(node.children)
		? node.children
		: node.props?.children !== undefined
			? Array.isArray(node.props.children)
				? node.props.children
				: [node.props.children]
			: [];
	return [...new Set(src2)];
}
function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (typeof node !== "object") return "";
	return kids(node).map(textOf).join("");
}
function findEl(node, pred) {
	if (node === null || typeof node !== "object") return null;
	if (node.__el && pred(node)) return node;
	for (const c of kids(node)) {
		const hit = findEl(c, pred);
		if (hit !== null) return hit;
	}
	return null;
}
/**
 * 找开关按钮。
 *
 * ⚠️ 不能只认 `n.type === "button"`：开关现在是**官方 Switch 组件**（`h(Switch, props)`），
 * 在渲染树里它先是 `type === SwitchStub 函数` 的一个元素，函数那一层不展开，
 * 所以按标签找会返回 null（实测：判 null 后所有断言连带崩）。
 * 判据改成「组件元素，且 props 里有 checked/label」或原生 button + role=switch。
 */
const isSwitchEl = (n) =>
	(n.type === "button" && n.props?.role === "switch") ||
	(typeof n.type === "function" && "checked" in (n.props ?? {}) && "onChange" in (n.props ?? {}));

/**
 * 取开关的**真实按钮**：组件元素展开成它渲染出的 button。
 *
 * 这正好也验证了「用的是官方原语」—— `h(Switch, ...)` 只有传进去的是组件才会
 * 产生一个待展开的函数元素；手搓版在这里直接就是 button，展开后 props 不变。
 * 返回 `{ el, props, rendered }`：`props` 是组件收到的 props（checked/label/title），
 * `rendered` 是展开后的原生 button（aria-checked/onClick 在这里）。
 */
function switchOf(tree) {
	const el = findEl(tree, isSwitchEl);
	if (el === null) return null;
	if (el.type === "button") return { el, props: el.props, rendered: el, viaComponent: false };
	const rendered = renderComp(el.type, el.props);
	return { el, props: el.props, rendered, viaComponent: true };
}
const findButton = (tree, text) => findEl(tree, (n) => n.type === "button" && textOf(n).includes(text));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ─────────────── 打开面板 ─────────────── */
console.log("\n=== 1) 打开面板 ===");
renderComp(hostComp, { t: T, sessionId: "s1" });
const rowTree = renderComp(rowComp, { t: T, sessionId: "s1" });
const rowBtn = findButton(rowTree, "角色卡");
t("菜单行有「角色卡」按钮", rowBtn !== null);
rowBtn.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 500 }) } });
await sleep(20);
// 第一遍渲染才让 phase=open 落地、useEffect 里的 refresh() 发起 /status；
// 它是异步的，所以必须再等一拍、再渲染一次，frame state 才有值。
// （frame === null 时刻意不渲染开关，正是为了不闪一下「关」再跳「开」。）
renderComp(hostComp, { t: T, sessionId: "s1" });
await sleep(20);
let tree = renderComp(hostComp, { t: T, sessionId: "s1" });

console.log("\n=== 2) 开关渲染（必须是官方 Switch 原语）===");
let sw = switchOf(tree);
t("面板里有开关元素", sw !== null);
// 标题与说明在行的左侧文字块里，不在按钮上（官方设置行就是这么分的）
t("行内有「虚构声明」标题", textOf(tree).includes("虚构声明"));
t("开关是无障碍名齐全的原生 button", sw !== null && typeof sw.rendered?.props?.["aria-label"] === "string" && String(sw.rendered.props["aria-label"]).length > 0);
t("开关 role=switch", sw?.rendered?.props?.role === "switch", String(sw?.rendered?.props?.role));
// ★ 用官方原语的直接证据：渲染树里先是**组件**元素，再展开成 button
t("用的是官方 Switch 组件（不是手搓 button）", sw?.viaComponent === true);
// ★ 官方 Switch 读的是 checked 布尔，手搓版读的是 data-on / 字符串 aria-checked
t("开关收 checked 布尔（官方 API）", sw?.props?.checked === true, String(sw?.props?.checked));
t("不再是手搓开关（无 data-on / 无手搓类名）", sw?.rendered?.props?.["data-on"] === undefined && !String(sw?.rendered?.props?.className ?? "").includes("dcs-switch"));
t("展开后的 aria-checked 是布尔（官方原语写法）", typeof sw?.rendered?.props?.["aria-checked"] === "boolean", typeof sw?.rendered?.props?.["aria-checked"]);
// ★ 主题是黑白的：开态轨道由官方 Switch 的 CSS 取 brand-primary，插件不得再自己上色
t("插件没有自带蓝色轨道样式（不覆盖官方开态配色）", !src.includes("state-business-primary,var(--dsw-alias-brand-primary)"));
t("插件不定义任何自造开关轨道（交给官方 Switch.module.css）", !src.includes(".dcs-switch{") && !src.includes("dcs-switch-fallback"));
t("title 里标了值来源（跟随配置）", String(sw?.props?.title ?? "").includes("跟随插件配置"), String(sw?.props?.title));

console.log("\n=== 3) 点一下 = 发目标值 ===");
const before = requests.filter((r) => r.url.includes("/settings")).length;
sw.rendered.props.onClick();
await sleep(30);
const posts = requests.filter((r) => r.url.includes("/settings") && r.method === "POST");
t("发出了 POST /settings", posts.length > before, JSON.stringify(requests.map((r) => `${r.method} ${r.url}`)));
const body = posts.length > 0 ? JSON.parse(posts[posts.length - 1].body) : {};
t("body 是目标值 fictionFrame:false（不是取反指令）", body.fictionFrame === false, JSON.stringify(body));

console.log("\n=== 4) 采纳后台回传的态 ===");
tree = renderComp(hostComp, { t: T, sessionId: "s1" });
sw = switchOf(tree);
t("checked 已翻成 false", sw?.props?.checked === false, String(sw?.props?.checked));
t("title 的来源已变成「面板已手动设置」", String(sw?.props?.title ?? "").includes("面板已手动设置"), String(sw?.props?.title));

console.log("\n=== 5) 再点一下回到开 ===");
sw.rendered.props.onClick();
await sleep(30);
const posts2 = requests.filter((r) => r.url.includes("/settings") && r.method === "POST");
t("第二个请求 body 是 fictionFrame:true", JSON.parse(posts2[posts2.length - 1].body).fictionFrame === true);
tree = renderComp(hostComp, { t: T, sessionId: "s1" });
t("checked 回到 true", switchOf(tree)?.props?.checked === true);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
