/**
 * 角色卡召唤状态：每个会话一个「当前召唤」的卡。
 *
 * 落盘在插件自持目录（~/.dsh/card-summon/），与宿主版本无关，改完立即生效 ——
 * 与 dsh-workbuddy-summon / dsh-switch-armor 同款做法（自持状态，不动 profile）。
 *
 * 目录布局：
 *   summons.json      会话 id → 召唤记录（含卡快照，便于重启后离线复活）
 *   sections/<id>.md  预渲染好的注入段（重启时直接读回内存，不必回网重算）
 *   cards/<id>.json   卡原文（供 card_read 取回被截断的部分）
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * 状态根目录。独立常量模块式写法，避免 lib 之间互引造成 ESM 循环。
 *
 * `DSH_CARD_SUMMON_STATE` 可覆盖。存在的理由不是"可配置"，而是**测试隔离**：
 * 测试必须写在临时目录里 —— 否则跑一次测试就把用户真实的 summons.json /
 * vars.json / cards 覆盖掉了，那是不可逆的。
 */
export const STATE_ROOT = process.env.DSH_CARD_SUMMON_STATE?.trim() || join(homedir(), ".dsh/card-summon");

const STORE = join(STATE_ROOT, "summons.json");
const SECTIONS_DIR = join(STATE_ROOT, "sections");
const CARDS_DIR = join(STATE_ROOT, "cards");

/** 召唤状态文件最多保留多少个会话（超出丢最老的）。 */
export const MAX_SUMMON_SESSIONS = 200;

/** @type {Map<string, object>} */
const summons = new Map();
let loaded = false;
/** 订阅者：状态变化时通知（UI 轮询之外的即时刷新）。 */
const listeners = new Set();

