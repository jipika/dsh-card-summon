/**
 * lib/vars.js（模板宏 + 变量表）+ `/vars` 路由的离线测试。
 *
 * 覆盖：
 *   · 宏三分类（substituted / known / custom）与大小写、空白变体的合并计数
 *   · applyMacros：求值 / 未赋值原样保留 / known **不**计入 missing / 幂等
 *   · **注入面全覆盖**：替换后卡里任何注入字段都不再残留 A 类宏
 *     （用测试**自己维护**的字段清单扫描，不经 cardTextOf —— 同源实现互相抵消就白测了）
 *   · composeSummon 端到端：注入段里出现真实值 + 显式告知未赋值变量
 *   · extractFromCard 盘点（面板「变量」页的数据源）
 *   · vars.json 读改写：卡级 > 全局 > 默认、空值即删、损坏回退、原子写、值截断
 *   · `/vars` 路由契约（GET 缺参 400 / POST 写入 / 卡级缺 fullPath 400）
 *   · 真实卡库批量验收（盘不在则跳过，不假装通过）
 *
 * 跑法：node tests/vars-check.mjs
 *
 * 隔离：状态写在 mkdtemp 临时目录（env `DSH_CARD_SUMMON_STATE`），
 *       绝不碰 `~/.dsh/card-summon/` 下用户真实的 summons.json / vars.json / cards。
 *
 * 明确**没有**覆盖的：`GET /vars` 的成功路径需要真实卡（本地卡库或联网 Chub），
 * 这里不伪造 —— 它背后的两件事（扫描分类、盘点）分别由 composeSummon 段与
 * extractFromCard 段直接验证。不假装覆盖。
 */
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

// ⚠️ STATE_ROOT 在模块加载那一刻就固定了，env 必须先设 —— 所以下面用动态 import。
const TMP = mkdtempSync(join(tmpdir(), "card-summon-vars-"));
process.env.DSH_CARD_SUMMON_STATE = TMP;

const V = await import("../lib/vars.js");
const { composeSummon } = await import("../lib/inject.js");
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
const eq = (got, want, label) =>
	t(label, JSON.stringify(got) === JSON.stringify(want), `得到 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`);

/* ─────────────── 测试自己维护的「注入面」清单（关键：独立实现） ─────────────── */

