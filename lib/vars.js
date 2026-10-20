/**
 * 模板宏（Tavern 风格 `{{...}}`）与变量表。
 *
 * 目标：让从酒馆搬来的卡能用 —— 卡里写着 `{{user}}`、`{{char}}`、`{{角色名}}` 的地方，
 * 注入前替换成实际值；作者自定义的变量由用户填一次，之后每次召唤都生效。
 *
 * ── 宏分类三分（唯一真源 = 本文件）──
 *   A. substituted：本插件能真正求值 → user / char / original
 *   B. known      ：酒馆标准宏（含 STscript 脚本宏），本插件**未实现** →
 *                   原样保留、**不计入 missing**、UI 单列「未实现内置」。
 *                   这类宏被算进「待填变量」会让用户以为自己漏填了东西。
 *   C. custom     ：其余全部（中文提示词、错字、作者自定义变量）→
 *                   原样保留 + 计入 missing，面板标黄提示「待填」。
 *
 * ⚠️ extractMacros / applyMacros / 面板三处都必须走 classifyMacro()，
 *    禁止在别处复制宏名单 —— 否则同一个名字可能一处被替换、一处又被记成 missing。
 *
 * ── 实测口径（本地 300 张中文卡，2026-10-16 扫）──
 *   86% 的卡含宏，总出现 27123 次：`{{user}}` 24849、`{{char}}` 941、`{{User}}` 306、
 *   `roll 1d6` 27、`setvar::…`/`format_message_variable::…` 若干、中文变量 `数字`/`角色名`/`地点` 等。
 *   由此定下三条匹配口径：
 *     1) **大小写不敏感**（真实卡里同时存在 user / User）；
 *     2) **空白变体容忍**（`{{ user }}` 按 trim 后匹配；`{{roll 1d6}}` 用空格而非冒号）；
 *     3) **不做转义语法**：只有成对 `{{…}}` 才算宏（酒馆本身也没有正式转义），
 *        宏名上限 64 字符且不含换行/花括号，避免把正文里的 `{{` 误吞。
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./state.js";

const VARS_FILE = join(STATE_ROOT, "vars.json");
const VARS_VERSION = 1;

/** 单个变量值的字符上限（防手滑把整篇设定粘进来撑爆注入段）。 */
export const MAX_VALUE_CHARS = 4_000;
/** 单张卡的自定义变量条数上限。 */
export const MAX_CUSTOM_VARS = 400;

/** `{{user}}` 没配时的默认值。 */
export const DEFAULT_USER_NAME = "你";
/** `{{char}}` 没配、卡又没名字时的兜底。 */
export const DEFAULT_CHAR_NAME = "角色";

/* ─────────────────────── 分类 ─────────────────────── */

/** A 类：能真求值的宏（canonical 名 → 取值方式）。 */
export const SUBSTITUTED = new Set(["user", "char", "original"]);

/**
 * B 类：酒馆标准宏 —— 认得出、但不假装能算。
 * 名单来源：SillyTavern 宏表 + STscript 常用指令（后者的名字在实测卡里出现过
 * `setvar` / `get_message_variable` / `format_message_variable` / `if` / `else` / `end`）。
 */
export const KNOWN = new Set([
	// 时间 / 会话
	"time", "date", "weekday", "isotime", "isodate", "datetimeformat", "idleduration", "input", "chat",
	// 卡字段自引用
	"description", "personality", "scenario", "persona", "charprompt", "charjailbreak",
	"mesexamples", "examplemessage", "lastexamples", "lastmessage", "lastmessagename",
	"lastusermessage", "summary", "charname", "username",
	// 系统提示拼装
	"mainprompt", "jailbreak", "model", "maxprompt", "newline", "space", "noop", "blank", "trim",
	// 随机 / 骰子
	"random", "pick", "roll",
	// STscript / 常见扩展
	"setvar", "getvar", "addvar", "incvar", "decvar", "delvar", "deletevar",
	"setglobalvar", "getglobalvar", "addglobalvar", "incglobalvar", "decglobalvar", "delglobalvar",
	"set_message_variable", "get_message_variable", "format_message_variable",
	"if", "else", "end", "while", "for", "break", "continue", "return", "assert", "flushvar", "flushglobalvar",
]);

