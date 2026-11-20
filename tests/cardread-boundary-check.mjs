/**
 * 边界回归：有召唤的会话里，模型**只能**读到注入段。
 *
 * 事故背景（2026-11-03，会话 943fa015）：
 *   注入段里写着「这些常驻条目被预算丢掉，请用 card_read 取回」。模型照做 → card_read
 *   读的是召唤时落盘的**原卡快照**，绕过 markdownize 转换层 → 拿到作者的
 *   `<details><summary>主控角色状态</summary>` 面板与 `<customize_cot>` 协议 →
 *   回复直接复刻卡作者的原始输出格式（DSH 不解析 HTML，这些标签会裸文本显示）。
 *
 * 本测试锁死四条行为：
 *   ① 有召唤 → card_read 只返回注入段，且注入段里不含未注入内容（备选开场白等）；
 *   ② 有召唤 → 按字段名读原卡、读别的卡，一律报错；
 *   ③ card_inject_more 只回执，正文不进工具结果，但确实进了注入段；
 *   ④ 补注入的内容同样经过转换（不许把作者的标签模板原样带回来）。
 *
 * 跑法：node tests/cardread-boundary-check.mjs   （离线，不联网）
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 测试隔离：所有状态写进临时目录（state.js 在 import 时读这个变量）。
const ROOT = mkdtempSync(join(tmpdir(), "card-summon-boundary-"));
process.env.DSH_CARD_SUMMON_STATE = ROOT;

const SESSION_ID = "boundary-probe";

let pass = 0;
let fail = 0;
const t = (label, ok, extra = "") => {
	if (ok) {
		pass += 1;
		console.log(`  ✓ ${label}`);
	} else {
		fail += 1;
		console.log(`  ✗ ${label}${extra ? ` —— ${extra}` : ""}`);
	}
};

/* ── 造一张「内容超过预算 + 带作者模板」的卡快照 ── */
const template = (title, body) => `<details><summary>${title}</summary>\n${body}\n</details>`;
const constantEntry = (label, len, order = 100) => ({
	comment: label,
	constant: true,
	enabled: true,
	insertion_order: order,
	content: template(label, `${label}正文` + "设".repeat(len)),
});

const CARD = {
	source: "local",
	fullPath: "test/boundary",
	creator: "test",
	slug: "boundary",
	name: "边界测试卡",
	// personality 为空 → 走 personaDerived（本地卡的主路径）
	personality: "",
	personaDerived: "人设正文：这是一张用来验证注入边界的测试卡。".repeat(6),
	// 预算丢掉的那条：**故意不带 body**（复刻 2026-11-03 之前落盘的老快照）——
	// 注入层必须按 comment 回世界书里捞正文，否则老卡永久补不进来。
	personaDerivedDropped: [{ label: "状态栏", chars: 240, order: 100 }],
	description: "",
	scenario: "",
	firstMessage: "开场白：从黄昏的星见市开始。",
	exampleDialogs: "",
	alternateGreetings: [template("备用开场", "这段永远不该出现在注入段里")],
	systemPrompt: "",
	postHistoryInstructions: "",
	lorebook: {
		entries: [
			constantEntry("长设定", 2600),
			constantEntry("第二设定", 900),
			constantEntry("状态栏", 220),
		],
	},
	tags: [],
};

const cardsDir = join(ROOT, "cards");
mkdirSync(cardsDir, { recursive: true });
writeFileSync(join(cardsDir, `${SESSION_ID}.json`), JSON.stringify(CARD, null, 1));
writeFileSync(
	join(ROOT, "summons.json"),
	JSON.stringify({ [SESSION_ID]: { fullPath: CARD.fullPath, name: CARD.name, at: new Date().toISOString() } }, null, 1),
);

/* ── 假宿主：注册工具 / 收集 section 求值器 ── */
const agentOf = (id) => ({ sessionId: id, session: { header: { id } } });
const makeHost = () => {
	const box = { tools: {}, sections: {} };
	const ctx = {
		effect: (f) => {
			const d = f();
			return typeof d === "function" ? d : () => {};
		},
		on: () => () => {},
		systemPrompt: {
			section: (desc) => {
				box.sections[desc.name] = desc;
				return () => {};
			},
			context: (desc) => {
				box.sections[desc.name] = desc;
				return () => {};
			},
		},
		tools: {
			register: (desc) => {
				box.tools[desc.name] = desc;
				return () => {};
			},
		},
		webServer: { register: () => () => {} },
		agents: { currentInitiator: () => agentOf(SESSION_ID) },
	};
	return { box, ctx };
};

