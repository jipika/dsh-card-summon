/**
 * 数字分页 UI 与右键详情的纯逻辑验证。
 *
 * 为什么单独一个文件：分页算术与字段渲染是纯函数，可在没有 DOM/React 的情况下穷举验证；
 * 而 client-runtime-check.mjs 要驱动真实组件、state 较重，不适合再塞边界穷举。
 *
 * 跑法：node tests/pagination-ui-check.mjs   （不需要网络）
 */
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;
const t = (label, cond, extra = "") => {
	if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
	else { fail += 1; console.log(`  ✗ ${label} ${extra}`); }
};

// 从真实 client.js 里抽出 pageNumbers 与 promptFieldText（用加载真实文件的方式，而非复制源码）
const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");
let registered = null;
globalThis.window = { __ModuleLoader__: { load: (s) => { registered = s; } }, innerWidth: 1200, innerHeight: 900, addEventListener() {}, removeEventListener() {} };
const styles = [];
globalThis.document = {
	head: { appendChild: (e) => { styles.push(e); return e; } },
	body: {},
	getElementById: (id) => styles.find((e) => e.id === id) ?? null,
	createElement: () => ({ style: {}, appendChild() {}, remove() {}, setAttribute() {} }),
	addEventListener() {}, removeEventListener() {},
};
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
new Function("window", "document", "fetch", src)(globalThis.window, globalThis.document, globalThis.fetch);

// 用一个探针 React，把组件渲染出来，再从内部行为推断纯函数 —— 更直接的办法是
// 用 vm 抽取函数体；这里改为「通过组件行为反证」，纯函数单独用同源代码文本重建。
// 为保持「验证的是真实文件」这一原则，下面从源码文本里提取函数并 eval（只取纯函数段）。
function extract(name) {
	const i = src.indexOf(`function ${name}(`);
	if (i < 0) throw new Error(`源码里找不到 ${name}`);
	// 从函数声明起，按花括号配平截取
	let depth = 0, j = src.indexOf("{", i);
	for (let k = j; k < src.length; k++) {
		if (src[k] === "{") depth++;
		else if (src[k] === "}") { depth--; if (depth === 0) { return src.slice(i, k + 1); } }
	}
	throw new Error(`${name} 花括号不配平`);
}
function extractConst(name) {
	const i = src.indexOf(`const ${name} = [`);
	if (i < 0) throw new Error(`源码里找不到 ${name}`);
	let depth = 0, j = src.indexOf("[", i);
	for (let k = j; k < src.length; k++) {
		if (src[k] === "[") depth++;
		else if (src[k] === "]") { depth--; if (depth === 0) { return src.slice(i, k + 1); } }
	}
	throw new Error(`${name} 不配平`);
}

const pageNumbers = new Function(`${extract("pageNumbers")}; return pageNumbers;`)();
const PROMPT_FIELDS = new Function(`${extractConst("PROMPT_FIELDS")}; return PROMPT_FIELDS;`)();
const promptFieldText = new Function(`${extract("promptFieldText")}; return promptFieldText;`)();

console.log("=== 1) pageNumbers：页数少时全列 ===");
t("total=1 → [1]", JSON.stringify(pageNumbers(1, 1)) === "[1]");
t("total=5 → [1..5]", JSON.stringify(pageNumbers(3, 5)) === "[1,2,3,4,5]");
t("total=7 → [1..7]（边界，不折叠）", JSON.stringify(pageNumbers(4, 7)) === "[1,2,3,4,5,6,7]");

