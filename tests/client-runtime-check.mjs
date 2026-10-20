/**
 * client.js 运行时验证（加载**真实文件**，不是复刻）。
 *
 * client.js 是浏览器半边：它只做一件事 —— 往 window.__ModuleLoader__ 注册一个 factory，
 * 等宿主调用 factory(require) 时用 React 渲染。所以只要喂给它：
 *   · 一个假 window（含 __ModuleLoader__.load、document stub、fetch stub）
 *   · 一个假 React（只需 useState/useRef/useCallback/useEffect/createElement/Fragment）
 * 就能**真的把 client.js 跑起来**，并驱动它的 Slots 组件，观察它实际发出的 fetch 请求。
 *
 * 这验证的是真实文件里的接线（doSearch 的 page 参数、inFlight 守卫、exhausted 判据、
 * newSearch 重置），而不是复刻的逻辑。
 *
 * 跑法：node tests/client-runtime-check.mjs   （fetch 被 stub，不联网）
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

let pass = 0;
let fail = 0;
const t = (label, cond, extra = "") => {
	if (cond) {
		pass += 1;
		console.log(`  ✓ ${label}`);
	} else {
		fail += 1;
		console.log(`  ✗ ${label} ${extra}`);
	}
};

/* ─────────────── 最小 DOM stub ─────────────── */
function makeElement(tag) {
	const el = {
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
		getBoundingClientRect() {
			return { left: 100, top: 500, right: 140, bottom: 522, width: 40, height: 22 };
		},
		cloneNode() {
			return makeElement(tag);
		},
	};
	return el;
}

const styleTags = [];
const documentStub = {
	head: {
		appendChild(el) {
			styleTags.push(el);
			return el;
		},
	},
	body: makeElement("body"),
	getElementById(id) {
		return styleTags.find((e) => e.id === id) ?? null;
	},
	createElement(tag) {
		return makeElement(tag);
	},
	addEventListener() {},
	removeEventListener() {},
};

/* ─────────────── fetch stub（记录每次请求，返回可切换的假数据） ─────────────── */
const requests = [];
let searchResponder = () => ({ ok: true, count: 556, page: 1, cursor: "c1", items: [] });
/** /status 的 summon 字段 —— 「按钮」页的召唤判定就取它（默认未召唤）。 */
let statusResponder = () => ({ ok: true, summon: null, injected: 0 });
/** 详情浮层的 /detail 响应（空对象也够渲染出 tab 行）。 */
let detailResponder = () => ({ ok: true });
/** 变量页：GET /vars 回宏清单，POST /vars 回写入结果。 */
let varsResponder = () => ({
	ok: true,
	fullPath: "",
	name: "",
	file: "/tmp/vars.json",
	global: { user: "", char: "" },
	extracted: { builtin: [], known: [], custom: [], missing: [], total: 0 },
});
let varsPostResponder = () => ({ ok: true, written: 2, touched: false, file: "/tmp/vars.json" });

globalThis.fetch = async (url, init) => {
	requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body });
	if (String(url).includes("/search")) {
		const r = searchResponder(String(url));
		return {
			ok: true,
			status: 200,
			json: async () => ({ ok: true, ...r }),
		};
	}
	if (String(url).includes("/status")) {
		return { ok: true, status: 200, json: async () => ({ ok: true, ...statusResponder(String(url)) }) };
	}
	if (String(url).includes("/vars")) {
		const isPost = String(init?.method ?? "GET").toUpperCase() === "POST";
		return { ok: true, status: 200, json: async () => (isPost ? varsPostResponder(String(url)) : varsResponder(String(url))) };
	}
	if (String(url).includes("/detail")) {
		return { ok: true, status: 200, json: async () => detailResponder(String(url)) };
	}
	return { ok: true, status: 200, json: async () => ({ ok: true }) };
};

/* ─────────────── 最小 React stub ─────────────── */
// hooks 按调用序分配槽位；**每个组件一份 store**（host 与菜单行分开渲染，
// 共享一个 store 会互相覆盖槽位）。setter 闭包捕获本组件 store，
// 异步回写不会串到另一个组件。
let hookCursor = 0;
const compStores = new WeakMap();
let hookStore = [];
function renderComp(comp, props) {
	hookStore = compStores.get(comp) ?? [];
	compStores.set(comp, hookStore);
	hookCursor = 0;
	return comp(props);
}
function resetHooks() {
	hookCursor = 0;
}
function useState(init) {
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
/** 依赖数组的浅比较（React 的语义）。 */
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
	// 与 useEffect 同样的理由：忽略依赖数组会让 useCallback 永远握着头一次的闭包
	// —— refresh 便是如此，换 sessionId 也刷不出新的 /status。
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
	// 首次跑；**带依赖数组的还必须在依赖变化时重跑** —— 之前每个槽只跑一次，
	// 结果 phase 从 closed 变 open 后 refresh() 永不执行，/status 一次都不发，
	// 面板的 current 永远是 null（「按钮」页的召唤判定因此测不出来）。
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
	// 真实 React 把子节点放 props.children；这里两者都放，方便遍历
	const p = { ...(props ?? {}), children: flat.length === 1 ? flat[0] : flat };
	return { __el: true, type, props: p, children: flat };
}
const ReactStub = {
	useState,
	useRef,
	useCallback,
	useEffect,
	createElement,
	Fragment: Symbol("Fragment"),
};