const host = makeHost();
const registered = host.box;
const mod = await import("../index.js");
await mod.apply(host.ctx, {});
const T = (name) => {
	const tool = registered.tools[name];
	if (tool === undefined) throw new Error(`工具 ${name} 未注册`);
	return tool;
};
const evalSection = (name) =>
	registered.sections[name]?.text({ agent: { session: { header: { id: SESSION_ID } } } }) ?? "";

console.log("\n=== 1) 有召唤：card_read 只回注入段 ===");
const read = T("card_read");
const r1 = await read.execute({ maxChars: 60_000 }, {});
t("mode=injected（不是原卡）", r1.mode === "injected", `实得 ${r1.mode}`);
t("返回正文里有注入的人设", r1.text.includes("用来验证注入边界的测试卡"));
t("不含未注入的备选开场白", !r1.text.includes("备用开场"));
t("不含作者模板 <details>", !r1.text.includes("<details"), "转换层被绕过");
t("chars 与整段长度一致", r1.chars === (await read.execute({ maxChars: 60_000 }, {})).chars && r1.chars > 0);
t("账本里还有待补注入的条目", r1.supplement?.pendingItems > 0, JSON.stringify(r1.supplement));

console.log("\n=== 2) 绕道读取全部被拒 ===");
let fErr = null;
try {
	await read.execute({ field: "lorebook" }, {});
} catch (error) {
	fErr = error;
}
t("按字段读原卡 → 报错", fErr !== null && /注入段|card_inject_more/.test(fErr.message), String(fErr?.message).slice(0, 60));

let oErr = null;
try {
	await read.execute({ fullPath: "someone/else" }, {});
} catch (error) {
	oErr = error;
}
t("读别的卡 → 报错", oErr !== null && /已召唤/.test(oErr.message), String(oErr?.message).slice(0, 60));

let cErr = null;
try {
	await T("card_cast").execute({ members: [{ fullPath: CARD.fullPath }] }, {});
} catch (error) {
	cErr = error;
}
t("card_cast 只读模式 → 报错（第二条回原文的通道）", cErr !== null, String(cErr?.message).slice(0, 60));

console.log("\n=== 3) 分批补注入：只回执，正文走注入段 ===");
const more = await T("card_inject_more").execute({}, {});
const receipt = JSON.stringify(more);
t("回执 ok", more.ok === true);
t("列出注入的条目名", Array.isArray(more.added) && more.added.includes("状态栏"), JSON.stringify(more.added));
t("回执里没有正文（只有账）", !receipt.includes("设".repeat(30)), "正文泄进了工具结果");
t("记录剩余条数", typeof more.remainingItems === "number");

const r2 = await read.execute({ maxChars: 80_000 }, {});
t("补注入的正文进了注入段", r2.text.includes("补充设定 · 第 1 批") && r2.text.includes("状态栏正文"));
t("补注入内容同样被转成 Markdown（无 <details>）", !r2.text.includes("<details"));
t("账本剩余条数下降", (r2.supplement?.pendingItems ?? 99) < (r1.supplement?.pendingItems ?? 0) + 1);

const more2 = await T("card_inject_more").execute({}, {});
if (more.remainingItems > 0) {
	t("再调一次会继续注入", more2.added.length > 0, JSON.stringify(more2));
} else {
	t("已无待注入内容时如实说明", more2.added.length === 0 && /全部注入/.test(more2.note ?? ""), JSON.stringify(more2));
}

console.log("\n=== 4) 注入段（真正进上下文的 section）同步更新 ===");
const extended = evalSection("dsh-card-summon:extended");
t("extended 槽有内容", extended.includes("补充设定 · 第 1 批"), extended.slice(0, 40));
t("extended 槽没有标签模板", !extended.includes("<details>"));
const note = evalSection("dsh-card-summon:note");
t("账务槽不再邀请 card_read", !note.includes("card_read"), note.slice(0, 80));
t("账务槽改指 card_inject_more", note === "" || note.includes("card_inject_more"), note.slice(0, 80));

console.log("\n=== 5) 重启：已补注入的正文不丢、也不重复 ===");
{
	// 换一个模块实例（URL 加 query，state.js 会重新从盘上读）→ 走 apply() 的恢复路径
	const host2 = makeHost();
	const mod2 = await import("../index.js?restart=1");
	await mod2.apply(host2.ctx, {});
	const r3 = await host2.box.tools.card_read.execute({ maxChars: 80_000 }, {});
	t("重启后注入段仍在", r3.mode === "injected" && r3.text.length > 0);
	t("重启后补注入的正文还在", r3.text.includes("补充设定 · 第 1 批"));
	t("只出现一次（没有叠加两遍）", (r3.text.match(/补充设定 · 第 1 批/g) ?? []).length === 1);
	t("重启后账本进度一致", r3.supplement?.batch === more.batch, JSON.stringify(r3.supplement));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
