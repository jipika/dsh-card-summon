/**
 * 本地卡库源验证（PNG 卡 + 索引 + 多维度筛选）。
 *
 * 依赖外置盘挂载。盘不在时**跳过并说明原因**（不假装通过）。
 *
 * 背景（决定断言怎么写的实测结论）：
 *   · PNG 里 `chara`/`ccv3` 两个 tEXt chunk，内容是 **base64 编码的 JSON**
 *   · chunk 在文件 95%–98% 处 → 只读尾部即可；自适应窗口 256KB 起，A/B 实测 300/300 一致
 *   · **字段映射与 Chub 相反**：`personality` 100% 为空，人设主体在 `description`
 *   · **48.4% 的卡 personaLen=0**，内容在「开场白 + 世界书常驻条目」里
 *   · 分类来自目录名（32 个），不是卡内 tags
 *
 * 跑法：node tests/local-check.mjs
 */
import { existsSync, statSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
	INDEX_VERSION as INDEX_VERSION_EXPECTED,
	buildLocalIndex,
	isLocalRef,
	loadLocalIndex,
	localRef,
	queryLocalIndex,
	readLocalCardFile,
	normalizeLocalCard,
	relOf,
	extractFileTags,
	metaFromPath,
} from "../lib/local.js";
import { composeSummon, composeCast } from "../lib/inject.js";
import { markdownizeText } from "../lib/markdownize.js";

let pass = 0;
let fail = 0;
const t = (label, cond, extra = "") => {
	if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
	else { fail += 1; console.log(`  ✗ ${label} ${extra}`); }
};

const ROOT = "/Volumes/mac/下载/26.6角色卡/26.7月全中文备注角色卡（14000➕）";
if (!existsSync(ROOT)) {
	console.log(`⊘ 跳过：本地卡库不可访问（外置盘未挂载？）\n  ${ROOT}`);
	process.exit(0);
}

console.log("=== 1) ref 辅助（纯逻辑，无 IO）===");
t("localRef 生成前缀", localRef("a/b.png") === "local://a/b.png");
t("isLocalRef 识别", isLocalRef("local://x") === true);
t("isLocalRef 拒绝 chub 路径", isLocalRef("creator/slug") === false);
t("relOf 剥前缀", relOf("local://a/b.png") === "a/b.png");

console.log("\n=== 2) 路径 → 分类推导（含实测踩过的坑）===");
const m1 = metaFromPath("2025-11-19/已分类/修仙/x.png");
t("已分类/<分类> 正确", m1.category === "修仙" && m1.classified === true && m1.month === "2025-11-19");
const m2 = metaFromPath("2025-11-19/未分类/x.png");
t("未分类目录", m2.category === "未分类" && m2.classified === false);
// ★ 这个分支是实测发现的：4400 张卡在月份根目录平铺，原来会得到 category=null
const m3 = metaFromPath("6-7月/x.png");
t("**月份根目录平铺 → 归为「未分类」而不是 null**", m3.category === "未分类" && m3.classified === false);

console.log("\n=== 3) 文件名标签抽取（实测两种写法混用）===");
t("配对式 #同人#动物森友会#", JSON.stringify(extractFileTags("#同人#动物森友会#.png")) === '["同人","动物森友会"]');
const ft = extractFileTags("铁与深 #蒸汽朋克 #猎魔人#仪式神秘学.png");
t("混用式抽取非空", ft.length >= 2, JSON.stringify(ft));
t("无标签返回空数组", extractFileTags("逆转.png").length === 0);

console.log("\n=== 4) 读真实卡（PNG 尾部 + base64）===");
const idx = loadLocalIndex();
if (idx === null) {
	console.log("  ⊘ 索引不存在或版本已失效，只跑冒烟扫描（下面的筛选/排序断言全部跳过）");
	const built = await buildLocalIndex(ROOT);
	t("能扫出卡", built.entries.length > 1000, `实得 ${built.entries.length}`);
	t("新建索引带着 dynEntries 字段", typeof built.entries[0]?.dynEntries === "number", `实得 ${built.entries[0]?.dynEntries}`);
	console.log("  ⚠️ 这只验证了「扫得出卡」，没有覆盖筛选/排序 —— 请跑一次 card_local_scan 落盘后再跑本文件");
	process.exit(fail === 0 ? 0 : 1);
}
console.log(`  索引：${idx.entries.length} 张，版本 v${idx.version}`);
t("索引有卡", idx.entries.length > 1000);
t("索引版本匹配（应等于模块导出的 INDEX_VERSION）", idx.version === INDEX_VERSION_EXPECTED, `实得 ${idx.version}，期望 ${INDEX_VERSION_EXPECTED}`);

