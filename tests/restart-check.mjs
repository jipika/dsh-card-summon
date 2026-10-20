/**
 * 重启恢复探针：apply() 从盘上恢复注入段时，必须**连动态世界书候选一起恢复**。
 *
 * 为什么单独守这一环：dynSource 是纯内存态（不写进 `sections/*.md`），
 * 重启后如果不从卡快照现算，「之前召唤过的会话」会静默失去 keys 触发 ——
 * 而 `/status` 的 dynamicEntries 显示 0，与「这张卡压根没有候选条目」完全无法区分。
 * 这就是那种「重启后悄悄少了一半功能」的故障，必须由断言钉住，不能靠肉眼。
 *
 * 手法：不起 DSH、不打网络。先用 state 的写 API 造出「上一次运行留下的盘上状态」，
 * 再跑一次 apply()（= 模拟重启），然后查 /status 与求值器。
 *
 * 跑法：node tests/restart-check.mjs
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── 必须在 import 插件之前换掉状态根：STATE_ROOT 是模块顶层常量（lib/state.js:23）。──
const STATE = mkdtempSync(join(tmpdir(), "card-summon-restart-"));
process.env.DSH_CARD_SUMMON_STATE = STATE;

const { setSummon, writeSectionFile, loadSectionFromDisk, writeCardFile, clearSummon } = await import("../lib/state.js");
const mod = await import("../index.js");

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

const SESSION = "restart-probe-session";
const STATIC_TEXT = "【静态注入段占位】角色身世在这里。";

/** 造一张带四种世界书条目的卡：只有第一条该进动态候选。 */
const CARD = {
	fullPath: "probe/restart",
	name: "重启探针",
	description: "验证重启恢复的动态世界书候选",
	personality: "冷静",
	scenario: "",
	firstMessage: "",
	exampleDialogs: "",
	systemPrompt: "",
	postHistoryInstructions: "",
	alternateGreetings: [],
	lorebook: {
		entries: [
			{ keys: ["血月"], content: "血月之夜，城里的钟会停摆。", enabled: true, constant: false, insertion_order: 10 },
			{ keys: ["常驻"], content: "常量条目该走静态人设，不该进动态候选。", enabled: true, constant: true, insertion_order: 11 },
			{ keys: [], content: "没有 keys 的条目永远撞不上。", enabled: true, constant: false, insertion_order: 12 },
			{ keys: ["停用"], content: "被停用的条目不该进候选。", enabled: false, constant: false, insertion_order: 13 },
		],
	},
};

function fakeReq(method, url, body) {
	const req = new EventEmitter();
	req.method = method;
	req.url = url;
	req.headers = { "content-type": "application/json" };
	req.destroy = () => {};
	queueMicrotask(() => {
		if (body !== undefined) req.emit("data", Buffer.from(typeof body === "string" ? body : JSON.stringify(body)));
		req.emit("end");
	});
	return req;
}

async function call(routes, method, url, body) {
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
	await routes[0].handler(fakeReq(method, url, body), res);
	const text = chunks.join("");
	try {
		return { status: res.statusCode, json: JSON.parse(text) };
	} catch {
		return { status: res.statusCode, json: { _raw: text.slice(0, 300) } };
	}
}

