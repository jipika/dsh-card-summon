/**
 * 阵容（cast）与「智能体自读卡」验证。
 *
 * 这组能力回答一个与「召唤」不同的需求：
 *   · 召唤 card_summon  = 我**就是**那个角色（接管人格，沉浸单聊）
 *   · 读取 card_read    = 我把卡**读进来**（不接管人格；任意卡，无需先召唤）
 *   · 阵容 card_cast    = 我读多张卡、**同时演这些人**（开团/群像/写文）；默认只读，inject=true 才注入
 *
 * 为什么默认不注入：开团时若把某个角色注进系统提示，主会话人格会被那个角色吃掉，
 * 而用户是让「智能体去读取」再按卡演 —— 读取与接管是两件事。
 *
 * 跑法：node tests/cast-check.mjs   （需要网络）
 */
import { EventEmitter } from "node:events";

let pass = 0;
let fail = 0;
const t = (label, cond, extra = "") => {
	if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
	else { fail += 1; console.log(`  ✗ ${label} ${extra}`); }
};

const calls = { tools: [], routes: [] };
const ctx = {
	effect: (f) => { const d = f(); return typeof d === "function" ? d : () => {}; },
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: { register: (d) => { calls.tools.push(d); return () => {}; } },
	webServer: { register: (d) => { calls.routes.push(d); return () => {}; } },
	agents: { currentInitiator: () => ({ sessionId: "cast-probe", session: { header: { id: "cast-probe" } } }) },
};
const mod = await import("../index.js");
await mod.apply(ctx, {});
const T = (n) => {
	const tool = calls.tools.find((x) => x.name === n);
	if (tool === undefined) throw new Error(`工具 ${n} 未注册`);
	return tool;
};

console.log("=== 1) 工具面 ===");
for (const n of ["card_search", "card_summon", "card_cast", "card_unsummon", "card_status", "card_read"]) {
	t(`注册了 ${n}`, calls.tools.some((x) => x.name === n));
}
const castParams = T("card_cast").parameters.properties;
console.log(`  card_cast 参数: ${Object.keys(castParams).join(", ")}`);
t("card_cast 有 members", "members" in castParams);
t("card_cast 有 inject 开关", "inject" in castParams);
t("inject 不是必填（默认 false = 不注入）", !T("card_cast").parameters.required.includes("inject"));
t("card_read 有 fullPath（读任意卡）", "fullPath" in T("card_read").parameters.properties);

console.log("\n=== 2) card_read：读任意卡（无需先召唤）===");
const read = T("card_read");
let guideErr = null;
try { await read.execute({}, {}); } catch (e) { guideErr = e; }
t("未召唤且未传 fullPath → 报错并给出指引", guideErr !== null && /fullPath/.test(guideErr.message));
console.log(`      指引: ${String(guideErr?.message).slice(0, 88)}…`);

const sr = await T("card_search").execute({ source: "chub", query: "修仙", first: 3 }, {});
t("搜到卡", sr.items.length > 0);
const ref = sr.items[0].fullPath;
const r1 = await read.execute({ fullPath: ref, field: "personality", maxChars: 200 }, {});
console.log(`  读 ${r1.name}: 原文 ${r1.original} 字，本次 ${r1.text.length}`);
t("未召唤也能读到卡", r1.text.length > 0);
t("返回原始长度", Number(r1.original) > 0);
t("返回来源标记", typeof r1.source === "string");
if (r1.nextFrom !== null) {
	const r2 = await read.execute({ fullPath: ref, field: "personality", from: r1.nextFrom, maxChars: 200 }, {});
	t("分段读第二段与第一段不同", r2.text !== r1.text);
	t("第二段 nextFrom 推进", (r2.nextFrom ?? 0) > (r1.nextFrom ?? 0));
}