// 挑一张真实卡读通
const sampleEntry = idx.entries.find((e) => e.personaLen > 500) ?? idx.entries[0];
const abs = join(ROOT, sampleEntry.rel);
const parsed = readLocalCardFile(abs);
t("读到了卡数据", parsed !== undefined && parsed.raw !== undefined);
t("用的是 ccv3 或 chara", parsed.kw === "ccv3" || parsed.kw === "chara");
const card = normalizeLocalCard(parsed, { ...metaFromPath(sampleEntry.rel), file: abs, fullPath: localRef(sampleEntry.rel) });
t("卡名非空", card.name.length > 0, `实得 ${JSON.stringify(card.name)}`);
t("source=local", card.source === "local");
t("与内部模型同构（有 personality/firstMessage/lorebook）",
	"personality" in card && "firstMessage" in card && "lorebook" in card);

console.log("\n=== 5) 字段映射：personality 为空时用世界书兜底 ===");
const zeroPersona = idx.entries.filter((e) => e.personaLen === 0 && e.bookEntries >= 20);
console.log(`  人设=0 且世界书>=20条 的卡：${zeroPersona.length} 张`);
t("存在这样的卡（实测占 48.4% 的大类）", zeroPersona.length > 0);
if (zeroPersona.length > 0) {
	const e = zeroPersona[0];
	const p2 = readLocalCardFile(join(ROOT, e.rel));
	const c2 = normalizeLocalCard(p2, { ...metaFromPath(e.rel), file: e.rel, fullPath: localRef(e.rel) });
	t("personality 保持忠实（空）", c2.personality.length === 0);
	t("personaDerived 兜底非空", (c2.personaDerived ?? "").length > 0, `实得 ${(c2.personaDerived ?? "").length}`);
	const out = composeSummon(c2, {});
	t("注入段不为空", out.text.length > 0);
	t("**不再出现「没有给出 personality」警告**", !out.text.includes("没有给出 personality"));
	// 酒馆里人设字段为空时，模型看到的就是常驻条目原文，没有「摘自世界书」这类旁白 ——
	// 旁白会把"作者设定"降级成"系统说明"。所以契约是：persona 槽等于转换后的条目原文
	//（注入前转换层会把标签/状态栏改写成 Markdown，其余内容不变）。
	t("persona 槽直接是常驻条目原文（不加旁白）", out.slots.persona === markdownizeText(c2.personaDerived ?? "").trim());
	t("不再有人设旁白「摘自卡内世界书」", !out.text.includes("摘自卡内世界书"));
}

console.log("\n=== 6) 多维度筛选 ===");
const all = queryLocalIndex(idx, { limit: 1 });
console.log(`  全库 ${all.total} 张 | 分类 ${Object.keys(all.facets.categories).length} 个`);
t("总数 = 索引条目数", all.total === idx.entries.length);
t("分类数 > 20（实测 32 个已分类 + 未分类）", Object.keys(all.facets.categories).length > 20);
t("facets 里有月份", Object.keys(all.facets.months).length > 0);
t("facets 里有世界书统计", typeof all.facets.lorebook.true === "number");

