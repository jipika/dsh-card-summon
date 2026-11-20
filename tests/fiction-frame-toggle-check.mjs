/**
 * 面板「虚构声明」开关（运行时设置）回归闸。
 *
 * 需求：虚构框架段（fiction-frame / 10415 槽）原本只能靠 cordis.patch.yml 的
 * fictionFrame 控制，改配置要重启 DSH。现在要在角色卡面板里加一个开关，
 * 点一下立刻生效，并且**所有已召唤会话**的注入段都要跟着重算。
 *
 * 锁死六条行为：
 *   ① 分层：运行时值覆盖 cfg；运行时为 null 时跟随 cfg；两者都无 → 默认开
 *   ② 写盘：settings.json 落地，值只认真布尔，脏值不写
 *   ③ 端点：GET /settings 回生效态 + source；POST 写入并返回重建结果
 *   ④ 全量重建：单卡与新召唤都会跟上；阵容（kind:"cast"）走阵容分支而不是被当单卡
 *   ⑤ 幂等：提交目标值，同一目标重复提交结果一致（不取反）
 *   ⑥ 不被弄脏：坏 JSON / 不存在的文件都按「没设过」处理，不抛
 *
 * 手法：DSH_CARD_SUMMON_STATE 指到临时目录（不碰用户真实状态），假 ctx 跑 apply()。
 * 跑法：node tests/fiction-frame-toggle-check.mjs
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在 import 插件之前换掉状态根（STATE_ROOT 是模块顶层常量）
const STATE = mkdtempSync(join(tmpdir(), "card-summon-toggle-"));
process.env.DSH_CARD_SUMMON_STATE = STATE;

const settings = await import("../lib/settings.js");
const state = await import("../lib/state.js");
const mod = await import("../index.js");

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

const SESSION = "toggle-probe-session";
const CAST_SESSION = "toggle-probe-cast";
const CARD = {
	fullPath: "probe/toggle",
	name: "开关探针",
	personality: "冷静，话少，惜字如金。",
	scenario: "深夜的便利店。",
	firstMessage: "……你来了。",
	postHistoryInstructions: "保持角色。",
};
const FRAME_MARK = "成年人扮演";

/* ─────────────── 1) 分层语义（纯函数，不碰盘） ─────────────── */
console.log("=== 1) 运行时 / 配置分层 ===");
settings.invalidateSettingsCache();
t("无任何配置 → 默认开", settings.fictionFrameState(undefined).enabled === true);
t("无任何配置 → source=config", settings.fictionFrameState(undefined).source === "config");
t("cfg:false → 关", settings.fictionFrameState({ fictionFrame: false }).enabled === false);

await settings.setFictionFrame(true);
settings.invalidateSettingsCache();
t("面板设 true 覆盖 cfg:false", settings.fictionFrameState({ fictionFrame: false }).enabled === true);
t("覆盖后 source=panel", settings.fictionFrameState({ fictionFrame: false }).source === "panel");

await settings.setFictionFrame(null);
settings.invalidateSettingsCache();
t("清回 null → 重新跟随 cfg:false", settings.fictionFrameState({ fictionFrame: false }).enabled === false);
t("清回 null → source 回到 config", settings.fictionFrameState({ fictionFrame: false }).source === "config");

/* ─────────────── 2) 落盘与脏值 ─────────────── */
console.log("\n=== 2) 落盘 ===");
await settings.setFictionFrame(false);
settings.invalidateSettingsCache();
const onDisk = JSON.parse(readFileSync(settings.settingsPath(), "utf8"));
t("settings.json 落地", onDisk.fictionFrame === false, JSON.stringify(onDisk));
t("路径在 STATE_ROOT 下", settings.settingsPath().startsWith(STATE));

await settings.setFictionFrame("false"); // 字符串，脏值
settings.invalidateSettingsCache();
t("字符串 \"false\" 不写入（保持原值）", JSON.parse(readFileSync(settings.settingsPath(), "utf8")).fictionFrame === false);

