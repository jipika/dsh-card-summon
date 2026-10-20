/**
 * 世界书常驻条目的注入预算回归闸（2026-10-15 修复）。
 *
 * 症状：一张 6 条常驻（共 12749 字）的卡，注入进会话的只有 2 条完整 + 第 3 条 308 字，
 * 「主角本人的人设」与「文风语料库」整条不见 —— 模型于是按缺失的人设自由发挥
 * （用户侧表现为「角色演偏了」，且没有任何报错）。
 *
 * 根因（lib/local.js 原 personaFromBook）：预算 6000 太小 + 超预算时
 * `body.slice(0, room) + "…"` 句中硬切 + `break` 丢弃后续全部条目；
 * 而排序按 insertion_order，主角条目 order=101 恰好排在最后。
 *
 * 本测试锁死三条行为：
 *   ① 预算充足 → 常驻条目全进，dropped 为空；
 *   ② 预算不足 → **整条跳过**（绝不出现半句话的设定），且不计入 text；
 *   ③ 被跳过的条目必须出现在 personaDerivedDropped 里，并在注入段显式告知模型。
 */
import { normalizeLocalCard } from "../lib/local.js";
import { composeSummon } from "../lib/inject.js";

let pass = 0;
let fail = 0;
function t(name, ok, extra = "") {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.log(`  ✗ ${name}${extra ? ` —— ${extra}` : ""}`);
	}
}

const mkEntry = (comment, order, len) => ({
	comment,
	insertion_order: order,
	constant: true,
	enabled: true,
	content: `${comment}｜` + "设".repeat(len),
});

// 6 条常驻，order 故意把「主角本人」排在最后（复刻真实卡：瑞希条目 order=101 排末位）
const entries = [
	mkEntry("防极端化规则", 50, 2300),
	mkEntry("丈夫设定", 100, 3300),
	mkEntry("背德螺旋", 100, 1400),
	mkEntry("文风语料库", 100, 2100),
	mkEntry("格式规则", 100, 500),
	mkEntry("主角人设", 101, 2900), // ← 旧实现下被整条丢弃
];
const TOTAL = entries.reduce((n, e) => n + e.content.length, 0);

const build = (budget) =>
	normalizeLocalCard(
		{ data: { name: "测试卡", description: "", personality: "", character_book: { entries } } },
		{ fullPath: "test/budget", file: "budget.png", maxBookPersona: budget },
	);

console.log(`\n样本：6 条常驻，合计 ${TOTAL} 字（旧的硬编码预算是 6000）`);

console.log("\n=== ① 预算充足：全进 ===");
{
	const card = build(100_000);
	const text = card.personaDerived;
	t("personaDerived 是字符串（不是对象）", typeof card.personaDerived === "string", `实得 ${typeof card.personaDerived}`);
	t("personaDerivedDropped 是数组", Array.isArray(card.personaDerivedDropped));
	t("6 条全部注入", entries.every((e) => text.includes(e.comment)), `命中 ${entries.filter((e) => text.includes(e.comment)).length}/6`);
	t("dropped 为空", card.personaDerivedDropped.length === 0, `实得 ${card.personaDerivedDropped.length}`);
	t("无句中硬切残留", !text.includes("…") && !/…\s*$/.test(text));
}

console.log("\n=== ② 预算不足：整条跳过，绝不半句 ===");
{
	const budget = 5000;
	const card = build(budget);
	const text = card.personaDerived;
	const kept = entries.filter((e) => text.includes(e.comment));
	console.log(`  预算 ${budget} → 注入 ${kept.length}/6 条，长度 ${text.length}，dropped ${card.personaDerivedDropped.length} 条`);
	console.log(`  保留: ${kept.map((e) => e.comment).join("、") || "（无）"}`);
	console.log(`  丢弃: ${card.personaDerivedDropped.map((d) => d.label).join("、") || "（无）"}`);

	t("不是全进（预算确实生效）", kept.length < entries.length);
	t("**主角人设被整条跳过**（旧实现在此丢的是它）", !text.includes("主角人设"));
	t("被丢条目记入 dropped", card.personaDerivedDropped.some((d) => d.label === "主角人设"));
	t("dropped 条目带字数（可诊预算）", card.personaDerivedDropped.every((d) => Number.isFinite(d.chars) && d.chars > 0));
	// 核心：不得出现「保留条目的片段」——半句话的设定比没有更坏
	const anyTruncated = card.personaDerivedDropped.some((d) => {
		const frag = d.label;
		return text.includes(frag) === false && text.trimEnd().endsWith("…");
	});
	t("text 不以省略号结尾（无句中硬切）", !text.trimEnd().endsWith("…"), text.slice(-20));
	t("每个写入 text 的条目都是完整的", entries.filter((e) => text.includes(e.comment)).every((e) => text.includes(e.content)), `截断检测=${anyTruncated}`);
}

console.log("\n=== ③ 注入段显式告知模型「哪些常驻设定没进来」===");
{
	const card = build(5000);
	const { text, truncatedFields } = composeSummon(card, { maxPersonality: 12_000 });
	t("注入段出现未纳入提示", text.includes("因注入预算未纳入"), text.slice(0, 80));
	t("提示里点名了被丢条目", text.includes("主角人设"));
	t("提示要求 card_read 取回", text.includes("card_read"));
	t("truncatedFields 记录了 dropped 条数", truncatedFields.some((f) => f.startsWith("personaDerived.dropped")), JSON.stringify(truncatedFields));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