/** 宏匹配：成对花括号，名字 1–64 字符，不含花括号与换行。 */
export const MACRO_RE = /\{\{([^{}\n]{1,64})\}\}/g;

/**
 * 归类一个宏名。
 * @param {string} name `{{ }}` 里的原文（未 trim 也可以）
 * @returns {{kind: "substituted"|"known"|"custom"|"unknown", canonical: string, key: string, head: string}}
 *   head  = 首段小写（`roll 1d6` → `roll`），用于查内置名单；
 *   key   = 全名小写（`My Var` → `my var`），用作自定义变量的存取键；
 *   canonical 用于 substituted 取内置值（`User` → `user`）。
 */
export function classifyMacro(name) {
	const raw = String(name ?? "").trim();
	if (raw.length === 0) return { kind: "unknown", canonical: "", key: "", head: "" };
	const head = (raw.split(/::|\s+|:/)[0] ?? "").trim().toLowerCase();
	const key = raw.toLowerCase();
	if (SUBSTITUTED.has(head)) return { kind: "substituted", canonical: head, key, head };
	if (KNOWN.has(head)) return { kind: "known", canonical: head, key, head };
	return { kind: "custom", canonical: key, key, head };
}

/**
 * 提取文本里出现的宏（按 key 去重计数）。
 * @param {string} text
 * @returns {Map<string, {name: string, count: number, kind: string}>}
 */
export function extractMacros(text) {
	/** @type {Map<string, {name: string, count: number, kind: string}>} */
	const out = new Map();
	if (typeof text !== "string" || !text.includes("{{")) return out;
	for (const m of text.matchAll(MACRO_RE)) {
		const name = m[1].trim();
		if (name.length === 0) continue;
		const info = classifyMacro(name);
		if (info.kind === "unknown") continue;
		const cur = out.get(info.key);
		if (cur !== undefined) cur.count += 1;
		else out.set(info.key, { name, count: 1, kind: info.kind });
	}
	return out;
}

/* ─────────────────────── 替换 ─────────────────────── */
function bump(map, name, extra) {
	const cur = map.get(name);
	if (cur !== undefined) cur.count += 1;
	else map.set(name, { name, count: 1, ...extra });
}

function preview(value) {
	const flat = String(value).replace(/\s+/g, " ").trim();
	return flat.length > 60 ? `${flat.slice(0, 60)}…` : flat;
}

function emptyReport() {
	return { replaced: [], missing: [], known: [], hits: 0 };
}

/**
 * 替换文本里的宏。
 *
 * - A 类有值就替换；`{{original}}` 恒为空串（本地卡没有「原始卡」概念，
 *   酒馆里它指「卡被替换前的原文」，我们按空串处理并在此说明）。
 * - B 类原样保留，只记进 known。
 * - C 类有值就替换，没值**原样保留**（别删 —— 删了用户看不出这里缺东西）并记进 missing。
 *
 * @param {string} text
 * @param {{vars?: Record<string, string>, userName?: string, charName?: string}} [ctx]
 * @returns {{text: string, replaced: Array<object>, missing: Array<object>, known: Array<object>, hits: number}}
 */
export function applyMacros(text, ctx = {}) {
	if (typeof text !== "string" || !text.includes("{{")) return { text, ...emptyReport() };
	const vars = ctx.vars ?? {};
	const userName = str(ctx.userName) || DEFAULT_USER_NAME;
	const charName = str(ctx.charName);
	const replaced = new Map();
	const missing = new Map();
	const known = new Map();
	let hits = 0;

	const out = text.replace(MACRO_RE, (whole, rawName) => {
		const name = String(rawName).trim();
		if (name.length === 0) return whole;
		const info = classifyMacro(name);
		if (info.kind === "unknown") return whole;
		hits += 1;

		if (info.kind === "known") {
			bump(known, name, { canonical: info.canonical });
			return whole;
		}

		if (info.kind === "substituted") {
			let value = "";
			if (info.canonical === "user") value = str(vars.user) || userName;
			else if (info.canonical === "char") value = str(vars.char) || charName || DEFAULT_CHAR_NAME;
			// original → 空串
			bump(replaced, name, { value: preview(value), chars: value.length });
			return value;
		}

		const value = str(vars[info.key]);
		if (value.length > 0) {
			bump(replaced, name, { value: preview(value), chars: value.length });
			return value;
		}
		bump(missing, name, {});
		return whole;
	});

	return {
		text: out,
		replaced: [...replaced.values()],
		missing: [...missing.values()],
		known: [...known.values()],
		hits,
	};
}