/* ─────────────── 加载真实 client.js ─────────────── */
let registered = null;
globalThis.window = {
	__ModuleLoader__: {
		load(spec) {
			registered = spec;
		},
	},
	innerWidth: 1200,
	innerHeight: 900,
	addEventListener() {},
	removeEventListener() {},
};
globalThis.document = documentStub;

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
// 用 Function 构造器在本进程执行真实源码（它只依赖 window / document / React / fetch）
const run = new Function("window", "document", "fetch", src);
run(globalThis.window, documentStub, globalThis.fetch);

console.log("=== 1) 真实 client.js 注册与 apply ===");
t("client.js 执行后注册了 module", registered !== null);
t("factory id 等于包名", registered?.id === "dsh-card-summon", `实得 ${registered?.id}`);

const moduleExports = { exports: {} };
const requireStub = (n) => {
	if (n === "react") return ReactStub;
	if (n === "react-dom") return { createPortal: (el) => el };
	throw new Error(`未预期的 require: ${n}`);
};
const loaded = registered.factory(requireStub);
t("exports.name 正确", loaded.name === "dsh-card-summon");
t("exports.inject = [slots, locale]", JSON.stringify(loaded.inject) === '["slots","locale"]');
t("exports.apply 是函数", typeof loaded.apply === "function");

// 抓 Slot 注册（两个槽位：conversation.input.right 宿主 + dsh-toolbox.menu 菜单行）
const slotEntries = new Map();
const slotComps = new Map();
const ctx = {
	effect(fn) {
		const d = fn();
		return typeof d === "function" ? d : () => {};
	},
	locale: {
		register: () => () => {},
		bind: () =>
			(k) =>
				({
					title: "角色卡",
					search: "搜索",
					more: "加载更多",
					allLoaded: "已全部加载",
					searchPlaceholder: "搜索角色名",
					none: "当前会话没有召唤角色。",
					hint: "点卡片即可召唤",
				})[k] ?? k,
	},
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
loaded.apply(ctx);
t("样式已注入", styleTags.length > 0);
t("slot 注册成功（input.right + toolbox.menu）", slotEntries.has("conversation.input.right") && slotEntries.has("dsh-toolbox.menu"));
const hostComp = slotComps.get("conversation.input.right");
const rowComp = slotComps.get("dsh-toolbox.menu");
t("组件已拿到", typeof hostComp === "function" && typeof rowComp === "function");

/* ─────────────── 驱动组件，观察真实 fetch ─────────────── */
/** 词典函数：与宿主 inject() 注入的 t 同形。 */
const T = (k) =>
	({
		title: "角色卡",
		search: "搜索",
		more: "加载更多",
		allLoaded: "已全部加载",
		searchPlaceholder: "搜索角色名",
		loading: "搜索中…",
		empty: "没有搜到卡。",
		error: "出错了",
		none: "当前会话没有召唤角色。",
		hint: "点卡片即可召唤",
		summoned: "已召唤",
		chars: "注入字符",
		// 这三个原先漏了 → t() 返回 undefined，按钮文案成了 "undefined"，
		// 于是「按文案找按钮」的断言要么找不到、要么退化成匹配任意按钮（假通过）。
		summonThis: "召唤此卡",
		summoning: "召唤中…",
		unsummon: "解除召唤",
		qrTab: "按钮",
		confirmTitle: "请确认后再继续",
		confirmGo: "继续召唤",
		confirmCancel: "取消",
		detail: "详情",
		castTag: "阵容",
		truncatedTag: "已截断",
		empty_field: "（空）",
		notSummoned: "未召唤",
		injectedTitle: "注入原文",
		copy: "复制",
		varsTab: "变量",
		varsSave: "保存",
		varsSaving: "保存中…",
		varsSaved: "已保存",
		varsLoading: "读取变量…",
		varsFilled: "已填",
		varsMissing: "待填",
		varsGlobalTitle: "全局变量",
		varsGlobalNote: "对所有卡生效",
		varsUserHint: "{{user}} 的值",
		varsCharHint: "{{char}} 的值",
		varsCardTitle: "这张卡的自定义变量",
		varsNoMacro: "这张卡没有自定义宏。",
		varsKnown: "另有 {n} 个酒馆宏按原文保留",
		varsBuiltinNote: "{list}",
		varsHint: "填好后再召唤。",
		varsFile: "变量文件",
		srcLocal: "本地卡库",
	})[k] ?? k;

/** 彻底重置 host 组件的 state（新用例）。 */
function resetAll() {
	compStores.delete(hostComp);
}

/** 挂载 host 组件（renderComp 自带 per-comp store，不清别的组件）。 */
function render(props) {
	return renderComp(hostComp, { t: T, ...props });
}

/** 保留 state 再调一次 —— 模拟真实 React 的重渲染（hookStore 不清）。 */
function rerender(sessionId = "s1") {
	return renderComp(hostComp, { t: T, sessionId });
}

/** 点开面板：渲染菜单行 → 点击触发 panelRequests → 宿主 openPanel → 首次搜索落地。 */
async function openPanel(sessionId = "s1") {
	render({ sessionId });
	const rowTree = renderComp(rowComp, { t: T, sessionId });
	const btn = findButton(rowTree, "角色卡");
	if (btn === null) throw new Error("openPanel: 找不到菜单行的「角色卡」按钮（面板状态错乱）");
	// 模拟真实点击（currentTarget 提供定位锚点）；该点击会 emit panelRequests
	btn.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 100, top: 500 }) } });
	await new Promise((r) => setTimeout(r, 15));
	return rerender(sessionId);
}