const q1 = queryLocalIndex(idx, { categories: ["修仙"] });
t("单维：分类筛选命中", q1.total > 0 && q1.total < all.total, `${q1.total}`);
const q2 = queryLocalIndex(idx, { categories: ["修仙"], minContent: 50000 });
t("叠加：分类 + 内容量", q2.total > 0 && q2.total <= q1.total, `${q2.total} <= ${q1.total}`);
const q3 = queryLocalIndex(idx, { categories: ["修仙"], minContent: 50000, minBookEntries: 50 });
t("再叠加：世界书条目数", q3.total <= q2.total, `${q3.total} <= ${q2.total}`);
const q4 = queryLocalIndex(idx, { hasLorebook: true });
const q5 = queryLocalIndex(idx, { hasLorebook: false });
t("布尔维度：有/无世界书之和 = 总数", q4.total + q5.total === all.total);
const q6 = queryLocalIndex(idx, { keyword: "zzzz不存在的词zzzz" });
t("关键词无命中 → 0", q6.total === 0);
const q7 = queryLocalIndex(idx, { sort: "contentDesc", limit: 5 });
t("排序：内容最多在前", q7.items[0].contentLen >= q7.items[q7.items.length - 1].contentLen);
t("分页 limit 生效", q7.items.length === 5);
// ── dynEntries：可触发世界书条目数（P2 的 keys 触发用得上几条）──
t("索引条目都带 dynEntries（number）", idx.entries.every((e) => typeof e.dynEntries === "number"));
t("dynEntries 是 bookEntries 的子集（不可能多于总条目）", idx.entries.every((e) => (e.dynEntries ?? 0) <= (e.bookEntries ?? 0)));
const qd1 = queryLocalIndex(idx, { minDynEntries: 3, limit: 50 });
t("minDynEntries 筛选生效（每条都 ≥ 3）", qd1.total > 0 && qd1.items.every((e) => (e.dynEntries ?? 0) >= 3), `${qd1.total}`);
const qd2 = queryLocalIndex(idx, { minDynEntries: 1, limit: 1 });
console.log(`  可触发 ≥1 条：${qd2.total} / ${idx.entries.length} 张（占 ${((qd2.total / idx.entries.length) * 100).toFixed(1)}%）`);
t("确实存在带可触发条目的卡（否则上面是空转）", qd2.total > 0 && qd2.total < idx.entries.length);
const qd3 = queryLocalIndex(idx, { sort: "dynDesc", limit: 5 });
t("dynDesc 排序生效（递减）", qd3.items[0].dynEntries >= qd3.items[qd3.items.length - 1].dynEntries);
t("dynDesc 榜首确实厚（> 0）", (qd3.items[0].dynEntries ?? 0) > 0);
// 两个数必须是两回事：世界书多 ≠ 可触发多
const bookHeavy = queryLocalIndex(idx, { minBookEntries: 50, limit: 1 }).total;
const dynHeavy = queryLocalIndex(idx, { minDynEntries: 50, limit: 1 }).total;
console.log(`  世界书 ≥50 条：${bookHeavy} 张 ｜ 可触发 ≥50 条：${dynHeavy} 张（同维度不同口径）`);
t("两个口径确实不同（否则加这个字段没意义）", bookHeavy !== dynHeavy);

const q8 = queryLocalIndex(idx, { limit: 5, offset: 5 });
t("offset 生效（与首页不重叠）", q8.items[0].fullPath !== queryLocalIndex(idx, { limit: 5 }).items[0].fullPath);
// ★ 关键：contentLen 而不是 personaLen，才能捞到「人设空但世界书厚」的卡
const byPersonaOnly = queryLocalIndex(idx, { minContent: 100000 }).total;
const wouldMiss = idx.entries.filter((e) => e.personaLen === 0 && (e.contentLen ?? 0) >= 100000).length;
console.log(`  内容>=10万字 的卡 ${byPersonaOnly} 张，其中人设=0 的 ${wouldMiss} 张`);
t("**用 contentLen 能捞到人设为 0 的厚卡**（用 personaLen 会漏掉）", wouldMiss > 0);

console.log("\n=== 7) 阵容也用得上（多人开团）===");
const trio = queryLocalIndex(idx, { categories: ["修仙"], minContent: 30000, limit: 3 }).items;
t("能选出 3 张组队", trio.length === 3);
if (trio.length === 3) {
	const cards = trio.map((it) => {
		const p = readLocalCardFile(join(ROOT, relOf(it.fullPath)));
		return { card: normalizeLocalCard(p, { ...metaFromPath(relOf(it.fullPath)), file: relOf(it.fullPath), fullPath: it.fullPath }), role: "队员" };
	});
	const castOut = composeCast(cards, {});
	t("阵容注入段非空", castOut.text.length > 0);
	t("阵容含 3 人", castOut.cast.length === 3);
	t("没有「人设字段为空」的裸警告", !castOut.text.includes("⚠️ 此人设字段为空"));
}

console.log("\n=== 8) 错误路径 ===");
let e1 = null;
try { readLocalCardFile(join(ROOT, "不存在的文件.png")); } catch (e) { e1 = e; }
t("读不存在的文件报错", e1 !== null);
let e2 = null;
try { await buildLocalIndex("/Volumes/绝对不存在的盘/xyz"); } catch (e) { e2 = e; }
t("建索引时目录不可用报错（外置盘场景）", e2 !== null && /不存在|不可访问|未挂载/.test(e2.message));
console.log(`      文案: ${String(e2?.message).slice(0, 70)}`);
let e3 = null;
try { queryLocalIndex(null, {}); } catch (e) { e3 = e; }
t("索引为 null 时报错（不静默返回空）", e3 !== null);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