const sz = await T("card_search").execute({ source: "sichang", first: 2 }, {});
if (sz.items.length > 0) {
	const r3 = await read.execute({ fullPath: sz.items[0].fullPath, field: "first_message", maxChars: 100 }, {});
	t("跨源读中文站卡（sichang:// 前缀路由）", r3.source === "sichang" && r3.text.length > 0);
	t("中文站卡返回中文正文", /[\u4e00-\u9fff]/.test(r3.text));
}

console.log("\n=== 3) card_cast 只读模式（默认；不注入）===");
const cand = await T("card_search").execute({ source: "sichang", first: 10 }, {});
const usable = [];
for (const it of cand.items) {
	const probe = await T("card_cast").execute({ members: [{ fullPath: it.fullPath }] }, {});
	if (probe.ok === true) usable.push(it);
	if (usable.length >= 3) break;
}
t("找到 3 张可用卡（不触发知情闸门）", usable.length === 3, `实得 ${usable.length}`);
if (usable.length >= 3) {
	const members = usable.map((x, i) => ({ fullPath: x.fullPath, role: ["队长", "军师", "新兵"][i] }));
	const c = await T("card_cast").execute({ members }, {});
	console.log(`  mode=${c.mode} count=${c.count}`);
	t("默认 mode 是 read-only", c.mode === "read-only");
	t("返回全部成员", c.count === 3);
	t("每个成员带人设正文", c.members.every((m) => typeof m.personality === "string"));
	t("role 被保留", c.members.every((m, i) => m.role === ["队长", "军师", "新兵"][i]));
	t("带 fullPath 与 name", c.members.every((m) => m.fullPath.length > 0 && m.name.length > 0));
	t("标注被截断的字段", c.members.every((m) => Array.isArray(m.truncated)));

	console.log("\n=== 4) 只读模式确实未注入（开团不接管人格的关键）===");
	const st = await T("card_status").execute({}, {});
	t("status.summoned 仍 false", st.summoned === false);
	t("status.injected 仍 0", st.injected === 0);

	console.log("\n=== 5) 注入模式 ===");
	const c2 = await T("card_cast").execute({ members, inject: true }, {});
	t("mode 变为 injected", c2.mode === "injected");
	t("注入非零字符", c2.injectedChars > 0);
	t("返回 cast 名单", Array.isArray(c2.cast) && c2.cast.length === 3);
	const st2 = await T("card_status").execute({}, {});
	t("status.injected > 0", st2.injected > 0);
	t("status.summoned 变 true", st2.summoned === true);
	console.log(`      注入 ${c2.injectedChars} 字符：${c2.cast.join("、")}`);

	console.log("\n=== 6) 解除后归零 ===");
	await T("card_unsummon").execute({}, {});
	const st3 = await T("card_status").execute({}, {});
	t("解除后 summoned false", st3.summoned === false);
	t("解除后 injected 0", st3.injected === 0);
}

console.log("\n=== 7) card_cast 错误路径 ===");
let e1 = null;
try { await T("card_cast").execute({ members: [] }, {}); } catch (e) { e1 = e; }
t("空 members 报错", e1 !== null);
let e2 = null;
try { await T("card_cast").execute({ members: Array.from({ length: 20 }, (_, i) => ({ fullPath: `a/b${i}` })) }, {}); } catch (e) { e2 = e; }
t("超过 12 人报错", e2 !== null && /12/.test(e2.message), String(e2?.message));
let e3 = null;
try { await T("card_cast").execute({ members: [{ fullPath: "definitely/not-a-real-card-xyz" }] }, {}); } catch (e) { e3 = e; }
t("全部取卡失败时报错（不静默返回空阵容）", e3 !== null, String(e3?.message).slice(0, 70));

if (usable.length > 0) {
	const partial = await T("card_cast").execute(
		{ members: [{ fullPath: "definitely/not-real-xyz" }, { fullPath: usable[0].fullPath }] },
		{},
	);
	t("部分失败仍返回成功的成员", partial.ok === true && partial.count === 1);
	t("并列出失败项", Array.isArray(partial.failed) && partial.failed.length === 1);
	console.log(`      失败项: ${JSON.stringify(partial.failed)}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