/** 跑一次 apply（= 模拟一次进程启动）。 */
async function boot() {
	const calls = { sections: [], tools: [], routes: [] };
	const ctx = {
		effect(fn) {
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
	await mod.apply(ctx, {});
	return { calls, section: calls.sections[0] };
}

/** 造一个组装期 context：会话 id 固定，对话文本可控。 */
function evalCtx(recentText) {
	return {
		agent: {
			sessionId: SESSION,
			session: {
				header: { id: SESSION },
				deriveMessages: () => (recentText === undefined ? [] : [{ content: [{ type: "text", text: recentText }] }]),
			},
		},
	};
}

/** 逐条按 order 求值再拼起来 —— 注入现在是多槽位的，只读 sections[0] 只看得到 main 那一句。 */
function evalAll(calls, recentText) {
	const ctx = evalCtx(recentText);
	return calls.sections
		.slice()
		.sort((a, b) => a.order - b.order)
		.map((s) => s.text(ctx))
		.filter((x) => x.length > 0)
		.join("\n\n");
}

console.log("=== 1) 造出「上一次运行留下的盘上状态」===");
// chars 故意写一个离谱值：模拟「上次召唤时落盘的字符数」与「重启后按新代码重算的字符数」不一致。
setSummon(SESSION, { fullPath: CARD.fullPath, name: CARD.name, chars: 999_999, at: new Date().toISOString() });
writeSectionFile(SESSION, STATIC_TEXT);
writeCardFile(SESSION, CARD);
t("summons.json 有这条召唤记录", true);
t("sections/<id>.md 已落盘", loadSectionFromDisk(SESSION) === STATIC_TEXT);

console.log("\n=== 2) 模拟重启：apply() 必须把静态段 + 动态候选一起恢复 ===");
const first = await boot();
t(`apply 注册了 ${mod.SLOTS.length} 段（酒馆式槽位）`, first.calls.sections.length === mod.SLOTS.length, `实得 ${first.calls.sections.length}`);
const noLore = evalAll(first.calls, "今晚只是普通的一夜");
// 重启是按**卡快照现算**槽位的（不是读回旧段落），所以静态注入来自卡本身。
t("静态段回内存（求值器非空）", noLore.includes("冷静") && noLore.startsWith("写「重启探针」"), `实得 ${JSON.stringify(noLore.slice(0, 60))}`);
const status1 = await call(first.calls.routes, "GET", `/dsh-card-summon/status?sessionId=${SESSION}`);
const dynCount = status1.json.dynamicEntries;
t("**dynSource 也恢复了**（dynamicEntries = 1，不是 0）", dynCount === 1, `实得 ${JSON.stringify(dynCount)}`);
t("候选条数 = 1（四条目里只有「血月」那条够格）", dynCount === 1, `实得 ${JSON.stringify(dynCount)}`);

// /status 的 summon.chars 必须是**实时值**：面板 client.js:646/1855 就是拿它显示的，
// 而持久化记录里那个数是上次召唤时写的（重启后槽位重算，两者会不一致）。
t(
	"status.summon.chars 用内存实时值覆盖持久化的陈旧值",
	status1.json.summon?.chars === status1.json.injected,
	`summon.chars=${status1.json.summon?.chars} injected=${status1.json.injected}（持久化里是 999999）`,
);
// 覆盖必须是**副本**：getSummon 返回的是 Map 里的引用，就地赋值会把实时值写回磁盘。
const persisted = JSON.parse(readFileSync(join(STATE, "summons.json"), "utf8"));
t(
	"覆盖没有写回持久化（磁盘上仍是 999999）",
	persisted[SESSION]?.chars === 999_999,
	`实得 ${JSON.stringify(persisted[SESSION]?.chars)}`,
);

console.log("\n=== 3) 恢复后的动态注入行为（四种条目各自对不对）===");
const withLore = evalAll(first.calls, "听说三天后是血月。");
t("对话命中「血月」→ 注入段含条目正文", withLore.includes("血月之夜，城里的钟会停摆。"));
t("动态段拼在静态段**之后**（不顶掉人设）", withLore.indexOf("血月之夜") > withLore.indexOf("冷静"));
t("没命中 → 注入段与静态段逐字相同（零附加）", noLore === evalAll(first.calls, "今晚只是普通的一夜"), `实得 ${JSON.stringify(noLore.slice(0, 80))}`);

// 下面几条用「对话里专门提到这些词」来证明它们确实不在候选里 —— 元数据只报条数，报不出是谁。
const otherWords = evalAll(first.calls, "常驻和停用这两个词这一轮都出现了。");
const countOf = (hay, needle) => hay.split(needle).length - 1;
// constant 条目现在按酒馆语义进**静态槽位**（worldAfter），因此只该出现一次：
// 出现两次 = 又进了动态候选（重复注入），这才是要防的。
t("constant 条目只出现一次（静态槽位已注入，不进动态候选）", countOf(otherWords, "常量条目该走静态人设") === 1, `实得 ${countOf(otherWords, "常量条目该走静态人设")} 次`);
t("无 keys 条目撞不上", !otherWords.includes("永远撞不上"));
t("停用条目撞不上", !otherWords.includes("被停用"));
t("提到这些词时注入段与基准逐字相同（零附加）", otherWords === noLore, `实得 ${JSON.stringify(otherWords.slice(0, 80))}`);

console.log("\n=== 4) 降级：卡快照缺失时必须优雅退化，且静态注入不受影响 ===");
const cardPath = join(STATE, "cards", `${SESSION}.json`);
unlinkSync(cardPath);
let bootErr;
const second = await boot().catch((error) => {
	bootErr = error;
	return undefined;
});
t("卡快照缺失时 apply() 不抛", bootErr === undefined, String(bootErr?.message ?? ""));
if (second !== undefined) {
	const status2 = await call(second.calls.routes, "GET", `/dsh-card-summon/status?sessionId=${SESSION}`);
	t("dynamicEntries = 0（退化为仅静态注入）", status2.json.dynamicEntries === 0, `实得 ${JSON.stringify(status2.json.dynamicEntries)}`);
	// 卡快照没了 → 只能退回上一次落盘的整段，放进 main 槽（至少不丢注入）。
	const text3 = evalAll(second.calls, "血月");
	t("**静态段仍在**（动态世界书失效不牵连人设）", text3 === STATIC_TEXT, `实得 ${JSON.stringify(text3.slice(0, 60))}`);
	t("求值器不因 dynSource 缺失而抛", typeof text3 === "string");
}

console.log("\n=== 5) 清理 ===");
clearSummon(SESSION);
t("clearSummon 后段落盘被删", loadSectionFromDisk(SESSION) === undefined);
rmSync(STATE, { recursive: true, force: true });
t("临时状态目录已清理", true);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exitCode = fail === 0 ? 0 : 1;