writeFileSync(settings.settingsPath(), "{ 这不是 JSON");
settings.invalidateSettingsCache();
t("坏 JSON 按「没设过」处理", settings.fictionFrameState(undefined).source === "config");
t("坏 JSON 不抛、默认仍开", settings.fictionFrameState(undefined).enabled === true);

rmSync(settings.settingsPath(), { force: true });
settings.invalidateSettingsCache();
t("文件不存在按「没设过」处理", settings.fictionFrameState(undefined).enabled === true);

/* ─────────────── 3) 假 ctx + apply ─────────────── */
console.log("\n=== 3) apply() 与端点 ===");
const calls = { sections: [], contexts: [], tools: [], routes: [], effects: 0 };
const ctx = {
	effect(fn) {
		calls.effects += 1;
		const d = fn();
		return typeof d === "function" ? d : () => {};
	},
	on() {
		return () => {};
	},
	systemPrompt: {
		section(def) {
			calls.sections.push(def);
			return () => {};
		},
		context(def) {
			calls.contexts.push(def);
				return () => {};
			},
	},
	tools: {
		register(def) {
			calls.tools.push(def);
			return () => {};
		},
	},
	webServer: {
		register(def) {
			calls.routes.push(def);
			return () => {};
		},
	},
	agents: { currentInitiator: () => ({ sessionId: SESSION, session: { header: { id: SESSION } } }) },
	logger: { info: () => {}, warn: () => {} },
};

const cfg = { maxPersonality: 12000 };
await mod.apply(ctx, cfg);
t("路由已注册", calls.routes.length === 1);

function fakeReq(method, url, body) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.destroy = () => {};
	req.headers = {};
	queueMicrotask(() => {
		if (body !== undefined) req.emit("data", Buffer.from(JSON.stringify(body)));
		req.emit("end");
	});
	return req;
}
async function call(method, url, body) {
	const chunks = [];
	const res = {
		statusCode: null,
		writeHead(s) {
			this.statusCode = s;
		},
		end(x) {
			chunks.push(x);
		},
	};
	await calls.routes[0].handler(fakeReq(method, url, body), res);
	const text = chunks.join("");
	let json;
	try {
		json = JSON.parse(text);
	} catch {
		json = { _raw: text.slice(0, 200) };
	}
	return { status: res.statusCode, json };
}

const g0 = await call("GET", "/dsh-card-summon/settings");
t("GET /settings 200", g0.status === 200 && g0.json.ok === true);
t("GET /settings 带生效态", typeof g0.json.fictionFrame?.enabled === "boolean", JSON.stringify(g0.json.fictionFrame));
t("GET /settings 带 source", g0.json.fictionFrame?.source === "config");

/* ─────────────── 4) 造两个会话：单卡 + 阵容 ─────────────── */
console.log("\n=== 4) 全量重建（单卡 + 阵容） ===");
// 直接写盘造「上一次运行留下的状态」，再走端点重建（不联网抓卡）
state.setSummon(SESSION, { fullPath: CARD.fullPath, name: CARD.name, chars: 100 });
state.writeCardFile(SESSION, CARD);
state.writeSectionFile(SESSION, "占位");

const castCard = { ...CARD, fullPath: "probe/cast-a" };
const castCard2 = { ...CARD, name: "二号", fullPath: "probe/cast-b" };
state.setSummon(CAST_SESSION, { fullPath: `${castCard.fullPath},${castCard2.fullPath}`, name: "阵容(2人)", chars: 100 });
state.writeCardFile(CAST_SESSION, { kind: "cast", members: [{ card: castCard }, { card: castCard2 }] });
state.writeSectionFile(CAST_SESSION, "占位");

// 求值器：定位 main 槽（单卡 main / 阵容也是 main）
const sectionByKey = (key) => {
	const slot = mod.SLOTS.find((s) => s.key === key);
	return calls.sections.find((s) => s.name === slot.name);
};
const evalSlot = (key, sessionId) =>
	sectionByKey(key).text({ agent: { sessionId, session: { header: { id: sessionId } } } });

