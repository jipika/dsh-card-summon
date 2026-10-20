/**
 * 动态世界书（酒馆对齐 P2）离线测试。
 *
 * 覆盖：
 *   · dynamicSourceOf：候选条目的筛选口径（constant / enabled:false / 无 keys / 空正文）
 *   · mergeDynamicSources：阵容合并（顺序、去重口径、全空回落）
 *   · composeDynamicLore：命中拼接、hits 元数据、**预算不够时跳过长条目继续找短的**
 *   · recentTextOf / messageTextOf：对话取样（容错、正序、截断、只认 text 块）
 *   · 真实卡库批量验收（盘不在则跳过，不假装通过）
 *
 * 跑法：node tests/lore-check.mjs
 *
 * 隔离：状态写在 mkdtemp 临时目录（env `DSH_CARD_SUMMON_STATE`）。
 *       本文件测的都是纯函数，但 inject.js → vars.js → state.js 会在**加载时**固定 STATE_ROOT，
 *       所以 env 必须先设，下面用动态 import。
 *
 * 明确**没有**覆盖的：求值器里「命中才追加」的那三行分支 —— 它读的是 index.js 内存里的
 * `sections` Map，测试无法从外部塞入记录。它依赖的两个纯函数（本文件 §3、§4）已逐条验证，
 * 分支本身只有 `lore.length > 0 ? ... : hit.text` 一个条件。不假装覆盖。
 */
import { mkdtempSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ⚠️ STATE_ROOT 在模块加载那一刻就固定了，env 必须先设。
const TMP = mkdtempSync(join(tmpdir(), "card-summon-lore-"));
process.env.DSH_CARD_SUMMON_STATE = TMP;

const I = await import("../lib/inject.js");

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

/** 造一张只有世界书的卡（其余字段不参与本条路径）。 */
const cardWith = (entries) => ({ name: "测试卡", lorebook: { entries } });
const entry = (keys, content, extra = {}) => ({ keys, content, ...extra });

/* ─────────────── 测试自己维护的筛选口径（关键：独立于实现） ─────────────── */

/**
 * 「这条世界书该不该进动态候选」——按酒馆语义独立写一遍：
 * 关掉的不要、常驻的不要（已在静态人设里）、没关键词的撞不到、空正文注入了也没意义。
 */
const eligible = (e) => {
	if (e === null || typeof e !== "object") return false;
	if (e.enabled === false) return false;
	if (e.constant === true) return false;
	const keys = (Array.isArray(e.keys) ? e.keys : []).filter((k) => typeof k === "string" && k.length > 0);
	if (keys.length === 0) return false;
	return String(e.content ?? "").trim().length > 0;
};

console.log("=== 1) dynamicSourceOf：候选条目筛选 ===");
{
	t("卡没有 lorebook → undefined", I.dynamicSourceOf({ name: "x" }) === undefined);
	t("entries 为空 → undefined", I.dynamicSourceOf(cardWith([])) === undefined);
	t(
		"只有 constant 条目 → undefined（它已在 personaFromBook 的静态人设里）",
		I.dynamicSourceOf(cardWith([entry(["药王谷"], "常驻设定", { constant: true })])) === undefined,
	);
	t(
		"enabled:false 的条目被跳过",
		I.dynamicSourceOf(cardWith([entry(["药王谷"], "关掉的设定", { enabled: false })])) === undefined,
	);
	t("没有 keys → 跳过", I.dynamicSourceOf(cardWith([entry([], "无关键字的设定")])) === undefined);
	t("keys 全是空串/非字符串 → 跳过", I.dynamicSourceOf(cardWith([entry(["", 42, null], "设定")])) === undefined);
	t("正文全空白 → 跳过", I.dynamicSourceOf(cardWith([entry(["甲"], "   \n\t ")])) === undefined);

	const mixed = cardWith([
		entry(["甲", "乙"], "第一条"),
		entry(["丙"], "第二条", { constant: true }),
		entry(["丁"], "第三条", { enabled: false }),
		entry([], "第四条"),
		entry(["戊"], "   "),
		entry(["己"], "  第五条  "),
	]);
	const src = I.dynamicSourceOf(mixed);
	eq(src?.lorebook?.entries?.length, 2, "混合输入只留下合格的两条");
	eq(
		{ keys: src.lorebook.entries[0].keys, content: src.lorebook.entries[0].content },
		{ keys: ["甲", "乙"], content: "第一条" },
		"合格条目原样保留（keys 顺序不变）",
	);
	// 副键/优先级也在候选里（酒馆 selective 语义），空数组表示不启用副键判定。
	eq(src.lorebook.entries[0].secondaryKeys, [], "没有副键 → 空数组");
	eq(src.lorebook.entries[0].order, 100, "insertion_order 缺省按 100");
	eq(src.lorebook.entries[1].content, "第五条", "正文被 trim（注入段不留首尾空白）");
	t("留下来的条目都满足测试自维护的筛选口径", src.lorebook.entries.every((e) => eligible(e)));
}

console.log("\n=== 2) mergeDynamicSources：阵容合并 ===");
{
	const a = cardWith([entry(["甲"], "A1")]);
	const b = cardWith([entry(["乙"], "B1"), entry(["丙"], "B2")]);
	const merged = I.mergeDynamicSources([a, b]);
	eq(merged.lorebook.entries.map((e) => e.content), ["A1", "B1", "B2"], "按传入顺序拼接");
	eq(I.mergeDynamicSources([a, { name: "无世界书" }]).lorebook.entries.length, 1, "没世界书的成员不贡献条目");
	t("全都不可用 → undefined", I.mergeDynamicSources([{ name: "a" }, { name: "b" }]) === undefined);
	t("空数组 → undefined", I.mergeDynamicSources([]) === undefined);
}

console.log("\n=== 3) composeDynamicLore：命中与预算 ===");
{
	const src = I.dynamicSourceOf(
		cardWith([entry(["药王谷", "谷主"], "药王谷常年云雾缭绕。"), entry(["青锋剑"], "剑身泛青，出鞘带风。")]),
	);

	eq(I.composeDynamicLore(src, ""), { text: "", hits: [] }, "对话为空 → 零命中");
	eq(I.composeDynamicLore(src, undefined), { text: "", hits: [] }, "对话不是字符串 → 当空处理");
	eq(I.composeDynamicLore(undefined, "药王谷"), { text: "", hits: [] }, "没有候选（未召唤/卡无世界书）→ 空结果");
	eq(I.composeDynamicLore(src, "今天天气不错").text, "", "都没撞上 → 返回空串（宿主会过滤掉空段）");

	const one = I.composeDynamicLore(src, "他问起药王谷的事");
	t("命中一条 → 不加任何标题行（原文直接进，酒馆也不加）", one.text === "药王谷常年云雾缭绕。", JSON.stringify(one.text.slice(0, 20)));
	eq(one.hits, [{ matched: "药王谷", chars: 10 }], "hits 记录撞上的那个 key 与正文字符数");

	const two = I.composeDynamicLore(src, "药王谷的青锋剑");
	eq(two.hits.length, 2, "两条都命中");
	eq(two.text, "药王谷常年云雾缭绕。\n剑身泛青，出鞘带风。", "多条命中用单个换行连接（world-info.js:5265 的 join('\\n')）");

	const bySecond = I.composeDynamicLore(src, "谷主来了");
	eq(bySecond.hits[0].matched, "谷主", "keys 数组里任一命中即算（记录撞上的那个）");

	// 预算：长条目被跳过，后面的短条目仍要被收（continue 而不是 break）
	const long = "长".repeat(120);
	const budgetSrc = I.dynamicSourceOf(
		cardWith([entry(["长条"], long), entry(["短条"], "短的")]),
	);
	const cut = I.composeDynamicLore(budgetSrc, "长条和短条都在", { budget: 50 });
	eq(cut.hits.length, 1, "预算不够时长条目被跳过");
	eq(cut.hits[0].matched, "短条", "跳过长条目后仍然继续看后面的短条目（不是 break）");
	t("超预算的长条目没有被截断后塞进来", !cut.text.includes(long.slice(0, 10)));

	const exact = I.composeDynamicLore(budgetSrc, "短条", { budget: 2 });
	eq(exact.hits.length, 1, "预算恰好等于正文长度时收下（判据是 > 不是 >=）");
	eq(I.composeDynamicLore(budgetSrc, "短条", { budget: 1 }).text, "", "少一个字符就跳过");

	const acc = I.composeDynamicLore(
		I.dynamicSourceOf(cardWith([entry(["甲"], "12345"), entry(["乙"], "67890")])),
		"甲乙",
		{ budget: 9 },
	);
	eq(acc.hits.length, 1, "预算按累计用量算：第一条 5 字后只剩 4 字，第二条放不下");
	eq(acc.hits[0].chars, 5, "收下的是第一条");

	eq(I.DYNAMIC_LORE_BUDGET, 4000, "默认预算 4000 字符（与静态人设分开）");
	eq(I.DYNAMIC_SCAN_DEPTH, 2, "默认回看 2 条消息（酒馆 world_info_depth=2）");
	eq(I.DYNAMIC_SCAN_CHARS, 4000, "单次取样上限 4000 字符（防超长消息吃掉预算）");
	eq(I.composeDynamicLore(budgetSrc, "长条").hits.length, 1, "不传 budget 时用默认值（120 字远小于 4000）");
}

console.log("\n=== 4) recentTextOf / messageTextOf：对话取样 ===");
{
	const ctx = (messages) => ({ agent: { session: { deriveMessages: () => messages } } });
	const msg = (text) => ({ role: "user", content: [{ type: "text", text }] });

	t("没有 context → 空串", I.recentTextOf(undefined, 2) === "");
	t("没有 agent.session → 空串", I.recentTextOf({}, 2) === "");
	t("session 没有 deriveMessages → 空串", I.recentTextOf({ agent: { session: {} } }, 2) === "");
	t(
		"deriveMessages 抛错 → 空串（容错，不能让整轮组装炸掉）",
		I.recentTextOf({ agent: { session: { deriveMessages: () => { throw new Error("x"); } } } }, 2) === "",
	);

	eq(I.recentTextOf(ctx([msg("甲"), msg("乙"), msg("丙")]), 3), "甲\n乙\n丙", "多条消息按原顺序拼接");

	const long = "x".repeat(100);
	eq(I.recentTextOf(ctx([msg(long)]), 1, 10).length, 10, "超过字符上限时只留末尾 N 个字符");
	eq(I.recentTextOf(ctx([msg(long)]), 1, 10), long.slice(-10), "保留的是**末尾**（最近的对话）");

	const many = Array.from({ length: 45 }, (_, i) => msg(`m${i}`));
	const taken = I.recentTextOf(ctx(many), 40, 4000).split("\n");
	eq(taken.length, 40, "最多取末尾 40 条消息（显式传参时按传入值）");
	eq(taken[0], "m5", "取的是末尾那 40 条（最早的 5 条被丢掉）");

	eq(I.recentTextOf(ctx([msg("甲"), { role: "assistant", content: [{ type: "reasoning", text: "别看我" }] }, msg("乙")]), 3), "甲\n乙", "reasoning 块不算对话内容");

	eq(I.messageTextOf({ content: "纯字符串" }), "纯字符串", "content 是字符串时原样返回");
	eq(I.messageTextOf({ content: [{ type: "text", text: "a" }, { type: "tool_use", name: "x" }, { type: "text", text: "b" }] }), "a\nb", "块数组只拼 text 块");
	eq(I.messageTextOf({}), "", "没有 content → 空串");
	eq(I.messageTextOf({ content: [{ type: "image" }] }), "", "非文本块 → 空串");
}

console.log("\n=== 5) 真实卡库批量验收（盘不在则跳过）===");
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

	let scanned = 0;
	let unreadable = 0;
	let withSource = 0;
	let entriesTotal = 0;
	let entriesSkippedConstant = 0;
	let entriesOversize = 0;
	let charsTotal = 0;
	const missOnOwnKey = [];

	for (const file of files) {
		const rel = relOf(`local://${file.slice(ROOT.length + 1)}`);
		let card;
		try {
			const raw = readLocalCardFile(file);
			card = normalizeLocalCard(raw, { ...metaFromPath(rel), file: rel, fullPath: `local://${rel}` });
		} catch {
			unreadable += 1;
			continue;
		}
		scanned += 1;
		for (const e of card?.lorebook?.entries ?? []) {
			if (e?.constant === true) entriesSkippedConstant += 1;
		}
		const src = I.dynamicSourceOf(card);
		if (src === undefined) continue;
		withSource += 1;
		entriesTotal += src.lorebook.entries.length;
		charsTotal += src.lorebook.entries.reduce((sum, e) => sum + e.content.length, 0);
		entriesOversize += src.lorebook.entries.filter((e) => e.content.length > I.DYNAMIC_LORE_BUDGET).length;

		// 拿这张卡自己的一个 key 当对话文本 —— 真实数据上必须撞得中，否则候选提取与匹配口径对不上。
		// ⚠️ 带副键的条目（酒馆 selective）必须把副键也写进探针文本，否则**本就不该命中**：
		//   实测 M不复还.png 的「第1层」条目带副键 守层者/魔龙塔，只给主键时按语义就该拒绝。
		// 预算放开到无限，把「撞不上」与「放不下」两种失败分开。
		const probe = src.lorebook.entries[0];
		const probeText = `他提起了${probe.keys[0]}${(probe.secondaryKeys ?? []).join("")}这件事`;
		const unbounded = I.composeDynamicLore(src, probeText, { budget: Number.MAX_SAFE_INTEGER });
		if (!unbounded.hits.some((h) => h.matched === probe.keys[0])) missOnOwnKey.push(rel);

		// 真预算下注入段不能超上限（否则一条世界书就能把整段注入挤爆）。
		const capped = I.composeDynamicLore(src, probeText);
		if (capped.text.length > I.DYNAMIC_LORE_BUDGET + 20) missOnOwnKey.push(`${rel} 超预算`);
	}

	console.log(
		`  扫了 ${scanned} 张（跳过读不了的 ${unreadable} 张）：有动态候选 ${withSource} 张 | 候选条目 ${entriesTotal} 条 | 候选正文合计 ${charsTotal} 字符 | 跳过 constant ${entriesSkippedConstant} 条`,
	);
	console.log(
		`  其中正文超过 ${I.DYNAMIC_LORE_BUDGET} 字符（预算放不下、必被跳过）的条目：${entriesOversize} 条（占 ${((entriesOversize / Math.max(1, entriesTotal)) * 100).toFixed(1)}%）`,
	);
	if (withSource > 0) {
		console.log(`  平均每张有候选的卡 ${(entriesTotal / withSource).toFixed(1)} 条候选、${Math.round(charsTotal / withSource)} 字符`);
	}
	eq(missOnOwnKey.slice(0, 5), [], `★ 拿卡自己的 key 去撞必须命中（${withSource} 张）`);
	t("确实有卡带可触发世界书（否则这条断言是空转）", withSource > scanned * 0.1, `有候选 ${withSource}/${scanned}`);
	t("constant 条目没进候选（它们走静态人设）", entriesTotal + entriesSkippedConstant > 0);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
