/**
 * Host 半边离线探针：不重启 DSH，用假 ctx 跑 apply()，端到端验证
 *   · 四个扩展点调用形状（systemPrompt.section / tools.register / webServer.register / effect）
 *   · 工具 parameters 是完整 JSON Schema、output 契约齐备
 *   · **求值器三态**：未召唤=空串、召唤后=有文本、取消后=回空串
 *   · HTTP 路由真实响应（status / search / summon / unsummon），且注入求值器随状态变化
 *
 * 跑法：node tests/host-probe.mjs
 * 需要网络（search / summon 会真的打 Chub）。
 */
import { EventEmitter } from "node:events";

const Emitter = EventEmitter;
const calls = { sections: [], tools: [], routes: [], effects: 0 };
const disposers = [];

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

const SESSION = "probe-session-card-summon";

const ctx = {
	effect(fn, label) {
		calls.effects += 1;
		const d = fn();
		if (typeof d === "function") disposers.push(d);
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
	agents: {
		currentInitiator: () => ({ sessionId: SESSION, session: { header: { id: SESSION } } }),
	},
	logger: { info: () => {}, warn: () => {} },
};

console.log("=== 1) 模块导出与 inject 声明 ===");
const mod = await import("../index.js");
console.log(`  name=${mod.name} inject=${JSON.stringify(mod.inject)}`);
t("name 正确", mod.name === "dsh-card-summon");
for (const need of ["systemPrompt", "tools", "webServer", "agents"]) {
	t(`inject 含 ${need}`, mod.inject.includes(need), "—— 运行时会 getter 抛错");
}

console.log("\n=== 2) apply() 扩展点注册 ===");
await mod.apply(ctx, { maxPersonality: 12000 });
console.log(
	`  section×${calls.sections.length} tool×${calls.tools.length} route×${calls.routes.length} effect×${calls.effects}`,
);
t(
	`systemPrompt.section 注册 ${mod.SLOTS.length} 段（酒馆式槽位）`,
	calls.sections.length === mod.SLOTS.length,
	`实得 ${calls.sections.length}`,
);
t("工具注册 7 个（含 card_cast 阵容 + card_local_scan）", calls.tools.length === 7, `实得 ${calls.tools.length}`);
t("webServer 路由注册 1 条", calls.routes.length === 1, `实得 ${calls.routes.length}`);

const section = calls.sections[0];
console.log(`  section: name=${section.name} order=${section.order} text 类型=${typeof section.text}`);
t("主槽位 section.name 正确", section.name === mod.SECTION_NAME);
t("主槽位 = SLOTS[0]（order 10300、排在 persona suffix 之后）", section.order === mod.SLOTS[0].order && section.order > 10200);
t("所有槽位 order 递增且互不相同", new Set(calls.sections.map((s) => s.order)).size === calls.sections.length);
t(
	"槽位名与 SLOTS 一一对应",
	calls.sections.every((s, i) => s.name === mod.SLOTS[i].name && s.order === mod.SLOTS[i].order),
);
t("section.text 是函数（每模型步求值）", typeof section.text === "function");
t("section.interpolate === false（卡里的 {{char}} 不能走宿主插值）", calls.sections.every((s) => s.interpolate === false));

console.log(`  tools: ${calls.tools.map((x) => x.name).join(", ")}`);
for (const tool of calls.tools) {
	const p = tool.parameters;
	t(
		`工具 ${tool.name} parameters 是完整 JSON Schema`,
		p?.type === "object" && typeof p.properties === "object" && p.additionalProperties === false,
	);
	t(`工具 ${tool.name} 有 execute`, typeof tool.execute === "function");
	t(
		`工具 ${tool.name} 有 output{schema,render}`,
		tool.output?.schema !== undefined && typeof tool.output?.render === "function",
	);
}

/* ───────────────── 求值器：三态 ───────────────── */
const evalFor = (sessionId) =>
	section.text({ agent: { sessionId, session: { header: { id: sessionId } } } });

console.log("\n=== 3) 求值器三态（核心：未召唤必须零注入）===");
const before = evalFor("never-summoned-session");
t("未召唤 → 空串（不注入）", before === "", `实得长度 ${before.length}`);
t("context 缺失 → 空串", section.text(undefined) === "");
t("会话 id 缺失 → 空串", evalFor(undefined) === "");

/* ───────────────── 路由端到端 ───────────────── */
function fakeReq(method, url, body) {
	const req = new Emitter();
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
		headers: null,
		writeHead(s, hh) {
			this.statusCode = s;
			this.headers = hh;
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
		json = { _raw: text.slice(0, 300) };
	}
	return { status: res.statusCode, json };
}

console.log("\n=== 4) HTTP 路由 ===");
const health = await call("GET", "/dsh-card-summon/status");
console.log(`  GET /status → ${health.status} ok=${health.json.ok} injected=${health.json.injected}`);
t("GET /status 200 且 ok", health.status === 200 && health.json.ok === true);

const health2 = await call("GET", "/dsh-card-summon/status?sessionId=" + SESSION);
t("GET /status 带 sessionId 时 summon 为 null", health2.json.summon === null);

const unknown = await call("GET", "/dsh-card-summon/nope");
t("未知路由 404", unknown.status === 404);

console.log("\n=== 5) 真实搜索（打 Chub）===");
const search = await call("GET", "/dsh-card-summon/search?q=frieren&first=3");
console.log(`  GET /search → ${search.status} count=${search.json.count} items=${search.json.items?.length}`);
t("搜索返回结果", Array.isArray(search.json.items) && search.json.items.length > 0);
if (Array.isArray(search.json.items) && search.json.items.length > 0) {
	const it = search.json.items[0];
	console.log(`  首条: ${it.fullPath} | ${it.name} | 头像=${it.avatarUrl ? "有" : "无"}`);
	t("搜索结果带 fullPath", typeof it.fullPath === "string" && it.fullPath.includes("/"));
	t("搜索结果带头像 URL（缩略图）", typeof it.avatarUrl === "string" && it.avatarUrl.length > 0);
	t("头像不是 12MB 的完整 PNG", !String(it.avatarUrl).includes("chara_card_v2.png"));
}

console.log("\n=== 6) 真实召唤 → 求值器必须出现文本 ===");
const target = search.json.items?.[0]?.fullPath;
if (target === undefined) {
	t("跳过召唤测试（搜索无结果）", false);
} else {
	const sum = await call("POST", "/dsh-card-summon/summon", { sessionId: SESSION, fullPath: target });
	console.log(`  POST /summon → ${sum.status} ok=${sum.json.ok} name=${sum.json.name} chars=${sum.json.injectedChars}`);
	if (sum.json.needConfirm === true) {
		console.log(`  该卡触发知情确认：${sum.json.why}`);
		const sum2 = await call("POST", "/dsh-card-summon/summon", {
			sessionId: SESSION,
			fullPath: target,
			confirm: true,
		});
		t("带 confirm=true 后召唤成功", sum2.json.ok === true);
	} else {
		t("召唤成功", sum.json.ok === true);
		t("返回注入字符数 > 0", Number(sum.json.injectedChars) > 0);
	}

	const afterSummon = evalFor(SESSION);
	console.log(`  求值器（已召唤）→ 长度 ${afterSummon.length}`);
	t("召唤后求值器返回非空文本", afterSummon.length > 0);
	t("注入段含角色名", afterSummon.includes(String(sum.json.name ?? "").slice(0, 2)));

	const other = evalFor("some-other-session");
	t("**别的会话仍为空串**（隔离）", other === "", `实得长度 ${other.length}`);

	// card_read 能取回完整卡
	const readTool = calls.tools.find((x) => x.name === "card_read");
	const readOut = await readTool.execute({ field: "personality" }, {});
	t("card_read 能取回 personality", readOut.text.length > 0, JSON.stringify(readOut).slice(0, 120));
	t("card_read 报原始长度", Number(readOut.original) > 0);

	const statusNow = await call("GET", "/dsh-card-summon/status?sessionId=" + SESSION);
	t("status 反映已召唤", statusNow.json.summon !== null && statusNow.json.injected > 0);
	// 面板显示的是 summon.chars（client.js:646/1855），必须与实时注入量同源。
	t(
		"status.summon.chars 与 injected 一致（面板不会显示陈旧值）",
		statusNow.json.summon?.chars === statusNow.json.injected,
		`summon.chars=${statusNow.json.summon?.chars} injected=${statusNow.json.injected}`,
	);
	t("status.slots 按槽位给出字符数（新注入模型）", typeof statusNow.json.slots === "object" && statusNow.json.slots !== null);

	console.log("\n=== 7) 解除召唤 → 求值器必须回到空串 ===");
	const un = await call("POST", "/dsh-card-summon/unsummon", { sessionId: SESSION });
	t("解除成功", un.status === 200);
	const afterUnsummon = evalFor(SESSION);
	console.log(`  求值器（已解除）→ 长度 ${afterUnsummon.length}`);
	t("**解除后回到空串**（零残留）", afterUnsummon === "", `实得长度 ${afterUnsummon.length}`);
}

console.log("\n=== 8) output.render 契约（7 工具同源故障的回归闸）===");
// 宿主契约（/tmp/dsh-src packages/core/tools/src/index.ts:218 与 :1845，v0.2.1 核对）：
//   render(args: unknown, value: JsonValue): ContentBlock[]
//   rendered = tool.output.render(exec.arguments, value)   ← 第 1 参是 args，第 2 参才是结果值
// 旧实现 `jsonRender(value) { return { type:"text", ... } }` 两个坑一起踩：
//   · 参数位错 → 渲染出来的是工具入参
//   · 返回非数组 → 宿主把渲染结果直接当 result.content 往下传，消费方对 content 做数组操作时抛
//     `TypeError: content.filter is not a function`，7 个工具一起失效。
// 下面的 textOf **原样抄自宿主源码**与（claude-code-mods/src/host-ops.ts:114，
// hooks-claude-code:326 / hooks-codex:289 同构），用它当真实消费方来断言。
const textOf = (content) =>
	content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");

for (const tool of calls.tools) {
	const ARGS = { __is_args: "yes" };
	const VALUE = { __is_value: "yes", tool: tool.name };
	let rendered;
	try {
		rendered = tool.output.render(ARGS, VALUE);
	} catch (error) {
		t(`工具 ${tool.name} render 可调用`, false, String(error?.message ?? error));
		continue;
	}
	// ① 必须是数组 —— 否则宿主侧 content.filter / content.some 直接崩
	t(`工具 ${tool.name} render 返回数组`, Array.isArray(rendered), `实得 ${typeof rendered}`);
	// ② 必须能被宿主那套 content 处理链吃下（不抛 content.filter is not a function）
	let consumed = null;
	let consumeError = null;
	try {
		consumed = textOf(rendered);
	} catch (error) {
		consumeError = error;
	}
	t(
		`工具 ${tool.name} 结果可被宿主 content 处理链消费`,
		consumeError === null,
		consumeError === null ? "" : consumeError.message,
	);
	// ③ 渲染的必须是第 2 参 value，而不是第 1 参 args
	const hasValue = consumed !== null && consumed.includes("__is_value");
	const hasArgs = consumed !== null && consumed.includes("__is_args");
	t(`工具 ${tool.name} 渲染的是 value 而非 args`, hasValue && !hasArgs, `value=${hasValue} args=${hasArgs}`);
}

console.log("\n=== 9) 工具错误路径 ===");
const badRead = calls.tools.find((x) => x.name === "card_read");
try {
	await badRead.execute({ field: "nope" }, {});
	t("未知字段报错", false);
} catch (e) {
	t("card_read 未知字段报错", true);
}
const unTool = calls.tools.find((x) => x.name === "card_unsummon");
const unOut = await unTool.execute({}, {});
t("重复 unsummon 不崩（ok=false）", unOut.ok === false);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