const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

/** 会被替换的卡字段（与 normalizeCard 的注入面一致）。 */
const CARD_TEXT_FIELDS = [
	"name",
	"personality",
	"personaDerived",
	"scenario",
	"firstMessage",
	"exampleDialogs",
	"systemPrompt",
	"postHistoryInstructions",
	"mesExample",
];

/**
 * 卡的「注入面」文本。
 *
 * ⚠️ 替换面与提取面必须共用这一份来源：否则会出现最尴尬的状态 ——
 *    面板说「这卡没有待填变量」，注入段里却还躺着一个 `{{xxx}}`（或反之）。
 *    `personaDerivedDropped[].label` 就是这么被抓出来的：它是世界书条目的 comment，
 *    会被注入段用来列「哪些常驻设定没纳入」，一开始没算进注入面（4/178 张卡命中）。
 */
function cardTextOf(card) {
	if (card === null || card === undefined || typeof card !== "object") return "";
	const parts = [];
	for (const field of CARD_TEXT_FIELDS) {
		if (typeof card[field] === "string") parts.push(card[field]);
	}
	if (Array.isArray(card.alternateGreetings)) {
		for (const g of card.alternateGreetings) if (typeof g === "string") parts.push(g);
	}
	const entries = card.lorebook?.entries;
	if (Array.isArray(entries)) {
		for (const en of entries) {
			if (en !== null && typeof en === "object" && typeof en.content === "string") parts.push(en.content);
		}
	}
	if (Array.isArray(card.personaDerivedDropped)) {
		for (const d of card.personaDerivedDropped) {
			if (d !== null && typeof d === "object" && typeof d.label === "string") parts.push(d.label);
		}
	}
	return parts.join("\n");
}

/**
 * 扫一张卡，把宏按三分类分桶 —— 面板「变量」页与 `/vars` 路由用。
 *
 * 与 `applyMacros` 的分工：那个是**替换**（报告发生了什么），这个是**盘点**
 * （告诉用户这卡一共要几个变量、哪些已填、哪些还空着）。
 *
 * @param {object} card
 * @param {Record<string, string>} [vars] 已解析的变量表（不传按卡现算）
 * @returns {{builtin: Array, known: Array, custom: Array, missing: string[], total: number}}
 *   custom 每项带 value / filled，面板据此渲染输入框与标黄。
 */
export function extractFromCard(card, vars) {
	const table = vars ?? resolveVarsFor(card);
	const found = extractMacros(cardTextOf(card));
	const builtin = [];
	const known = [];
	const custom = [];
	const missing = [];
	let total = 0;
	for (const [key, item] of found) {
		total += item.count;
		const row = { name: item.name, count: item.count, kind: item.kind, key };
		if (item.kind === "substituted") {
			builtin.push(row);
			continue;
		}
		if (item.kind === "known") {
			known.push(row);
			continue;
		}
		const value = str(table[key]);
		custom.push({ ...row, value, filled: value.length > 0 });
		if (value.length === 0) missing.push(item.name);
	}
	const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
	return {
		builtin: builtin.sort(byCount),
		known: known.sort(byCount),
		custom: custom.sort(byCount),
		missing,
		total,
	};
}

function mergeReport(into, one) {
	for (const k of ["replaced", "missing", "known"]) {
		for (const item of one[k]) {
			const found = into[k].find((x) => x.name === item.name);
			if (found !== undefined) {
				found.count += item.count;
				if (found.chars === undefined && item.chars !== undefined) found.chars = item.chars;
			} else into[k].push({ ...item });
		}
	}
	into.hits += one.hits;
	return into;
}