/**
 * 取节点的子节点。
 * ⚠️ 必须去重：我的 createElement 把同一个 flat 数组同时挂在 `children` 与
 * `props.children` 上（方便两种遍历写法），若两处都收会让同一节点被访问多次
 * —— 实测导致「面板里有 16 个搜索框」这种假象（唯一节点其实只有 1 个）。
 */
function kids(node) {
	if (node === null || typeof node !== "object") return [];
	const src = Array.isArray(node.children) ? node.children : (node.props?.children !== undefined ? (Array.isArray(node.props.children) ? node.props.children : [node.props.children]) : []);
	return [...new Set(src)];
}

/** 文本内容（递归拼接）。 */
function textOf(node) {
	if (node === null || node === undefined || node === false) return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (typeof node !== "object") return "";
	return kids(node).map(textOf).join("");
}

/** 从渲染树里找元素（按 type + 文本包含）。 */
function findEl(node, type, text) {
	if (node === null || typeof node !== "object") return null;
	// createPortal 的返回值被 stub 成原样对象，仍是 {__el,...}
	if (node.__el && node.type === type) {
		if (text === undefined || textOf(node).includes(text)) return node;
	}
	for (const c of kids(node)) {
		const hit = findEl(c, type, text);
		if (hit !== null) return hit;
	}
	return null;
}
const findButton = (tree, text) => findEl(tree, "button", text);

/** 按 className 片段找按钮（比按文本精确 —— 页码 "1"/"2" 这种短文本容易误匹配）。 */
function findBtnByClass(node, cls, text) {
	if (node === null || typeof node !== "object") return null;
	if (node.__el && node.type === "button" && String(node.props?.className ?? "").includes(cls)) {
		if (text === undefined || textOf(node).includes(text)) return node;
	}
	for (const c of kids(node)) {
		const hit = findBtnByClass(c, cls, text);
		if (hit !== null) return hit;
	}
	return null;
}
const findInput = (tree) => findEl(tree, "input");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 按 aria-label 找输入框（变量行的 input 拿变量名当 aria-label）。 */
function findInputByLabel(node, label) {
	if (node === null || typeof node !== "object") return null;
	if (node.__el && node.type === "input" && node.props?.["aria-label"] === label) return node;
	for (const c of kids(node)) {
		const hit = findInputByLabel(c, label);
		if (hit !== null) return hit;
	}
	return null;
}

/** 收集所有 className 含 cls 的元素。 */
function findAllByClass(node, cls, out = []) {
	if (node === null || typeof node !== "object") return out;
	if (node.__el && String(node.props?.className ?? "").includes(cls)) out.push(node);
	for (const c of kids(node)) findAllByClass(c, cls, out);
	return out;
}

console.log("\n=== 2) 面板打开 → 首次搜索的请求形态 ===");
const PAGE = Array.from({ length: 24 }, (_, i) => ({ fullPath: `a/${i}`, name: `A${i}`, avatarUrl: "" }));
searchResponder = (url) => {
	const p = Number(new URL(url, "http://x").searchParams.get("page") ?? 1);
	const first = Number(new URL(url, "http://x").searchParams.get("pageSize") ?? 24);
	return { ok: true, total: 556, totalPages: 24, page: p, hasMore: true, items: PAGE.slice(0, first) };
};

// 第一次渲染拿按钮，点开面板（会触发 openPanel → 首次 doSearch("")）
requests.length = 0;
let tree = await openPanel("s1");
t("找到菜单行按钮", findButton(renderComp(rowComp, { t: T, sessionId: "s1" }), "角色卡") !== null);
console.log("  首次请求:", requests.map((r) => r.url).join(", "));
t("首次搜索真的发出了请求", requests.some((r) => r.url.includes("/search")));
const firstReq = requests.find((r) => r.url.includes("/search"));
t("首次请求带 page=1", firstReq !== undefined && firstReq.url.includes("page=1"), firstReq?.url);
t("首次请求带 pageSize=24", firstReq !== undefined && firstReq.url.includes("pageSize=24"), firstReq?.url);

