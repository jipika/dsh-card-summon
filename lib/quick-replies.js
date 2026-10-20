/**
 * Quick Reply（快捷按钮）数据层。
 *
 * 盘上文件：~/.dsh/card-summon/quick-replies.json
 *   { version: 1, items: [{id,label,text}], perCard: { "<fullPath>": [{id,label,text}] } }
 *
 * 与 vars.js 同一套纪律：
 *   · 同步读 + 内存缓存（注入/列表路径零 await）
 *   · 写走「读-改-写串行链」，并发调用按到达顺序排队，不会 last-write-wins 吞数据
 *   · 落盘走「临时文件 + rename」原子替换 —— 本文件是用户手写的按钮，丢了不可逆
 *
 * 与 vars.js 的分工：这里只存「按钮是什么」，不碰「按钮怎么投递」。
 * 投递在 index.js 的路由里做（那需要宿主服务，不能进数据层）。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { STATE_ROOT } from "./state.js";

const QR_FILE = join(STATE_ROOT, "quick-replies.json");
const QR_VERSION = 1;

/** 每个作用域（全局 / 单卡）的按钮数上限：防手滑灌爆输入框上方那一行。 */
export const MAX_QR_PER_SCOPE = 20;
/** 按钮标签字符上限（chips 要横着排一排，太长会把输入框挤爆）。 */
export const MAX_QR_LABEL = 24;
/** 按钮正文上限。 */
export const MAX_QR_TEXT = 2_000;
/** 标签留空时，从正文自动截取多少个字符当标签。 */
const AUTO_LABEL_CHARS = 12;

export function qrPath() {
	return QR_FILE;
}

const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

function emptyTable() {
	return { version: QR_VERSION, items: [], perCard: {} };
}

function clipLabel(v) {
	return str(v).replace(/\s+/g, " ").trim().slice(0, MAX_QR_LABEL);
}

function clipText(v) {
	return str(v).trim().slice(0, MAX_QR_TEXT);
}

/** 正文没有标签时，用它前面一段当标签，免得 chips 上出现一排空白。 */
function autoLabel(text) {
	const one = text.replace(/\s+/g, " ").trim();
	return one.length <= AUTO_LABEL_CHARS ? one : `${one.slice(0, AUTO_LABEL_CHARS)}…`;
}

function normalizeItem(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const text = clipText(raw.text);
	if (text.length === 0) return null;
	const id = str(raw.id).trim() || `qr_${randomUUID().slice(0, 8)}`;
	const label = clipLabel(raw.label) || autoLabel(text);
	return { id, label, text };
}

function readQrFile() {
	const base = emptyTable();
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(QR_FILE, "utf8"));
	} catch {
		return base;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return base;

	if (Array.isArray(parsed.items)) {
		for (const raw of parsed.items) {
			if (base.items.length >= MAX_QR_PER_SCOPE) break;
			const item = normalizeItem(raw);
			if (item !== null) base.items.push(item);
		}
	}

	const perCard = parsed.perCard;
	if (perCard !== null && typeof perCard === "object" && !Array.isArray(perCard)) {
		for (const [fp, list] of Object.entries(perCard)) {
			if (fp.length === 0 || !Array.isArray(list)) continue;
			const clean = [];
			for (const raw of list) {
				if (clean.length >= MAX_QR_PER_SCOPE) break;
				const item = normalizeItem(raw);
				if (item !== null) clean.push(item);
			}
			if (clean.length > 0) base.perCard[fp] = clean;
		}
	}
	return base;
}