/** 会被注入段消费的卡字段 —— 这份清单是**独立**维护的，故意不 import 实现的 CARD_TEXT_FIELDS。 */
const INJECT_TEXT_FIELDS = [
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

/** A 类宏 = 本插件声称能真求值的（写死在这里，与实现的 SUBSTITUTED 集合刻意分开维护）。 */
const SUBSTITUTED_RE = /\{\{\s*(user|char|original)\s*\}\}/i;

/** 扫描一张卡：还有哪些注入字段残留 A 类宏。返回字段路径数组（空 = 干净）。 */
function scanResidue(card) {
	const hit = [];
	for (const f of INJECT_TEXT_FIELDS) {
		if (typeof card?.[f] === "string" && SUBSTITUTED_RE.test(card[f])) hit.push(f);
	}
	if (Array.isArray(card?.alternateGreetings)) {
		card.alternateGreetings.forEach((g, i) => {
			if (typeof g === "string" && SUBSTITUTED_RE.test(g)) hit.push(`alternateGreetings[${i}]`);
		});
	}
	if (Array.isArray(card?.lorebook?.entries)) {
		card.lorebook.entries.forEach((e, i) => {
			if (typeof e?.content === "string" && SUBSTITUTED_RE.test(e.content)) hit.push(`lorebook.entries[${i}].content`);
			if (typeof e?.comment === "string" && SUBSTITUTED_RE.test(e.comment)) hit.push(`lorebook.entries[${i}].comment`);
		});
	}
	if (Array.isArray(card?.personaDerivedDropped)) {
		card.personaDerivedDropped.forEach((d, i) => {
			if (typeof d?.label === "string" && SUBSTITUTED_RE.test(d.label)) hit.push(`personaDerivedDropped[${i}].label`);
		});
	}
	return hit;
}

/** 每个注入字段都埋一个 A 类宏的卡；同时带 B 类、C 类与"预算外条目 label"。 */
const fixture = () => ({
	name: "苏晚",
	fullPath: "local://fixture/苏晚.png",
	personality: "{{user}}的姐姐，本名{{char}}，也叫{{User}}；数值{{数字}}；骰{{roll 1d6}}。",
	personaDerived: "派生：{{user}}在此地开茶馆。",
	scenario: "{{user}}与{{char}}初次见面。",
	firstMessage: "{{user}}推门进来。",
	exampleDialogs: "{{user}}: 在吗",
	systemPrompt: "{{user}}的系统提示。",
	postHistoryInstructions: "{{user}}的后置指令。",
	mesExample: "{{user}}的示例对话。",
	alternateGreetings: ["{{user}}的替代开场白。"],
	lorebook: { entries: [{ content: "{{user}}的世界书正文。", comment: "常驻·住所" }] },
	personaDerivedDropped: [
		{ label: "{{user}}-瘦帅版", chars: 100 },
		{ label: "无宏的条目名", chars: 50 },
	],
});

console.log("=== 1) 宏三分类（唯一真源 classifyMacro）===");
eq(V.classifyMacro("user").kind, "substituted", "user → A 类");
eq(V.classifyMacro("char").kind, "substituted", "char → A 类");
eq(V.classifyMacro("User").kind, "substituted", "User 大小写不敏感 → A 类");
eq(V.classifyMacro("  user  ").kind, "substituted", "空白变体 → A 类");
eq(V.classifyMacro("original").kind, "substituted", "original → A 类");
eq(V.classifyMacro("roll 1d6").kind, "known", "roll 1d6 → B 类（酒馆标准宏，本插件未实现）");
eq(V.classifyMacro("setvar::x::1").kind, "known", "setvar:: → B 类");
eq(V.classifyMacro("format_message_variable::x").kind, "known", "format_message_variable:: → B 类");
eq(V.classifyMacro("数字").kind, "custom", "中文变量 → C 类");
eq(V.classifyMacro("弹").kind, "custom", "自定义 → C 类");

console.log("\n=== 2) extractMacros：合并计数与边界 ===");
const m1 = V.extractMacros("{{user}}{{User}}{{ user }}{{char}}");
eq([...m1.keys()].sort(), ["char", "user"], "大小写/空白变体合并为一条");
eq(m1.get("user").count, 3, "user 合并计数 3");
eq(m1.get("user").kind, "substituted", "合并后仍保留分类");
eq([...V.extractMacros("{{a\nb}}").keys()], [], "宏名不含换行 → 不是宏");
eq([...V.extractMacros(`{{${"x".repeat(65)}}}`).keys()], [], "宏名 > 64 字符 → 不是宏");
eq([...V.extractMacros("正文里的单个 { 与 }}").keys()], [], "不成对的花括号不误吞");
eq([...V.extractMacros("{{甲}}{{乙}}").keys()].length, 2, "两个不同的中文变量各算一条");

console.log("\n=== 3) applyMacros：求值 / 保留 / missing ===");
const ctx3 = { vars: { user: "林昭", char: "苏晚" }, userName: "林昭", charName: "苏晚" };
const r1 = V.applyMacros("{{user}}爱上{{char}}，还有{{数字}}与{{roll 1d6}}", ctx3);
t("A 类被替换", r1.text === "林昭爱上苏晚，还有{{数字}}与{{roll 1d6}}", `得到 ${r1.text}`);
eq(r1.missing.map((x) => x.name), ["数字"], "missing 只含未赋值的 C 类");
t("B 类不计入 missing", !r1.missing.some((x) => x.name === "roll 1d6"), "否则用户以为自己漏填了东西");
const r1b = V.applyMacros(r1.text, ctx3);
t("幂等：再跑一次结果相同", r1b.text === r1.text);
eq(r1b.missing.map((x) => x.name), ["数字"], "幂等：missing 也相同");
const r2 = V.applyMacros("{{数字}}和{{数字}}", ctx3);
eq(r2.missing.length, 1, "同一个未赋值变量只报一次");

console.log("\n=== 4) 注入面全覆盖（替换面 == 注入面）===");
const base = fixture();
const vars4 = V.resolveVarsFor(base, { userName: "林昭" });
const rep = V.applyMacrosToCard(base, { vars: { ...vars4, user: "林昭", char: "苏晚" }, userName: "林昭", charName: "苏晚" });
eq(scanResidue(rep.card), [], "★ 任何注入字段都不再残留 A 类宏");
t("注入字段真的换成了值", rep.card.personality.includes("林昭的姐姐"), rep.card.personality.slice(0, 40));
t("世界书正文也换", rep.card.lorebook.entries[0].content.includes("林昭"), rep.card.lorebook.entries[0].content);
t("替代开场白也换", rep.card.alternateGreetings[0].includes("林昭"), rep.card.alternateGreetings[0]);
t(
	"★ personaDerivedDropped[].label 也换（回归：它曾被漏掉，4/178 张卡命中）",
	rep.card.personaDerivedDropped[0].label === "林昭-瘦帅版",
	rep.card.personaDerivedDropped[0].label,
);
t("无宏的 label 原样不动", rep.card.personaDerivedDropped[1].label === "无宏的条目名");
t("B 类原样保留", rep.card.personality.includes("{{roll 1d6}}"));
t("C 类原样保留", rep.card.personality.includes("{{数字}}"));
t("非文本字段不被破坏", rep.card.personaDerivedDropped[0].chars === 100);
t("原卡对象未被就地修改（浅拷贝契约）", base.personality.includes("{{user}}"), "否则 card_read 取回的原文会被求值污染");
t("report.missing 报到未赋值变量", rep.report.missing.some((x) => x.name === "数字"));
t("report.missing 不含 B 类", !rep.report.missing.some((x) => x.name === "roll 1d6"));

console.log("\n=== 5) composeSummon 端到端（注入段里真的没有裸宏）===");
const out5 = composeSummon(fixture(), { userName: "林昭", charName: "苏晚" });
t("注入段含真实用户名", out5.text.includes("林昭"));
t("注入段不含 {{user}}", !/\{\{\s*user\s*\}\}/i.test(out5.text));
t("注入段不含 {{char}}", !/\{\{\s*char\s*\}\}/i.test(out5.text));
t("★ 明说「未赋值的自定义变量」而不是留着裸宏让模型瞎猜", out5.text.includes("未赋值的自定义变量"));
t("提示里点名了 {{数字}}", out5.text.includes("{{数字}}"));
// ⚠️ B 类（roll 1d6 这类酒馆标准宏）**故意**原样留在卡正文里 —— 那是设计意图，
//    所以不能断言"全文不含"。要断言的是「提示行没把它列成待填」。
const tipLine = out5.text.split("\n").find((l) => l.includes("未赋值的自定义变量")) ?? "";
t("提示行只列待填变量，不把 {{roll 1d6}} 当待填", tipLine.includes("{{数字}}") && !tipLine.includes("roll 1d6"), tipLine.slice(0, 120));
t("B 类宏按设计留在正文里（不假装已实现）", out5.text.includes("{{roll 1d6}}"));
t("chars 与 text 长度一致", out5.chars === out5.text.length, `${out5.chars} vs ${out5.text.length}`);
t("macroReport 一并返回（面板要显示）", out5.macroReport !== undefined);
const out5b = composeSummon(fixture(), { userName: "林昭", charName: "苏晚" });
t("同一张卡两次召唤 → 同一文本（幂等，不会二次消耗）", out5b.text === out5.text);
t("不同用户名 → 不同文本", composeSummon(fixture(), { userName: "甲" }).text !== composeSummon(fixture(), { userName: "乙" }).text);

console.log("\n=== 6) extractFromCard：面板「变量」页的数据源 ===");
const ex = V.extractFromCard(fixture(), { user: "林昭", char: "苏晚" });
eq(ex.builtin.map((x) => x.name).sort(), ["char", "user"], "builtin 收到 user/char");
t("builtin 的 user 合并了 {{user}}/{{User}}", ex.builtin.find((x) => x.name === "user").count > 1);
eq(ex.known.map((x) => x.name), ["roll 1d6"], "known 单列 B 类");
eq(ex.custom.map((x) => x.name), ["数字"], "custom 只含 C 类");
eq(ex.missing, ["数字"], "未填的进 missing");
t("custom 项带 filled=false", ex.custom[0].filled === false);
const ex2 = V.extractFromCard(fixture(), { user: "林昭", char: "苏晚", 数字: "42" });
eq(ex2.custom[0].value, "42", "带出已填值");
t("已填 → filled=true", ex2.custom[0].filled === true);
eq(ex2.missing, [], "已填 → missing 清空");

console.log("\n=== 7) vars.json：优先级 / 删除 / 损坏回退 / 原子写 ===");
const FILE = V.varsPath();
t("vars.json 落在临时目录（隔离）", FILE.startsWith(TMP), FILE);
eq(V.loadVars().global.user, "", "初始 global.user 是空串（空 ≠ 默认值「你」，否则面板分不清填没填）");
await V.setVar({ scope: "global", name: "user", value: "全局用户" });
await V.setVar({ scope: "card", fullPath: "c/1", name: "user", value: "卡级用户" });
eq(V.resolveVarsFor({ fullPath: "c/1" }).user, "卡级用户", "卡级 > 全局");
eq(V.resolveVarsFor({ fullPath: "c/2" }).user, "全局用户", "无卡级则落全局");
eq(V.resolveVarsFor({ fullPath: "c/2", name: "苏晚" }).char, "苏晚", "char 落卡名");
eq(V.resolveVarsFor({ fullPath: "c/2" }).user, "全局用户", "（回落链完整）");
await V.setVar({ scope: "card", fullPath: "c/1", name: "user", value: "" });
eq(V.resolveVarsFor({ fullPath: "c/1" }).user, "全局用户", "空值 = 删除该变量，回落到全局");
await V.setVar({ scope: "card", fullPath: "c/1", name: "长变量", value: "x".repeat(5000) });
eq(V.loadVars().cards["c/1"]["长变量"].length, V.MAX_VALUE_CHARS, `值截断到 MAX_VALUE_CHARS=${V.MAX_VALUE_CHARS}`);
t("落盘后无 .tmp 残留（原子 rename）", readdirSync(TMP).every((f) => !f.includes(".tmp")), readdirSync(TMP).join(","));
t("落盘文件是合法 JSON", (() => { try { JSON.parse(readFileSync(FILE, "utf8")); return true; } catch { return false; } })());
t("落盘文件不缩进爆炸（1 空格缩进）", readFileSync(FILE, "utf8").split("\n").length > 3);
writeFileSync(FILE, "{ 这不是 JSON", "utf8");
V.invalidateVarsCache();
eq(V.loadVars().global.user, "", "损坏文件 → 回退空表，不抛");
writeFileSync(FILE, JSON.stringify({ version: 1, global: { user: "恢复" }, cards: "不是对象" }), "utf8");
V.invalidateVarsCache();
eq(V.loadVars().global.user, "恢复", "结构错位（cards 不是对象）不炸，能读的部分照读");
await V.setVar({ scope: "card", fullPath: "c/9", name: "甲", value: "1" });
await V.clearCardVars("c/9");
eq(V.loadVars().cards["c/9"], undefined, "clearCardVars 清空该卡自定义变量");
eq(V.loadVars().global.user, "恢复", "clearCardVars 不动 global");
let threw = false;
try {
	await V.setVar({ scope: "card", name: "甲", value: "1" });
} catch {
	threw = true;
}
t("卡级变量缺 fullPath → 抛错（不静默写进某个空 key）", threw);
threw = false;
try {
	await V.setVar({ scope: "global", name: "  ", value: "1" });
} catch {
	threw = true;
}
t("空变量名 → 抛错", threw);

console.log("\n=== 8) /vars 路由契约 ===");
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
	agents: { currentInitiator: () => ({ sessionId: "vars-test", session: { header: { id: "vars-test" } } }) },
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

const g400 = await call("GET", "/dsh-card-summon/vars", undefined);
t("GET /vars 缺 fullPath → 400", g400.status === 400, `实得 ${g400.status}`);
const p400 = await call("POST", "/dsh-card-summon/vars", { scope: "card", entries: [{ name: "甲", value: "1" }] });
t("POST /vars 卡级缺 fullPath → 400", p400.status === 400, `实得 ${p400.status}`);
const pOk = await call("POST", "/dsh-card-summon/vars", {
	scope: "global",
	entries: [
		{ name: "user", value: "面板写的名字" },
		{ name: "临时", value: "1" },
	],
});
t("POST /vars（global scope）→ 200", pOk.status === 200, `实得 ${pOk.status} ${JSON.stringify(pOk.json)}`);
eq(pOk.json.written, 2, "两条都写了");
eq(V.loadVars().global.user, "面板写的名字", "写入真的落到 vars.json");
eq(pOk.json.touched, [], "无召唤会话 → 没有需要重建的段（不是静默失败）");
t("回显了文件路径（面板要显示去哪改）", typeof pOk.json.file === "string" && pOk.json.file.endsWith("vars.json"));
const pDel = await call("POST", "/dsh-card-summon/vars", { scope: "global", entries: [{ name: "临时", value: "" }] });
eq(pDel.json.written, 1, "空值也计入写入条目");
eq(V.loadVars().global["临时"], undefined, "空值 = 删除");
const pEmpty = await call("POST", "/dsh-card-summon/vars", { scope: "global", entries: [] });
t("空 entries → 200 且 written=0（幂等，不该报错）", pEmpty.status === 200 && pEmpty.json.written === 0, JSON.stringify(pEmpty.json));
const pGC = await call("POST", "/dsh-card-summon/vars", { scope: "card", fullPath: "c/gc", entries: [{ name: "姓名", value: "阿甲" }] });
eq(V.loadVars().cards["c/gc"]["姓名"], "阿甲", "卡级写入落盘");
eq(pGC.json.touched, [], "该卡没有召唤中的会话 → touched 空");
t("未知路由仍返回 404（没被 /vars 吃掉）", (await call("GET", "/dsh-card-summon/不存在的路由", undefined)).status === 404);

console.log("\n=== 9) 真实卡库批量验收（盘不在则跳过）===");
const ROOT = process.env.CARD_ROOT ?? "/Volumes/mac/下载/26.6角色卡/26.7月全中文备注角色卡（14000➕）";
if (!existsSync(ROOT)) {
	console.log(`  ⊘ 跳过：本地卡库不可访问（外置盘未挂载？）\n    ${ROOT}`);
} else {
	const { readLocalCardFile, normalizeLocalCard, relOf, metaFromPath } = await import("../lib/local.js");
	const wanted = Number(process.env.N ?? 200);
	const files = [];
	const walk = (dir) => {
		if (files.length >= wanted) return;
		for (const e of readdirSync(dir, { withFileTypes: true })) {
			if (files.length >= wanted) return;
			const p = join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (e.name.toLowerCase().endsWith(".png")) files.push(p);
		}
	};
	walk(ROOT);
	let withMacro = 0;
	let hitsTotal = 0;
	let aVars = 0;
	let bKept = 0;
	let cKept = 0;
	let unreadable = 0;
	const residues = [];
	const toldUser = [];
	for (const file of files) {
		const rel = relOf(`local://${file.slice(ROOT.length + 1)}`);
		let card;
		try {
			const raw = readLocalCardFile(file);
			card = normalizeLocalCard(raw, { ...metaFromPath(rel), file: rel, fullPath: `local://${rel}` });
		} catch {
			// 卡库里混着非角色卡 / 半截图 / 损坏卡（实测有），跳过而不是崩掉整轮。
			unreadable += 1;
			continue;
		}
		const vars = V.resolveVarsFor(card, { userName: "验收用户" });
		const { card: done, report } = V.applyMacrosToCard(card, { vars, userName: vars.user, charName: vars.char });
		hitsTotal += report.hits;
		aVars += report.replaced.length;
		bKept += report.known.length;
		cKept += report.missing.length;
		if (report.hits > 0) withMacro += 1;
		const residue = scanResidue(done);
		if (residue.length > 0) residues.push(`${rel}: ${residue.join(", ")}`);
		const out = composeSummon(card, { userName: vars.user, charName: vars.char });
		if (out.text.includes("未赋值的自定义变量")) toldUser.push(rel);
	}
	const scanned = files.length - unreadable;
	console.log(
		`  扫了 ${scanned} 张（跳过读不了的 ${unreadable} 张）：含宏 ${withMacro} 张 | 宏命中 ${hitsTotal} 处 | 其中已求值变量名 ${aVars} 个 | B 类保留 ${bKept} 处 | C 类待填 ${cKept} 处`,
	);
	console.log(`  显式告知「有未赋值变量」的卡：${toldUser.length} 张`);
	eq(residues.slice(0, 5), [], `★ ${scanned} 张真实卡零 A 类残留`);
	t("确实扫到了宏（否则这条断言是空转）", withMacro > scanned * 0.3, `含宏 ${withMacro}/${scanned}`);
	t("B/C 类没被误删", bKept + cKept > 0, `B=${bKept} C=${cKept}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