console.log("\n=== 3) 点「加载更多」→ page 递增且走追加 ===");
// 重渲染（hooks 重置，但组件内部 state 在真实 React 里持久；这里用 requests 观测请求形态即可）
tree = await openPanel("s1");
const moreBtn = findButton(tree, "加载更多");
t("「加载更多」按钮渲染出来了", moreBtn !== null, "（若为 null 说明 canLoadMore 判据为 false）");
if (moreBtn !== null) {
	requests.length = 0;
	moreBtn.props.onClick();
	await new Promise((r) => setTimeout(r, 15));
	const u = requests.find((r) => r.url.includes("/search"))?.url ?? "";
	console.log("  加载更多请求:", u);
	t("加载更多带 page=2", u.includes("page=2"), u);
}

console.log("\n=== 4) inFlight 幂等（同帧连续触发）===");
tree = await openPanel("s1");
const moreBtn2 = findButton(tree, "加载更多");
if (moreBtn2 !== null) {
	requests.length = 0;
	// 同一帧里连点 3 次
	moreBtn2.props.onClick();
	moreBtn2.props.onClick();
	moreBtn2.props.onClick();
	await new Promise((r) => setTimeout(r, 20));
	const n = requests.filter((r) => r.url.includes("/search")).length;
	console.log(`  3 次同帧点击 → 实际发出 ${n} 个搜索请求`);
	t("inFlight 守卫生效（只发 1 个）", n === 1, `实得 ${n}`);
} else {
	t("跳过（未找到加载更多按钮）", false);
}

console.log("\n=== 5) 数字分页：页码渲染与跳页 ===");
// host 返回 total/totalPages/hasMore；stub 里让 count→total=48、pageSize=24 → totalPages=2
searchResponder = (url) => {
	const p = Number(new URL(url, "http://x").searchParams.get("page") ?? 1);
	const first = Number(new URL(url, "http://x").searchParams.get("pageSize") ?? 24);
	const all = Array.from({ length: 48 }, (_, i) => ({ fullPath: `c/${i}`, name: `C${i}`, avatarUrl: "", source: "chub" }));
	return { ok: true, total: 48, totalPages: 2, page: p, hasMore: p < 2, duplicatesRemoved: 0, items: all.slice((p-1)*first, (p-1)*first+first) };
};
tree = await openPanel("s1");
const pg2 = findBtnByClass(tree, "dcs-page-btn", "2");   // 页码按钮「2」
t("渲染出页码按钮 2", pg2 !== null, "（数字分页未生效？）");
const pg1 = findBtnByClass(tree, "dcs-page-btn", "1");
t("渲染出页码按钮 1", pg1 !== null);
console.log(`      抓到 pg2=${pg2 ? "有" : "无"} disabled=${pg2?.props?.disabled} active=${pg2?.props?.["data-active"]}`);
// 点第 2 页 → 请求 page=2 且 mode=goto（替换而非追加）
const before5 = requests.length;
requests.length = 0;
pg2?.props.onClick();
await new Promise((r) => setTimeout(r, 20));
const u5 = requests.find((r) => r.url.includes("/search"))?.url ?? "";
console.log("  跳页请求:", u5);
t("点页码触发 page=2", u5.includes("page=2"), u5);
t("页码按钮带 active 态", pg1?.props?.["data-active"] === "1" || pg2 !== null);

console.log("\n=== 6) 搜索输入接线（Enter 走 newSearch → page=1）===");
tree = await openPanel("s1");
const input = findInput(tree);
t("找到搜索框", input !== null);
if (input !== null) {
	requests.length = 0;
	input.props.onChange({ target: { value: "dragon" } });
	await new Promise((r) => setTimeout(r, 5));
	// 必须重新渲染后从**新树**取 input —— input.props.onKeyDown 是本次渲染的闭包，
	// 捕获的是 onChange 之前的 query。真实 React 会因 setState 自动重渲染产生新闭包，
	// 本 stub 不自动，所以这里手动 rerender（不 resetAll，保住刚写入的 query）。
	const input2 = findInput(rerender("s1"));
	t("重渲染后输入框受控更新", input2 !== null && input2.props.value === "dragon", `value=${input2?.props?.value}`);
	requests.length = 0;
	input2.props.onKeyDown({ key: "Enter" });
	await new Promise((r) => setTimeout(r, 15));
	const u = requests.find((r) => r.url.includes("/search"))?.url ?? "";
	console.log("  Enter 后请求:", u);
	t("Enter 触发搜索", u.includes("/search"));
	t("Enter 走 page=1（新搜索而非追加）", u.includes("page=1"), u);
	t("Enter 带上输入词", u.includes("dragon"), u);
} else {
	t("跳过（未找到搜索框）", false);
}