/** 原子落盘（理由同 vars.js 的 writeVarsFile）。 */
function writeQrFile(next) {
	mkdirSync(STATE_ROOT, { recursive: true });
	const tmp = `${QR_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 1));
	renameSync(tmp, QR_FILE);
	cache = next;
}

/** @type {object|null} */
let cache = null;

export function loadQuickReplies() {
	if (cache === null) cache = readQrFile();
	return cache;
}

export function invalidateQrCache() {
	cache = null;
}

let chain = Promise.resolve();

/** 串行化的读-改-写（理由同 vars.js 的 updateVars）。 */
export function updateQuickReplies(mutator) {
	const run = chain.then(async () => {
		const cur = readQrFile();
		const draft = structuredClone(cur);
		const next = (await mutator(draft)) ?? draft;
		writeQrFile(next);
		return next;
	});
	chain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * 取一张卡可见的按钮：全局 + 该卡专属。
 * @param {string} [fullPath]
 * @returns {{global: object[], card: object[], max: number}}
 */
export function resolveQuickReplies(fullPath) {
	const table = loadQuickReplies();
	const fp = str(fullPath);
	const card = fp.length > 0 ? (table.perCard[fp] ?? []) : [];
	return { global: table.items, card, max: MAX_QR_PER_SCOPE };
}

/** 定位一个作用域的按钮数组（写路径用）。 */
function bucketOf(draft, scope, fullPath) {
	if (scope === "global") return { list: draft.items, commit: () => {} };
	const fp = str(fullPath);
	if (fp.length === 0) throw new Error("卡级按钮必须给 fullPath");
	if (!Array.isArray(draft.perCard[fp])) draft.perCard[fp] = [];
	return {
		list: draft.perCard[fp],
		commit: () => {
			// 空数组不留栈：删光了就把这个 fullPath 摘掉，免得盘上堆一片空表
			if (draft.perCard[fp].length === 0) delete draft.perCard[fp];
		},
	};
}

/**
 * 新增按钮。
 * @param {{scope: "global"|"card", fullPath?: string, label?: string, text: string}} input
 * @returns {Promise<{id: string, item: object}>}
 */
export function addQuickReply(input) {
	const text = clipText(input?.text);
	if (text.length === 0) throw new Error("按钮正文不能为空");
	const label = clipLabel(input?.label) || autoLabel(text);
	const scope = input?.scope === "global" ? "global" : "card";
	const item = { id: `qr_${randomUUID().slice(0, 8)}`, label, text };
	return updateQuickReplies((draft) => {
		const { list, commit } = bucketOf(draft, scope, input?.fullPath);
		if (list.length >= MAX_QR_PER_SCOPE) {
			throw new Error(`每个${scope === "global" ? "全局" : "卡"}作用域最多 ${MAX_QR_PER_SCOPE} 个按钮`);
		}
		list.push(item);
		commit();
		return draft;
	}).then(() => ({ id: item.id, item }));
}

/**
 * 改按钮（label / text 至少给一个；text 传空串 = 不改，删请用 removeQuickReply）。
 * @returns {Promise<{id: string, item: object}>}
 */
export function updateQuickReply(input) {
	const id = str(input?.id).trim();
	if (id.length === 0) throw new Error("必须给按钮 id");
	const scope = input?.scope === "global" ? "global" : "card";
	const nextLabel = clipLabel(input?.label);
	const rawText = str(input?.text);
	const nextText = rawText.length > 0 ? clipText(rawText) : "";
	if (nextLabel.length === 0 && nextText.length === 0) throw new Error("至少给 label 或 text");

	let updated = null;
	return updateQuickReplies((draft) => {
		const { list, commit } = bucketOf(draft, scope, input?.fullPath);
		const at = list.findIndex((it) => it?.id === id);
		if (at < 0) throw new Error("找不到该按钮（可能已被删除）");
		const cur = list[at];
		const item = {
			id,
			label: nextLabel.length > 0 ? nextLabel : cur.label,
			text: nextText.length > 0 ? nextText : cur.text,
		};
		list[at] = item;
		updated = item;
		commit();
		return draft;
	}).then(() => ({ id, item: updated }));
}

/**
 * 删按钮。
 * @returns {Promise<{id: string, removed: boolean}>}
 */
export function removeQuickReply(input) {
	const id = str(input?.id).trim();
	if (id.length === 0) throw new Error("必须给按钮 id");
	const scope = input?.scope === "global" ? "global" : "card";
	let removed = false;
	return updateQuickReplies((draft) => {
		const { list, commit } = bucketOf(draft, scope, input?.fullPath);
		const at = list.findIndex((it) => it?.id === id);
		if (at >= 0) {
			list.splice(at, 1);
			removed = true;
		}
		commit();
		return draft;
	}).then(() => ({ id, removed }));
}

/** 清空一张卡的全部专属按钮（不动 global）。 */
export function clearCardQuickReplies(fullPath) {
	const fp = str(fullPath);
	return updateQuickReplies((draft) => {
		if (fp.length > 0) delete draft.perCard[fp];
		return draft;
	});
}