const isScalar = (v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";

/** 会话 id → 文件名安全串。 */
export function safeId(sessionId) {
	return String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_");
}

function sectionFile(sessionId) {
	return join(SECTIONS_DIR, `${safeId(sessionId)}.md`);
}
function cardFile(sessionId) {
	return join(CARDS_DIR, `${safeId(sessionId)}.json`);
}

/** 规范化一条召唤记录：固定字段 + 透传其它标量元数据。 */
function normalize(record) {
	const next = {
		fullPath: String(record.fullPath ?? ""),
		name: String(record.name ?? ""),
	};
	for (const [k, v] of Object.entries(record)) {
		if (k in next || k === "at") continue;
		if (isScalar(v)) next[k] = v;
	}
	next.at = new Date().toISOString();
	return next;
}

function readStore() {
	try {
		const parsed = JSON.parse(readFileSync(STORE, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const out = {};
		for (const [sessionId, value] of Object.entries(parsed)) {
			if (typeof sessionId !== "string" || sessionId.length === 0) continue;
			if (value === null || typeof value !== "object") continue;
			if (typeof value.fullPath !== "string" || value.fullPath.length === 0) continue;
			const next = normalize(value);
			// 保留原时间戳，别让每次读盘都把「最后召唤时间」推后
			if (typeof value.at === "string") next.at = value.at;
			out[sessionId] = next;
		}
		return out;
	} catch {
		return {};
	}
}

function ensureLoaded() {
	if (loaded) return;
	loaded = true;
	for (const [k, v] of Object.entries(readStore())) summons.set(k, v);
}

function persist() {
	try {
		mkdirSync(STATE_ROOT, { recursive: true });
		writeFileSync(STORE, JSON.stringify(Object.fromEntries(summons), null, 1));
		return true;
	} catch (error) {
		console.warn(`[dsh-card-summon] 状态落盘失败：${error?.message ?? error}`);
		return false;
	}
}

function emit(event) {
	for (const fn of listeners) {
		try {
			fn(event);
		} catch {
			/* 订阅者异常不影响状态本身 */
		}
	}
}

/** 从 assemble context / agent 里取会话 id（与 workbuddy-summon 同一套兜底顺序）。 */
export function sessionIdOf(context) {
	try {
		const agent = context?.agent ?? context;
		const id = agent?.sessionId ?? agent?.session?.header?.id ?? agent?.id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** @returns {object | undefined} */
export function getSummon(sessionId) {
	ensureLoaded();
	if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
	return summons.get(sessionId);
}

export function setSummon(sessionId, record) {
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw new Error("card_summon: 缺少 sessionId（请从具体会话里召唤）");
	}
	if (typeof record?.fullPath !== "string" || record.fullPath.length === 0) {
		throw new Error("card_summon: 缺少 fullPath");
	}
	ensureLoaded();
	const prev = summons.get(sessionId);
	const next = normalize(record);
	summons.set(sessionId, next);
	persist();
	emit({ type: "summoned", sessionId, from: prev, to: next });
	return next;
}

export function clearSummon(sessionId) {
	ensureLoaded();
	const prev = summons.get(sessionId);
	if (prev === undefined) return false;
	summons.delete(sessionId);
	persist();
	try {
		rmSync(sectionFile(sessionId), { force: true });
		rmSync(cardFile(sessionId), { force: true });
	} catch {
		/* 文件可能本就不存在 */
	}
	emit({ type: "unsummoned", sessionId, from: prev });
	return true;
}

/** 全量快照（给 UI 与工具用）。 */
export function listSummons() {
	ensureLoaded();
	return Object.fromEntries(summons);
}

export function onSummonChange(fn) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** 清理已经不存在的会话条目（避免文件无限增长）。 */
export function pruneSummons(liveIds) {
	ensureLoaded();
	if (!(liveIds instanceof Set)) return 0;
	let removed = 0;
	for (const id of [...summons.keys()]) {
		if (!liveIds.has(id)) {
			summons.delete(id);
			removed += 1;
		}
	}
	if (removed > 0) persist();
	return removed;
}

/* ─────────────────── 注入段缓存（重启复活用） ─────────────────── */

export function writeSectionFile(sessionId, text) {
	mkdirSync(SECTIONS_DIR, { recursive: true });
	writeFileSync(sectionFile(sessionId), text);
}

export function loadSectionFromDisk(sessionId) {
	try {
		const text = readFileSync(sectionFile(sessionId), "utf8");
		return text.length > 0 ? text : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 回收段落盘上的孤儿文件：0 字节的历史遗留 + 已无召唤记录的会话。
 * 必须在 pruneSummons 之后调用，否则刚裁掉的会话文件当轮漏删。
 */
export function sweepSectionFiles() {
	let removed = 0;
	let names;
	try {
		names = readdirSync(SECTIONS_DIR);
	} catch {
		return 0;
	}
	ensureLoaded();
	const live = new Set([...summons.keys()].map(safeId));
	for (const name of names) {
		const full = join(SECTIONS_DIR, name);
		let size = 0;
		try {
			size = statSync(full).size;
		} catch {
			continue;
		}
		const stem = name.replace(/\.md$/, "");
		if (size === 0 || !live.has(stem)) {
			try {
				rmSync(full, { force: true });
				removed += 1;
			} catch {
				/* 忽略 */
			}
		}
	}
	// 卡缓存按同一套 live 集合清理
	try {
		for (const name of readdirSync(CARDS_DIR)) {
			const stem = name.replace(/\.json$/, "");
			if (!live.has(stem)) {
				rmSync(join(CARDS_DIR, name), { force: true });
				removed += 1;
			}
		}
	} catch {
		/* 目录可能还没有 */
	}
	return removed;
}

/* ─────────────────── 卡原文缓存（card_read 用） ─────────────────── */

export function writeCardFile(sessionId, card) {
	mkdirSync(CARDS_DIR, { recursive: true });
	writeFileSync(cardFile(sessionId), JSON.stringify(card, null, 1));
}

export function loadCardFile(sessionId) {
	try {
		return JSON.parse(readFileSync(cardFile(sessionId), "utf8"));
	} catch {
		return undefined;
	}
}