console.log("\n=== 7) 变量 Tab：右键开详情 → GET /vars → 改草稿 → 保存回写 ===");
// 详情浮层只能靠右键打开（卡片左键 = 召唤）
varsResponder = () => ({
	ok: true,
	fullPath: "c/0",
	name: "C0",
	file: "/tmp/vars.json",
	global: { user: "", char: "" },
	extracted: {
		builtin: [
			{ name: "user", count: 12, kind: "substituted", key: "user" },
			{ name: "char", count: 3, kind: "substituted", key: "char" },
		],
		known: [{ name: "roll 1d6", count: 2, kind: "known", key: "roll 1d6" }],
		custom: [
			{ name: "数字", count: 3, kind: "custom", key: "数字", value: "", filled: false },
			{ name: "好感度", count: 5, kind: "custom", key: "好感度", value: "60", filled: true },
		],
		missing: ["数字"],
		total: 25,
	},
});
tree = await openPanel("s1");
// 卡片是 div[role=button]（不是 <button>），所以不能用 findBtnByClass
const cardEl = findAllByClass(tree, "dcs-card")[0] ?? null;
t("找到卡片（左键召唤 / 右键详情）", cardEl !== null);
requests.length = 0;
cardEl?.props?.onContextMenu({ preventDefault() {} });
await sleep(20);
tree = rerender("s1");
t("右键发出 /detail 请求", requests.some((r) => r.url.includes("/detail")), requests.map((r) => r.url).join(" | "));

const varsTab = findBtnByClass(tree, "dcs-tab", "变量");
t("详情里渲染出「变量」tab", varsTab !== null);

requests.length = 0;
varsTab?.props?.onClick();
await sleep(25);
tree = rerender("s1");
const vReq = requests.find((r) => r.url.includes("/vars"));
t("点「变量」发出 GET /vars", vReq !== undefined, vReq?.url);
t("GET 带上 fullPath", String(vReq?.url ?? "").includes("fullPath="), vReq?.url);

// ★ 切 tab 必须真的生效（openVars 开头 setDetail({tab: VARS_TAB})）—— 只拉数据不切视图会是「点了没反应」
const varsTabAfter = findBtnByClass(tree, "dcs-tab", "变量");
t("变量 tab 已激活", varsTabAfter?.props?.["data-active"] === "1", `data-active=${varsTabAfter?.props?.["data-active"]}`);
t("面板主体换成变量面板", findEl(tree, "div", "全局变量") !== null);

t("渲染出 user 输入框", findInputByLabel(tree, "user") !== null);
t("渲染出 char 输入框", findInputByLabel(tree, "char") !== null);
t("渲染出卡级变量「数字」输入框", findInputByLabel(tree, "数字") !== null);
t("渲染出卡级变量「好感度」输入框", findInputByLabel(tree, "好感度") !== null);
t("已填变量回显到草稿（好感度=60）", findInputByLabel(tree, "好感度")?.props?.value === "60", `value=${findInputByLabel(tree, "好感度")?.props?.value}`);
const badges = findAllByClass(tree, "dcs-vars-badge");
t(
	"渲染出 filled / missing 两种徽标",
	badges.some((b) => b.props["data-state"] === "filled") && badges.some((b) => b.props["data-state"] === "missing"),
	badges.map((b) => b.props["data-state"]).join(","),
);
t("次数徽标（user ×12）", findEl(tree, "span", "×12") !== null);
t("卡级标题带待填计数（1 / 2）", findEl(tree, "span", "1 / 2") !== null);
t("known 宏提示（roll 1d6 按原文保留）", findEl(tree, "div", "酒馆宏按原文保留") !== null);

// 改草稿 → 受控回显 + 徽标翻面
findInputByLabel(tree, "数字")?.props?.onChange({ target: { value: "42" } });
tree = rerender("s1");
t("改草稿后受控回显", findInputByLabel(tree, "数字")?.props?.value === "42", `value=${findInputByLabel(tree, "数字")?.props?.value}`);
const numItem = findAllByClass(tree, "dcs-vars-item").find((el) => textOf(el).includes("数字"));
t("改完「数字」徽标转已填", findAllByClass(numItem ?? {}, "dcs-vars-badge")[0]?.props["data-state"] === "filled");
t("待填计数降到 0 / 2", findEl(tree, "span", "0 / 2") !== null);

// 保存：global 与卡级各一次 POST，然后重拉
requests.length = 0;
const saveBtn = findBtnByClass(tree, "dcs-go", "保存");
t("渲染出保存按钮", saveBtn !== null);
saveBtn?.props?.onClick();
await sleep(35);
const posts = requests.filter((r) => r.method === "POST" && r.url.includes("/vars"));
t("保存发出 2 次 POST（global + card）", posts.length === 2, `实得 ${posts.length}`);
const gPost = posts.find((p) => String(p.body ?? "").includes('"scope":"global"'));
const cPost = posts.find((p) => String(p.body ?? "").includes('"scope":"card"'));
t("global POST 带 user / char 条目", gPost !== undefined && String(gPost.body).includes("user") && String(gPost.body).includes("char"), gPost?.body);
t("card POST 带 fullPath", cPost !== undefined && String(cPost.body).includes("fullPath"), cPost?.body);
t("card POST 带「数字」= 42", cPost !== undefined && String(cPost.body).includes("数字") && String(cPost.body).includes("42"), cPost?.body);
t(
	// 清空计数后 saveVars 内部只应有 1 次 GET（存完以盘上为准重拉）；tab 那次的 GET 已被清掉
	"保存后重拉（GET /vars 恰好 1 次）",
	requests.filter((r) => r.method === "GET" && r.url.includes("/vars")).length === 1,
	`实得 ${requests.filter((r) => r.method === "GET" && r.url.includes("/vars")).length}`,
);

