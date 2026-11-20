/**
 * 运行时开关（面板可改，立刻生效）与静态配置（cordis.patch.yml）的分层。
 *
 * 为什么需要这一层：`cordis.patch.yml` 是**安装期**配置，改它要重启 DSH 才生效，
 * 而面板开关的语义是「点一下就当轮生效」。所以运行时值单独落盘，读取顺序是：
 *
 *   settings.json（运行时，面板写）  →  覆盖  →  cfg（安装期，patch.yml）
 *
 * 盘上文件：~/.dsh/card-summon/settings.json
 *   { "version": 1, "fictionFrame": null | true | false, "fictionFrameText": null | "…" }
 *
 * `null` 表示「没设过」—— 此时完全跟随 cfg。这点是刻意的：
 *   · patch.yml 里写 fictionFrame:false 的用户，面板不点就永远关着；
 *   · 面板点过之后，运行时值优先，patch.yml 不再影响该项（否则「点了没反应」）。
 *   两个值都是 null 时回落到插件默认（虚构框架**默认开**）。
 *
 * 与 vars.js / quick-replies.js 同一套纪律：
 *   · 同步读 + 内存缓存 —— 注入路径（compose 每次渲染）要用，不能 await；
 *   · 写走「读-改-写串行链」，并发点按不会 last-write-wins 吞掉；
 *   · 落盘走「临时文件 + rename」原子替换。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./state.js";

const SETTINGS_FILE = join(STATE_ROOT, "settings.json");
const SETTINGS_VERSION = 1;

/** 自定义框架文本的字符上限（与 cordis.patch.yml 说明里的口径一致）。 */
export const MAX_FRAME_TEXT = 4_000;

export function settingsPath() {
	return SETTINGS_FILE;
}

function emptySettings() {
	return { version: SETTINGS_VERSION, fictionFrame: null, fictionFrameText: null };
}

function readSettingsFile() {
	const base = emptySettings();
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
	} catch {
		// 文件不存在 / 坏 JSON 一律按「没设过」处理 —— 开关不该因为盘上一行烂数据就爆炸
		return base;
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return base;
	// 只认 true / false，其它（字符串 "false"、0、null）都当「没设过」
	if (parsed.fictionFrame === true || parsed.fictionFrame === false) base.fictionFrame = parsed.fictionFrame;
	if (typeof parsed.fictionFrameText === "string" && parsed.fictionFrameText.trim().length > 0) {
		base.fictionFrameText = parsed.fictionFrameText.slice(0, MAX_FRAME_TEXT);
	}
	return base;
}

/**
 * 原子落盘。非原子写（直接 writeFileSync 到目标）在「并发点按 + 多标签页」下
 * 会写出半截 JSON，读回就变成「没设过」—— 用户会看到开关自己弹回去。
 */
function writeSettingsFile(next) {
	mkdirSync(STATE_ROOT, { recursive: true });
	const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(next, null, 1));
	renameSync(tmp, SETTINGS_FILE);
	cache = next;
}

/** @type {object|null} */
let cache = null;

/** 同步读（注入路径用）：内存缓存。 */
export function loadSettings() {
	if (cache === null) cache = readSettingsFile();
	return cache;
}

/** 强制下次 loadSettings() 重读磁盘（测试与外部改文件后用）。 */
export function invalidateSettingsCache() {
	cache = null;
}

/** 读-改-写串行链：并发调用按到达顺序排队，避免 last-write-wins。 */
let chain = Promise.resolve();

/**
 * 串行化的读-改-写。
 * @param {(settings: object) => object|Promise<object>} mutator 收到深拷贝，返回新的表
 * @returns {Promise<object>} 落盘后的完整表
 */
export function updateSettings(mutator) {
	const run = chain.then(async () => {
		const cur = readSettingsFile();
		const draft = structuredClone(cur);
		const next = (await mutator(draft)) ?? draft;
		writeSettingsFile(next);
		return next;
	});
	// 失败也不能断链，否则后续所有写入都被卡住
	chain = run.then(
		() => undefined,
		() => undefined,
	);
	return run;
}

/**
 * 面板 → 运行时的写入。值语义：
 *   `true` / `false`  直接写入
 *   `null`            清掉（回到「跟随 cfg / 插件默认」）
 *   其它             忽略，保持原值
 */
export async function setFictionFrame(value) {
	return updateSettings((s) => {
		if (value === true || value === false) s.fictionFrame = value;
		else if (value === null) s.fictionFrame = null;
		return s;
	});
}

/** 自定义框架文本：空串 / null = 清掉（回到默认文本）。 */
export async function setFictionFrameText(value) {
	return updateSettings((s) => {
		if (value === null || String(value).trim().length === 0) s.fictionFrameText = null;
		else s.fictionFrameText = String(value).slice(0, MAX_FRAME_TEXT);
		return s;
	});
}

/**
 * 把运行时设置合并到安装期配置上，产出 composeSlots / composeCast 的 opts。
 *
 * 单一入口：**所有** compose 调用点都必须经过它。散着写 `cfg?.fictionFrame` 是
 * 本轮要消灭的那种 bug —— 面板改了值，四处调用点里漏掉一处，那条路径就静默不跟随
 * （阵容注入、重启恢复正是最容易漏的两条）。
 *
 * @param {object} cfg cordis.patch.yml 的 config
 */
export function composeOpts(cfg) {
	const s = loadSettings();
	return {
		maxPersonality: cfg?.maxPersonality,
		writingStyle: cfg?.writingStyle,
		writingStyleText: cfg?.writingStyleText,
		// 运行时没设过（null）才回落到 cfg；两者都没有 → undefined → inject.js 里默认开
		fictionFrame: s.fictionFrame === null ? cfg?.fictionFrame : s.fictionFrame,
		fictionFrameText: s.fictionFrameText === null ? cfg?.fictionFrameText : s.fictionFrameText,
	};
}

/**
 * 当前虚构框架的「生效态」—— 给面板与 /status 用。
 *
 * 判据必须与 inject.js 的 fictionFrameOf 同构：`false` 才是关，其余（含 undefined）都是开。
 */
export function fictionFrameState(cfg) {
	const s = loadSettings();
	const opts = composeOpts(cfg);
	const fromRuntime = s.fictionFrame !== null;
	const enabled = opts.fictionFrame !== false;
	return {
		enabled,
		source: fromRuntime ? "panel" : "config",
		// 自定义文本是否生效（面板可以只关开关、保留自定义文本，下次打开还用回它）
		custom: typeof opts.fictionFrameText === "string" && opts.fictionFrameText.trim().length > 0,
		file: SETTINGS_FILE,
	};
}
