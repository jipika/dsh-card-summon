/**
 * 快捷按钮（Quick Reply）离线检查。
 *
 * 分两半：
 *   · 数据层（lib/quick-replies.js）—— 纯 fs，不碰盘上真实数据（state 目录被 DSH_CARD_SUMMON_STATE 换到临时目录）
 *   · 路由契约（index.js 的 /qr、/qr/send）—— 用假 ctx 跑 apply() 收 handler，再喂假 req/res
 *
 * 故意不 import 实现的内部常量：独立维护上限与截断长度，
 * 否则实现改了常量这里跟着改，等于没测。
 *
 * 跑法：node tests/qr-check.mjs
 */
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 必须在任何插件模块被 import 之前设好：lib/state.js 在模块加载时把 STATE_ROOT 定死。
const home = mkdtempSync(join(tmpdir(), "qr-check-"));
process.env.DSH_CARD_SUMMON_STATE = home;

const {
	addQuickReply,
	clearCardQuickReplies,
	invalidateQrCache,
	loadQuickReplies,
	qrPath,
	removeQuickReply,
	resolveQuickReplies,
	updateQuickReply,
} = await import("../lib/quick-replies.js");
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
const eq = (label, actual, expected) =>
	t(label, JSON.stringify(actual) === JSON.stringify(expected), `期望 ${JSON.stringify(expected)} 实得 ${JSON.stringify(actual)}`);

// 独立维护的口径（不 import 实现里的同名常量）
const SCOPE_LIMIT = 20;
const LABEL_MAX = 24;
const AUTO_LABEL = 12;

console.log("=== 1) 空盘与解析 ===");
eq("空文件回空表", loadQuickReplies(), { version: 1, items: [], perCard: {} });
eq("解析空表", resolveQuickReplies("x/y.png"), { global: [], card: [], max: SCOPE_LIMIT });

console.log("\n=== 2) 新增与 label 归一化 ===");
const a1 = await addQuickReply({ scope: "global", text: "继续剧情，推进一个阶段" });
t("id 带 qr_ 前缀", a1.id.startsWith("qr_"), `实得 ${a1.id}`);
eq("短正文 label 原样", a1.item.label, "继续剧情，推进一个阶段");
const a2 = await addQuickReply({ scope: "global", text: "这是一段超过十二个字符的按钮正文" });
eq("长正文 label 截到 12 字 + 省略号", a2.item.label, "这是一段超过十二个字符的…");
t("label 不超上限", a2.item.label.length <= LABEL_MAX, `实得 ${a2.item.label.length}`);
const a3 = await addQuickReply({ scope: "global", label: "  看  看  状态  ", text: "描述一下当前状态" });
eq("显式 label 空白折叠 + trim", a3.item.label, "看 看 状态");

console.log("\n=== 3) 作用域隔离 ===");
await addQuickReply({ scope: "card", fullPath: "a/b.png", text: "卡 A 的按钮" });
await addQuickReply({ scope: "card", fullPath: "c/d.png", text: "卡 C 的按钮" });
t("卡 A 一个", resolveQuickReplies("a/b.png").card.length === 1);
t("卡 C 一个", resolveQuickReplies("c/d.png").card.length === 1);
t("别的卡没有", resolveQuickReplies("zzz.png").card.length === 0);
t("全局对每张卡可见", resolveQuickReplies("a/b.png").global.length === 3);

console.log("\n=== 4) 参数校验 ===");
let threw = false;
try {
	await addQuickReply({ scope: "card", text: "没有 fullPath" });
} catch (error) {
	threw = /fullPath/.test(error.message);
}
t("卡级缺 fullPath → 抛错", threw);
threw = false;
try {
	await addQuickReply({ scope: "global", text: "   " });
} catch (error) {
	threw = /正文/.test(error.message);
}
t("空正文 → 抛错", threw);

console.log("\n=== 5) 改 ===");
const up = await updateQuickReply({ scope: "global", id: a3.id, label: "新标签" });
eq("改标签", up.item.label, "新标签");
eq("正文不动", up.item.text, "描述一下当前状态");
const up2 = await updateQuickReply({ scope: "global", id: a3.id, text: "换了的正文" });
eq("只改正文时标签保留", up2.item.label, "新标签");
eq("正文已改", up2.item.text, "换了的正文");
threw = false;
try {
	await updateQuickReply({ scope: "global", id: "qr_nope", label: "x" });
} catch (error) {
	threw = /找不到/.test(error.message);
}
t("改不存在的 id → 抛错", threw);