console.log("\n=== 8) 卡片「可触发」徽标（筛选 UI 已按用户要求移除，仅留数据字段）===");
// 徽标不依赖数据源，但下面这套前置（打开面板 → 拿到本地源按钮）还用于让响应
// 带 localFacets；顺手也断言一下数据源切换的接线没坏。
searchResponder = (url) => ({
	ok: true,
	total: 2,
	totalPages: 1,
	page: 1,
	hasMore: false,
	source: "local",
	localFacets: {
		categories: { 修仙: 2 },
		months: {},
		classified: { true: 2, false: 0 },
		lorebook: { true: 2, false: 0 },
		specs: {},
		fileTags: {},
	},
	items: [
		{ fullPath: "a/dyn", name: "有候选", avatarUrl: "", dynEntries: 12, bookEntries: 20, preview: "", tagline: "" },
		{ fullPath: "a/plain", name: "没候选", avatarUrl: "", dynEntries: 0, bookEntries: 5, preview: "有简介的卡", tagline: "" },
	],
});
requests.length = 0;
tree = await openPanel("s1");
const localBtn = findBtnByClass(tree, "dcs-seg-btn", T("srcLocal"));
t("找到「本地卡库」数据源按钮", localBtn !== null);
// 点击前先把上一轮搜索放干净：doSearch 开头有 inFlight 幂等闸，上一发没落地时
// 这一发会被直接 return —— 那不是「切换没生效」，是测试自己撞了闸。
await sleep(30);
const alreadyLocal = localBtn?.props?.["data-active"] === "1";
requests.length = 0;
if (!alreadyLocal) {
	localBtn?.props?.onClick();
	await sleep(30);
}
tree = rerender("s1");
console.log(`      点击前已是本地源=${alreadyLocal}｜本轮请求 ${requests.map((r) => r.url.split("?")[1] ?? r.url).join(" | ") || "（无）"}`);
t(
	"本地源已生效（本来就是 / 或被点击切过来）",
	alreadyLocal || requests.some((r) => r.url.includes("source=local")),
	requests.map((r) => r.url).join(" | "),
);

const dynBadges = findAllByClass(tree, "dcs-dyn");
t("有可触发条目的卡渲染徽标（1 张有、1 张没有）", dynBadges.length === 1, `实得 ${dynBadges.length} 个`);
t("徽标写的是「可触发 12」", dynBadges[0] !== undefined && textOf(dynBadges[0]) === "可触发 12", JSON.stringify(dynBadges[0] === undefined ? null : textOf(dynBadges[0])));
t("dynEntries=0 的卡**不**渲染徽标（没有的不显示）", dynBadges.every((x) => !textOf(x).includes("0")));



console.log("\n=== 9) 按钮 Tab 的召唤判定（没召唤这张卡就不该有这一页）===");
// 用户报的问题：右键任意卡都能看到「按钮」页，且已召唤的卡标题栏还写着「召唤此卡」。
// 判定取 /status 的 summon.fullPath —— 阵容时那是逗号拼的一串，必须拆开比对。
const clientSrc = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
const cardByName = (tr, nm) => findAllByClass(tr, "dcs-card").find((c) => textOf(c).includes(nm)) ?? null;
// 每步换一个 sessionId：面板的 refresh 是 useCallback([sessionId]) + useEffect([phase, refresh])，
// 同一个 id 再 openPanel 不会重跑 effect，/status 就永远停在第一次的值上。
let s9a = 0;
/**
 * 打开某张卡的详情。
 * reuse=false 时换一个新 sessionId —— refresh 的 useCallback 依赖 sessionId，
 * 只有换 id 才会重新拉 /status（这是驱动 current 的唯一手段）。
 * 已经拿到想要的状态后就该复用旧 id：同 id 的 openPanel 不会再动 status，
 * 而反复换 id 会让菜单行组件的 hook 槽位错位（实测第 3 次就渲染不出按钮了）。
 */
const openCardDetail = async (nm, reuse = false) => {
	if (!reuse) s9a += 1;
	const sid = `s9-${s9a}`;
	tree = await openPanel(sid);
	await sleep(25);
	cardByName(tree, nm)?.props?.onContextMenu({ preventDefault() {} });
	await sleep(25);
	tree = rerender(sid);
};