console.log("\n=== 2) pageNumbers：页数多时折叠 ===");
const r8 = pageNumbers(4, 8);
console.log(`  page=4 total=8 → ${JSON.stringify(r8)}`);
t("total=8 开始折叠", r8.includes("…"));
t("始终含第 1 页", r8[0] === 1);
t("始终含最后一页", r8[r8.length - 1] === 8);
t("含当前页", r8.includes(4));
const mid = pageNumbers(10, 40);
console.log(`  page=10 total=40 → ${JSON.stringify(mid)}`);
t("中间页折叠成两段 …", mid.filter((x) => x === "…").length === 2);
t("含 1 与 40", mid[0] === 1 && mid[mid.length - 1] === 40);
t("含当前页 10", mid.includes(10));
const first = pageNumbers(1, 40);
console.log(`  page=1 total=40 → ${JSON.stringify(first)}`);
t("第 1 页时无前导 …", first[0] === 1 && first[1] !== "…");
const last = pageNumbers(40, 40);
console.log(`  page=40 total=40 → ${JSON.stringify(last)}`);
t("末页时无后置 …", last[last.length - 1] === 40 && last[last.length - 2] !== "…");

console.log("\n=== 3) pageNumbers：越界保护 ===");
t("page=0 → 归一到 1", pageNumbers(0, 10).includes(1));
t("page=999 → 不崩", Array.isArray(pageNumbers(999, 10)));
t("total=0 → 不崩且返回 [1]", JSON.stringify(pageNumbers(1, 0)) === "[1]");
t("page=undefined → 不崩", Array.isArray(pageNumbers(undefined, 10)));

console.log("\n=== 4) PROMPT_FIELDS：覆盖用户要看的提示词字段 ===");
const keys = PROMPT_FIELDS.map(([k]) => k);
console.log(`  ${keys.join(", ")}`);
for (const need of ["personality", "systemPrompt", "firstMessage", "exampleDialogs", "postHistoryInstructions", "alternateGreetings", "lorebook", "scenario", "description"]) {
	t(`含 ${need}`, keys.includes(need));
}

console.log("\n=== 5) promptFieldText：原文取用（占位符必须原样保留）===");
const data = {
	prompt: {
		personality: "{{char}}是{{user}}的姐姐。",
		firstMessage: "「{{user}}，你回来了。」",
		alternateGreetings: ["第一条 {{char}}", "第二条 {{user}}"],
		lorebook: { 设定: "修仙世界" },
		systemPrompt: "",
	},
};
t("personality 原样含 {{char}}", promptFieldText(data, "personality").includes("{{char}}"));
t("firstMessage 原样含 {{user}}", promptFieldText(data, "firstMessage").includes("{{user}}"));
const alts = promptFieldText(data, "alternateGreetings");
t("数组字段逐条编号", alts.includes("#1") && alts.includes("#2"));
t("数组内占位符原样", alts.includes("{{char}}") && alts.includes("{{user}}"));
t("空字符串字段返回空", promptFieldText(data, "systemPrompt") === "");
t("对象字段转 JSON", promptFieldText(data, "lorebook").includes("修仙世界"));
t("data 为 null → 空串", promptFieldText(null, "personality") === "");
t("data 无 prompt → 空串", promptFieldText({}, "personality") === "");
t("未知字段 → 空串", promptFieldText(data, "nonexistent") === "");

console.log("\n=== 6) 源码级确认：详情浮层走 HTTP，不经过宿主插值 ===");
t("client 用 /detail 路由取数", src.includes('apiGet(`/detail?fullPath='));
t("右键绑定 onContextMenu", src.includes("onContextMenu"));
t("右键里 preventDefault（阻止浏览器菜单）", src.includes("e.preventDefault()"));
// 阈值放宽到 20000：中间代码长度会随功能增长而变（加「注入原文」视图后
// 从 ~3.9k 涨到 ~5k），不该让布局改动把这条「是否 portal」的断言弄红。
// 判据本身是「detailOverlay 定义之后存在 ReactDOM.createPortal 且最终挂到 document.body」。
t("详情浮层 portal 到 document.body", /detailOverlay[\s\S]{0,20000}document\.body/.test(src));
t("详情浮层确实走 createPortal", /detailOverlay[\s\S]{0,2000}ReactDOM\.createPortal/.test(src));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