// 开关默认开时先重建一次，确认两个会话都注入了框架
await call("POST", "/dsh-card-summon/settings", { fictionFrame: true });
const frameOn = evalSlot("frame", SESSION);
t("单卡：开 → frame 槽有内容", frameOn.includes(FRAME_MARK), `长度 ${frameOn.length}`);
const castOn = evalSlot("main", CAST_SESSION);
t("阵容：开 → 整段含框架", castOn.includes(FRAME_MARK));
t("阵容：重建后没被当成单卡（仍有阵容标题）", castOn.includes("阵容") || castOn.includes("二号"), castOn.slice(0, 80));

/* ─────────────── 5) 关掉 → 全量重建 ─────────────── */
console.log("\n=== 5) 关闭后全量重建 ===");
const off = await call("POST", "/dsh-card-summon/settings", { fictionFrame: false });
t("POST /settings 200", off.status === 200 && off.json.ok === true);
t("返回重建过的会话（≥2）", Array.isArray(off.json.touched) && off.json.touched.length >= 2, JSON.stringify(off.json.touched));
t("返回的生效态 = 关", off.json.fictionFrame?.enabled === false);
t("返回的 source = panel", off.json.fictionFrame?.source === "panel");

const frameOff = evalSlot("frame", SESSION);
t("单卡：关 → frame 槽为空", frameOff === "", `实得 ${JSON.stringify(frameOff.slice(0, 60))}`);
const castOff = evalSlot("main", CAST_SESSION);
t("阵容：关 → 整段不含框架", !castOff.includes(FRAME_MARK));
t("阵容：关后人设仍在", castOff.includes("冷静，话少"));
t("阵容：关后写作规范仍在", castOff.includes("极致详细") || castOff.length > 500);

const s0 = await call("GET", `/dsh-card-summon/status?sessionId=${SESSION}`);
t("/status 带开关态", s0.json.fictionFrame?.enabled === false);
t("/status 的 summon 记录仍在（没被重建搞掉）", s0.json.summon?.fullPath === CARD.fullPath);

/* ─────────────── 6) 幂等：同一目标重复提交 ─────────────── */
console.log("\n=== 6) 幂等 ===");
await call("POST", "/dsh-card-summon/settings", { fictionFrame: false });
const again = await call("POST", "/dsh-card-summon/settings", { fictionFrame: false });
t("同一目标连提两次结果一致（不取反）", again.json.fictionFrame?.enabled === false);
t("第二次仍为空 frame", evalSlot("frame", SESSION) === "");

/* ─────────────── 7) 自定义文本不被开关弄丢 ─────────────── */
console.log("\n=== 7) 自定义文本 ===");
await call("POST", "/dsh-card-summon/settings", { fictionFrameText: "全部角色都是虚构人物。", fictionFrame: true });
const custom = evalSlot("frame", SESSION);
t("自定义文本生效（整段替换）", custom === "全部角色都是虚构人物。", `实得 ${JSON.stringify(custom)}`);
t("自定义生效后不含默认条款", !custom.includes("电视节目"));
await call("POST", "/dsh-card-summon/settings", { fictionFrame: false });
t("关掉后自定义文本槽为空", evalSlot("frame", SESSION) === "");
const keep = await call("GET", "/dsh-card-summon/settings");
t("关掉后自定义文本仍保存着（下次打开还用）", String(keep.json.fictionFrameText).includes("虚构人物"), JSON.stringify(keep.json));
await call("POST", "/dsh-card-summon/settings", { fictionFrame: true });
t("重新打开后自定义文本又生效", evalSlot("frame", SESSION) === "全部角色都是虚构人物。");

/* ─────────────── 8) 清回跟随配置 ─────────────── */
console.log("\n=== 8) 清回跟随配置 ===");
await call("POST", "/dsh-card-summon/settings", { fictionFrame: null });
const back = await call("GET", "/dsh-card-summon/settings");
t("null → source 回到 config", back.json.fictionFrame?.source === "config");
t("cfg 没设 → 默认开", back.json.fictionFrame?.enabled === true);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
rmSync(STATE, { recursive: true, force: true });
process.exit(fail === 0 ? 0 : 1);