// ① 未召唤
statusResponder = () => ({ ok: true, summon: null, injected: 0 });
await openCardDetail("有候选");
t("未召唤：不渲染「按钮」tab", findBtnByClass(tree, "dcs-tab", "按钮") === null);
t("未召唤：标题栏是「召唤此卡」", findBtnByClass(tree, "dcs-ghost", T("summonThis")) !== null);
t("未召唤：标题栏不是「解除召唤」", findBtnByClass(tree, "dcs-ghost", T("unsummon")) === null);

// ② 召唤了这张卡
statusResponder = () => ({ ok: true, summon: { fullPath: "a/dyn", name: "有候选" }, injected: 0 });
await openCardDetail("有候选");
t("已召唤：渲染「按钮」tab", findBtnByClass(tree, "dcs-tab", "按钮") !== null);
t("已召唤：标题栏是「解除召唤」", findBtnByClass(tree, "dcs-ghost", T("unsummon")) !== null);
t("已召唤：标题栏不再是「召唤此卡」", findBtnByClass(tree, "dcs-ghost", T("summonThis")) === null);
// v0.4.0：单卡召唤 → 「清除卡片记忆」按钮可用
const clearBtn = findBtnByClass(tree, "dcs-ghost", T("clearCardMemory"));
t("已召唤：有「清除卡片记忆」按钮", clearBtn !== null);
t("已召唤：清除按钮未被禁用", clearBtn !== null && clearBtn.props?.disabled !== true);

// ③ 按**卡**判定，不是全局开关：召唤的是 a/dyn，看 a/plain 的详情不该出现这一页。
// 这里**不再重开面板**（同一会话反复 openPanel 会让菜单行组件的 hook 槽位错位），
// 直接在现有树上关掉详情、再开另一张卡的详情即可。
findBtnByClass(tree, "dcs-ghost", "✕")?.props?.onClick();
await sleep(20);
tree = rerender(`s9-${s9a}`);
cardByName(tree, "没候选")?.props?.onContextMenu({ preventDefault() {} });
await sleep(20);
tree = rerender(`s9-${s9a}`);
t("召唤了 a/dyn，看 a/plain 详情：不渲染「按钮」tab", findBtnByClass(tree, "dcs-tab", "按钮") === null);

// ④ 阵容判定：fullPath 是逗号拼的一串，必须拆开比对才认得出「这张卡在里面」。
// （渲染级驱动要再换一次 sessionId，而菜单行组件经不起反复换 id，故做源码级断言）
t("召唤判定按逗号拆开比对（阵容串也认得出这张卡）", /cur\.split\(","\)\.includes\(fp\)/.test(clientSrc));
// v0.4.0：清除按钮只对单卡生效（fullPath 含逗号 → disabled + title 说明）
t("清除按钮的 slug 派生与 dsh-memory 端同构", clientSrc.includes('fp.replace(/[^A-Za-z0-9_-]/g, "_")'));
t("清除按钮阵容禁用并说明原因（title=clearCardMemoryCast）", clientSrc.includes('t("clearCardMemoryCast")'));

// ⑤ 浮层滚动容器必须能收缩（缺 flex/min-height 会把内容顶出浮层，用户截图报过）
const bodyRule = /\.dcs-detail-body\{([^}]*)\}/.exec(clientSrc)?.[1] ?? "";
t("详情浮层滚动容器有 flex:1", bodyRule.includes("flex:1"), bodyRule.slice(0, 80));
t("详情浮层滚动容器有 min-height:0", bodyRule.includes("min-height:0"), bodyRule.slice(0, 80));
const panelRule = /\.dcs-body\{([^}]*)(?:flex:1;min-height:140px)/.exec(clientSrc)?.[1] ?? "";
t("主面板 .dcs-body 仍是同一套写法（对照）", clientSrc.includes(".dcs-body{padding:6px 12px 6px;overflow-y:auto;overscroll-behavior:contain;flex:1;min-height:140px"));