/**
 * 对整张卡做宏替换，返回**浅拷贝**（绝不动传入的对象）。
 *
 * 为什么要拷贝：调用方随后会把卡原文落盘（`writeCardFile`，供 card_read 取回）与
 * 渲染详情面板 —— 那些出口要的是**卡原文**，替换过的文本只该出现在注入段里。
 *
 * ⚠️ 顺序要求：本函数必须在 `clip()` **之前**调用。预算按替换后的长度判定，
 *    否则长用户名/长卡名会突破 BUDGET（这是与方案原文对齐的硬约束）。
 *
 * @param {object} card
 * @param {{vars?: Record<string,string>, userName?: string, charName?: string}} [ctx]
 * @returns {{card: object, report: object}}
 */
export function applyMacrosToCard(card, ctx = {}) {
	if (card === null || card === undefined || typeof card !== "object") {
		return { card, report: emptyReport() };
	}
	const report = emptyReport();
	const next = { ...card };
	const local = { ...ctx, charName: str(ctx.charName) || str(card.name) };

	for (const field of CARD_TEXT_FIELDS) {
		if (typeof card[field] !== "string" || !card[field].includes("{{")) continue;
		const one = applyMacros(card[field], local);
		next[field] = one.text;
		mergeReport(report, one);
	}

	if (Array.isArray(card.alternateGreetings)) {
		next.alternateGreetings = card.alternateGreetings.map((g) => {
			if (typeof g !== "string" || !g.includes("{{")) return g;
			const one = applyMacros(g, local);
			mergeReport(report, one);
			return one.text;
		});
	}

	// 世界书条目：正文默认不注入（只有被选为常驻条目时注入），P2（关键词触发）会用到，一并替换。
	//
	// `comment` 也换 —— 它是条目的显示名，唯一的注入出口是 personaDerivedDropped[].label。
	// 但那就意味着「comment 进不进注入段」取决于预算裁剪的结果：同一条目今天被裁掉、
	// 明天放进去了，替换与否就分叉了。与其把正确性押在下游，不如在源头换干净。
	// （这条是 tests/vars-check.mjs 用**独立**字段清单扫出来的，不是想出来的。）
	const entries = card.lorebook?.entries;
	if (Array.isArray(entries)) {
		next.lorebook = {
			...card.lorebook,
			entries: entries.map((en) => {
				if (en === null || typeof en !== "object") return en;
				let changed = false;
				const out = { ...en };
				for (const field of ["content", "comment"]) {
					if (typeof en[field] !== "string" || !en[field].includes("{{")) continue;
					const one = applyMacros(en[field], local);
					mergeReport(report, one);
					out[field] = one.text;
					changed = true;
				}
				return changed ? out : en;
			}),
		};
	}

	// 因预算整条未纳入的常驻条目：注入段会用它的 label（世界书条目的 comment）列一份名单，
	// 所以 label **也是注入面**。实测这里会漏：`{{user}}-瘦帅版` / `{{user}}的住所` 这类
	// 作者写法（4/178 张卡命中）会带着花括号进模型上下文 —— 替换面不能只认"正文类字段"。
	if (Array.isArray(card.personaDerivedDropped)) {
		next.personaDerivedDropped = card.personaDerivedDropped.map((d) => {
			if (d === null || typeof d !== "object" || typeof d.label !== "string") return d;
			if (!d.label.includes("{{")) return d;
			const one = applyMacros(d.label, local);
			mergeReport(report, one);
			return { ...d, label: one.text };
		});
	}

	return { card: next, report };
}

/* ─────────────────────── 变量表 IO ─────────────────────── */

export function varsPath() {
	return VARS_FILE;
}

function emptyVars() {
	return { version: VARS_VERSION, global: { user: "", char: "" }, cards: {} };
}

function clipValue(v) {
	return String(v).slice(0, MAX_VALUE_CHARS);
}

function readVarsFile() {
	const base = emptyVars();
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(VARS_FILE, "utf8"));
	} catch {
		return base;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return base;

	const global = parsed.global;
	if (global !== null && typeof global === "object" && !Array.isArray(global)) {
		for (const [k, v] of Object.entries(global)) {
			if (typeof v === "string" && v.length > 0) base.global[k] = clipValue(v);
		}
	}

	const cards = parsed.cards;
	if (cards !== null && typeof cards === "object" && !Array.isArray(cards)) {
		for (const [fp, table] of Object.entries(cards)) {
			if (table === null || typeof table !== "object" || Array.isArray(table)) continue;
			const clean = {};
			let n = 0;
			for (const [k, v] of Object.entries(table)) {
				if (typeof v !== "string" || v.length === 0) continue;
				if (n >= MAX_CUSTOM_VARS) break;
				clean[k] = clipValue(v);
				n += 1;
			}
			if (n > 0) base.cards[fp] = clean;
		}
	}
	return base;
}