console.log("\n=== 6) 删 ===");
const del = await removeQuickReply({ scope: "card", fullPath: "a/b.png", id: resolveQuickReplies("a/b.png").card[0].id });
t("删除成功标记", del.removed === true);
t("卡 A 空了", resolveQuickReplies("a/b.png").card.length === 0);
t("空卡片不留空表", !("a/b.png" in loadQuickReplies().perCard));

console.log("\n=== 7) 上限与原子写 ===");
let over = false;
try {
	for (let i = 0; i < SCOPE_LIMIT + 2; i += 1) await addQuickReply({ scope: "card", fullPath: "many.png", text: `按钮 ${i}` });
} catch (error) {
	over = /最多/.test(error.message);
}
t("超上限 → 抛错", over);
t("上限内全留", resolveQuickReplies("many.png").card.length === SCOPE_LIMIT, `实得 ${resolveQuickReplies("many.png").card.length}`);
eq("无 .tmp 残留", readdirSync(home).filter((f) => f.includes(".tmp")), []);
t("盘上是合法 JSON", readFileSync(qrPath(), "utf8").includes('"version": 1'));

console.log("\n=== 8) 并发与损坏回退 ===");
await Promise.all(Array.from({ length: 15 }, (_, i) => addQuickReply({ scope: "card", fullPath: "conc.png", text: `并发 ${i}` })));
t("并发 15 次无丢失", resolveQuickReplies("conc.png").card.length === 15, `实得 ${resolveQuickReplies("conc.png").card.length}`);
writeFileSync(qrPath(), "{ 这不是 JSON");
invalidateQrCache();
eq("损坏 → 回退空表（不抛）", loadQuickReplies().items, []);

console.log("\n=== 9) 清卡与脏数据归一化 ===");
writeFileSync(
	qrPath(),
	JSON.stringify({ version: 1, items: [{ id: "x", label: "L", text: "T" }], perCard: { "k.png": [{ id: "y", label: "L2", text: "T2" }] } }),
);
invalidateQrCache();
await clearCardQuickReplies("k.png");
eq("清卡后 perCard 空", loadQuickReplies().perCard, {});
t("清卡不动全局", loadQuickReplies().items.length === 1);
writeFileSync(qrPath(), JSON.stringify({ version: 1, items: [{ text: "只有正文" }, { label: "只有标签" }, "不是对象", null] }));
invalidateQrCache();
const cleaned = loadQuickReplies().items;
t("脏数据只留合法项", cleaned.length === 1, `实得 ${cleaned.length}`);
t("缺 id 自动补", cleaned[0].id.startsWith("qr_"));
t("缺 label 自动取正文", cleaned[0].label.length > 0);

console.log("\n=== 10) /qr 路由契约 ===");
// 前置状态必须自己定：上面几段把盘改得七零八落，路由断言不该跟着它们走。
writeFileSync(qrPath(), JSON.stringify({ version: 1, items: [], perCard: {} }));
invalidateQrCache();
// 投递要用的宿主服务：假 agent 把 followup 的消息收下来，flush 记账。
const delivered = [];
const flushed = [];
const fakeAgent = {
	phase: { kind: "idle" },
	session: { header: { id: "qr-test" } },
	followup(message) {
		delivered.push(message);
	},
};
const calls = { routes: [] };
const ctx = {
	effect(fn) {
		const d = fn();
		return typeof d === "function" ? d : () => {};
	},
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: { register: () => () => {} },
	webServer: {
		register(def) {
			calls.routes.push(def);
			return () => {};
		},
	},
	agents: { currentInitiator: () => ({ sessionId: "qr-test", session: { header: { id: "qr-test" } } }) },
	sessions: {
		async flush(session) {
			flushed.push(session);
		},
	},
	sessionController: {
		async resolveAgent() {
			return { agent: fakeAgent };
		},
	},
	logger: { info() {}, warn() {} },
};
await mod.apply(ctx, {});
t("webServer 注册 1 条路由", calls.routes.length === 1, `实得 ${calls.routes.length}`);

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
		json = { raw: text };
	}
	return { status: res.statusCode, json };
}