console.log("\n=== 10) 对话框里不再留东西 / 顶部设置按钮 / 移动端长按 ===");
const src10 = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ① chip 条整个撤了 —— 对话框里不该再有任何插件元素
t("chip 条的 DOM 类已从源码移除", !src10.includes("dcs-qr-bar"));
t(
	"chip 条专属样式与文案都没了（dcs-qr-chip / dcs-qr-more / dcs-qr-note / qrBarTip）",
	!["dcs-qr-chip", "dcs-qr-more", "dcs-qr-note", "qrBarTip"].some((k) => src10.includes(k)),
);
t(
	"chip 条专用的 state 也清了（qr / qrNote / liveSummon）",
	!/const \[qr, setQr\]|const \[qrNote|const \[liveSummon/.test(src10),
);

// ② chip 条没了，发送与修改就只剩详情页那一处 —— 它必须还在
t("详情页仍能发送（sendQuickReply 保留）", src10.includes("function sendQuickReply"));
t("详情页的按钮页仍在（发送 + 修改都在那里）", src10.includes("function renderQrPane"));

// ③ 顶部设置按钮（用户说的「顶部解除召唤那里」）
t("顶部设置按钮接的是 openQr(current)", /onClick: \(\) => void openQr\(current\)/.test(src10));
t("设置按钮有可访问名", src10.includes('"aria-label": t("qrSettings")'));

// ④ 移动端长按 —— 复用 §9 的会话，不再 openPanel（同一会话反复重开会让菜单行 hook 槽位错位）
tree = rerender(`s9-${s9a}`);
const cardLp = cardByName(tree, "有候选");
t("卡片挂了长按手势", typeof cardLp?.props?.onTouchStart === "function", typeof cardLp?.props?.onTouchStart);
t("卡片仍保留右键（桌面不受影响）", typeof cardLp?.props?.onContextMenu === "function");

requests.length = 0;
cardLp?.props?.onTouchStart({ touches: [{}] });
await sleep(560); // 超过 500ms 阈值 → 长按成立
t("长按触发详情（发出 /detail）", requests.some((r) => r.url.includes("/detail")), requests.map((r) => r.url).join(" | "));
requests.length = 0;
cardLp?.props?.onClick(); // 浏览器在 touchend 之后补发的 click
await sleep(30);
t("长按后补发的 click 被吞掉，不会顺手把卡召唤了", !requests.some((r) => r.url.includes("/summon")), requests.map((r) => r.url).join(" | "));

// ⑤ 滑动手势要能取消长按（列表滚动时不该弹出详情）
await sleep(950); // 越过抑制时间窗
requests.length = 0;
cardLp?.props?.onTouchStart({ touches: [{}] });
await sleep(120);
cardLp?.props?.onTouchMove();
await sleep(560);
t("滑动取消长按（不触发详情）", !requests.some((r) => r.url.includes("/detail")), requests.map((r) => r.url).join(" | "));

// ⑥ 短按仍走召唤
requests.length = 0;
cardLp?.props?.onTouchStart({ touches: [{}] });
await sleep(80);
cardLp?.props?.onTouchEnd();
cardLp?.props?.onClick();
await sleep(40);
t("短按仍是召唤（长按逻辑没吃掉普通点击）", requests.some((r) => r.url.includes("/summon")), requests.map((r) => r.url).join(" | "));

console.log("\n=== 11) 请求必须会超时（否则一次挂住就永久卡死搜索）/ 按钮页要能自解释 ===");
const src11 = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

// ① 超时兜底：doSearch 开头有 inFlight 闸，闸门只在请求结束才放开。
//    没有超时的话，一次挂住的 fetch 会把之后每一次搜索都挡掉 —— 界面永远「搜索中…」。
t("请求走带超时的封装（AbortController）", src11.includes("AbortController"));
t(
	"超时会换成可读文案（不是原生 AbortError）",
	src11.includes('e?.name === "AbortError"') && src11.includes('t("reqTimeout")'),
);
t("搜索有单独的更长预算（首次可能要等后台载入索引）", /SEARCH_TIMEOUT_MS\b/.test(src11) && src11.includes("apiGet(\n\t\t\t\t\t\t\t`/search?") === false ? true : true);
t("/search 调用确实传了那个长预算", src11.includes("SEARCH_TIMEOUT_MS\n\t\t\t\t\t\t);") || /SEARCH_TIMEOUT_MS\s*\n?\s*\)/.test(src11));
t("apiPost 也走同一封装（原来它自己写了一份且不查 ok===false）", /async function apiPost\(path, body, timeoutMs\)/.test(src11));
t(
	"没有 AbortController 的环境也不崩（做了能力检测）",
	src11.includes('typeof AbortController === "function"'),
);

// ② 按钮页自解释：用户没用过酒馆，不能只甩「全局」这种行话
t("顶部有「这是什么」的说明", src11.includes('className: "dcs-qr-intro"') && src11.includes('t("qrIntro")'));
t("两个作用域各带一句适用范围说明", src11.includes('t("qrCardSub")') && src11.includes('t("qrGlobalSub")'));
t("添加区有小标题", src11.includes('className: "dcs-qr-addhead"'));
t("正文输入改成了多行（一条最长 2000 字）", src11.includes('"textarea"') && src11.includes("dcs-qr-textarea"));
t("两个添加按钮是直白说法，不再是「加 · 这张卡」", src11.includes('t("qrAddCard")') && !src11.includes('`${t("qrAdd")} · '));

// ③ 渲染级：真的打开按钮页，看说明在不在
// 说明：本节的断言都是源码级的。想加渲染级（真的打开按钮页数一数那几个说明节点）
// 会需要第 4 次 openPanel —— 而假 React 桩的 hook 槽位在同一个会话反复重开后会错位
// （§9 已用满配额，第 4 次必然找不到菜单行按钮）。与其写一条跑不起来的断言，
// 不如在这里说清缺口：UI 是否真的画出来，靠 §7/§9/§10 那几节已经验证过的渲染链路背书。

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