/**
 * 原子落盘：先写同目录临时文件再 rename。
 * 非原子写（直接 writeFileSync 到目标）在「HTTP 数据面 + 多会话同时改变量」下
 * 会静默丢用户手写数据 —— 这是本文件唯一不可逆的地方，必须走 rename。
 */
function writeVarsFile(next) {
	mkdirSync(STATE_ROOT, { recursive: true });
	const tmp = `${VARS_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 1));
	renameSync(tmp, VARS_FILE);
	cache = next;
}

/** @type {object|null} */
let cache = null;

/** 同步读（注入路径用）：内存缓存，写入后自动更新。 */
export function loadVars() {
	if (cache === null) cache = readVarsFile();
	return cache;
}

/** 强制下次 loadVars() 重读磁盘。 */
export function invalidateVarsCache() {
	cache = null;
}

/** 读-改-写串行链：并发调用按到达顺序排队，避免 last-write-wins 吞数据。 */
let chain = Promise.resolve();

/**
 * 串行化的读-改-写。
 * @param {(vars: object) => object|Promise<object>} mutator 收到深拷贝，返回新的表（返回空则用改后的入参）
 * @returns {Promise<object>} 落盘后的完整表
 */
export function updateVars(mutator) {
	const run = chain.then(async () => {
		const cur = readVarsFile();
		const draft = structuredClone(cur);
		const next = (await mutator(draft)) ?? draft;
		writeVarsFile(next);
		return next;
	});
	// 失败也不能断链，否则后续所有写入都会被卡住
	chain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * 解析一张卡的有效变量表：卡级 > 全局 > 调用方默认值。
 * @param {object|null} card
 * @param {{userName?: string, charName?: string}} [fallback]
 */
export function resolveVarsFor(card, fallback = {}) {
	const table = loadVars();
	const fp = typeof card?.fullPath === "string" ? card.fullPath : "";
	const perCard = fp.length > 0 ? (table.cards[fp] ?? {}) : {};
	const global = table.global ?? {};
	const vars = { ...perCard };
	for (const [k, v] of Object.entries(global)) {
		if (k === "user" || k === "char") continue;
		if (!(k in vars)) vars[k] = v;
	}
	vars.user = str(perCard.user) || str(global.user) || str(fallback.userName) || DEFAULT_USER_NAME;
	vars.char = str(perCard.char) || str(global.char) || str(fallback.charName) || str(card?.name);
	return vars;
}

/**
 * 设置变量。
 * @param {{scope: "global"|"card", fullPath?: string, name: string, value: string}} input
 *   value 传空串 = 删除该变量（回到「待填」状态）
 */
export function setVar(input) {
	const name = String(input.name ?? "").trim();
	if (name.length === 0) throw new Error("变量名不能为空");
	const key = name.toLowerCase();
	const value = str(input.value);
	return updateVars((vars) => {
		const scope = input.scope === "global" ? "global" : "card";
		if (scope === "global") {
			if (value.length === 0) delete vars.global[key];
			else vars.global[key] = clipValue(value);
			return vars;
		}
		const fp = String(input.fullPath ?? "");
		if (fp.length === 0) throw new Error("卡级变量必须给 fullPath");
		const table = vars.cards[fp] ?? {};
		if (value.length === 0) delete table[key];
		else table[key] = clipValue(value);
		if (Object.keys(table).length > 0) vars.cards[fp] = table;
		else delete vars.cards[fp];
		return vars;
	});
}

/** 清空一张卡的全部自定义变量（不动 global）。 */
export function clearCardVars(fullPath) {
	const fp = String(fullPath ?? "");
	return updateVars((vars) => {
		if (fp.length > 0) delete vars.cards[fp];
		return vars;
	});
}