const g = await call("GET", "/dsh-card-summon/qr?fullPath=rt.png", undefined);
t("GET /qr → 200", g.status === 200, `实得 ${g.status}`);
t("GET /qr 带 file 字段", typeof g.json.file === "string" && g.json.file.length > 0);
eq("GET /qr 空卡空表", [g.json.global.length, g.json.card.length], [0, 0]);

const pa = await call("POST", "/dsh-card-summon/qr", { action: "add", scope: "card", fullPath: "rt.png", text: "路由加的按钮" });
t("POST add → 200", pa.status === 200, `实得 ${pa.status}`);
eq("POST add 回 item", pa.json.item.text, "路由加的按钮");
eq("POST add 回新表", pa.json.card.length, 1);

const pa2 = await call("POST", "/dsh-card-summon/qr", { action: "add", scope: "global", text: "路由加的全局按钮" });
eq("POST add global", pa2.json.global.length, 1);

const pu = await call("POST", "/dsh-card-summon/qr", {
	action: "update",
	scope: "card",
	fullPath: "rt.png",
	id: pa.json.item.id,
	label: "改过的",
});
t("POST update → 200", pu.status === 200, `实得 ${pu.status}`);
eq("POST update 生效", pu.json.card[0].label, "改过的");

const pr = await call("POST", "/dsh-card-summon/qr", { action: "remove", scope: "card", fullPath: "rt.png", id: pa.json.item.id });
t("POST remove → 200", pr.status === 200, `实得 ${pr.status}`);
t("POST remove 生效", pr.json.card.length === 0);

const px = await call("POST", "/dsh-card-summon/qr", { action: "什么都不做", scope: "card", fullPath: "rt.png" });
t("未知 action → 400", px.status === 400, `实得 ${px.status}`);

const pempty = await call("POST", "/dsh-card-summon/qr", { action: "add", scope: "card" });
t("add 缺 fullPath → 500（数据层抛错被路由兜住）", pempty.status === 500, `实得 ${pempty.status}`);

console.log("\n=== 11) /qr/send 投递 ===");
const s400 = await call("POST", "/dsh-card-summon/qr/send", { sessionId: "qr-test", text: "   " });
t("空正文 → 400", s400.status === 400, `实得 ${s400.status}`);
const s400b = await call("POST", "/dsh-card-summon/qr/send", { text: "有正文" });
t("缺 sessionId → 400", s400b.status === 400, `实得 ${s400b.status}`);

const before = delivered.length;
const ok = await call("POST", "/dsh-card-summon/qr/send", { sessionId: "qr-test", text: "点按钮发出去的话" });
t("投递 → 200", ok.status === 200, `实得 ${ok.status}`);
eq("回 mode", ok.json.mode, "started");
t("agent.followup 收到 1 条", delivered.length === before + 1, `实得 ${delivered.length - before}`);
const msg = delivered[delivered.length - 1];
eq("消息 role", msg.role, "user");
eq("消息 source.kind", msg.source.kind, "user");
eq("消息正文", msg.content[0].text, "点按钮发出去的话");
t("消息被冻结（deepFreeze）", Object.isFrozen(msg));
t("flush 被调用", flushed.length > 0);

// 相位不是 idle → 回 queued（观感差别大，必须区分）
fakeAgent.phase = { kind: "running" };
const q = await call("POST", "/dsh-card-summon/qr/send", { sessionId: "qr-test", text: "排队的话" });
eq("非空闲相位 → queued", q.json.mode, "queued");

// resolveAgent 返回 {error} → 路由应把它当失败（而不是静默投递）
const savedResolve = ctx.sessionController.resolveAgent;
ctx.sessionController.resolveAgent = async () => ({ error: new Error("会话不存在") });
const bad = await call("POST", "/dsh-card-summon/qr/send", { sessionId: "ghost", text: "投不出去" });
t("resolveAgent 报错 → 500", bad.status === 500, `实得 ${bad.status}`);
t("错误信息带会话 id", /ghost/.test(bad.json.error ?? ""), `实得 ${bad.json.error}`);
ctx.sessionController.resolveAgent = savedResolve;

rmSync(home, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
