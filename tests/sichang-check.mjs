/**
 * 中文源（sichang.xyz）与双源分发验证。
 *
 * 跑法：node tests/sichang-check.mjs   （需要网络）
 *
 * 背景（决定这些断言为什么这么写）：
 *   · 这是本插件找到的**唯一可编程中文卡源**。中文圈核心在类脑 Discord（限制外传），
 *     其他中文站点实测无 API：roleplayai.cc 五个 /api 路径全 404、aicharactercards 404、
 *     jannyai 被 Cloudflare 403。
 *   · sichang 只有 ~84 张卡，但全是中文原生（Chub 上中文卡要考关键词+lang_id 才捞得到）。
 *   · 服务端只有 `?q=` 与 `?category=` 生效；`tags`/`gender` 无效；不支持分页。
 */
import { listSichang, fetchSichangCard, sichangRef, isSichangRef, slugOf } from "../lib/sichang.js";
import { composeSummon } from "../lib/inject.js";

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

console.log("=== 1) ref 辅助函数（纯逻辑，无网络）===");
t("sichangRef 生成前缀", sichangRef("abc") === "sichang://abc");
t("isSichangRef 识别", isSichangRef("sichang://abc") === true);
t("isSichangRef 拒绝 chub 路径", isSichangRef("creator/slug") === false);
t("slugOf 剥前缀", slugOf("sichang://abc") === "abc");
t("slugOf 原样返回", slugOf("abc") === "abc");
t("slugOf 处理空值", slugOf(undefined) === "");
t("空 ref 识别为 false", isSichangRef("") === false);

console.log("\n=== 2) 列表（真实站点）===");
const all = await listSichang({});
console.log(`  总卡数: ${all.total}`);
t("返回张数 > 0", all.total > 0, `实得 ${all.total}`);
t("source 标记为 sichang", all.source === "sichang");
const it = all.items[0];
console.log(`  首张: ${it.name} | 分类=${it.category} | 语言标记=${it.langId}`);
t("条目带 fullPath（sichang:// 前缀）", String(it.fullPath).startsWith("sichang://"));
t("条目带 source", it.source === "sichang");
t("条目 langId 恒为 12（中文原生）", it.langId === 12);
t("条目带中文卡名", typeof it.name === "string" && it.name.length > 0);
t("条目带头像 URL", typeof it.avatarUrl === "string" && it.avatarUrl.length > 0);

console.log("\n=== 3) 服务端过滤（实测只有 q 与 category 生效）===");
const q1 = await listSichang({ query: "古风" });
console.log(`  q=古风 → ${q1.total} 张: ${q1.items.map((x) => x.name).join(", ")}`);
t("q 过滤生效（少于全量）", q1.total < all.total, `${q1.total} vs ${all.total}`);
t("q 过滤结果非空", q1.total > 0);
const q2 = await listSichang({ query: "这个词肯定不存在xyzzy" });
t("不存在的词 → 0 张", q2.total === 0, `实得 ${q2.total}`);
const cat = await listSichang({ category: "古风" });
t("category 过滤生效", cat.total > 0 && cat.total < all.total, `实得 ${cat.total}`);

console.log("\n=== 4) 单卡详情 → 映射质量 ===");
const card = await fetchSichangCard(it.slug);
console.log(`  ${card.name}`);
console.log(`    personality=${card.personality.length} scenario=${card.scenario.length} firstMessage=${card.firstMessage.length}`);
t("name 非空", card.name.length > 0);
t("personality 非空（人设不丢）", card.personality.length > 0);
t("firstMessage 非空（开场白在）", card.firstMessage.length > 0, `实得 ${card.firstMessage.length}`);
t("source 为 sichang", card.source === "sichang");
t("fullPath 带前缀", String(card.fullPath).startsWith("sichang://"));
t("langId=12", card.langId === 12);
// 结构同构性：composeSummon 需要的字段都在
for (const f of ["name", "personality", "description", "scenario", "firstMessage", "exampleDialogs", "alternateGreetings", "systemPrompt", "tags", "lorebook", "avatarUrl"]) {
	t(`与 Chub 卡同构：有 ${f} 字段`, f in card);
}

console.log("\n=== 5) 注入端到端（这是关键：中文卡能不能真的注入）===");
const out = composeSummon(card, {});
console.log(`  注入段 ${out.chars} 字符`);
t("注入段非空", out.chars > 0);
t("注入段含角色名", out.text.includes(card.name));
t("注入段含人设（description 片段）", card.personality.length === 0 || out.text.includes(card.personality.slice(0, 30)));
t("注入段含开场白片段", card.firstMessage.length === 0 || out.text.includes(card.firstMessage.slice(0, 30)));
t("注入段声明了角色身份", out.text.includes("你就是") || out.text.includes("**就是"));
t("注入段有中文内容", /[\u4e00-\u9fff]/.test(out.text));

console.log("\n=== 6) 错误路径（结构校验：失败必须抛错，不能静默返回空卡）===");
try {
	await fetchSichangCard("");
	t("空 slug 应报错", false);
} catch {
	t("空 slug 报错", true);
}
try {
	await fetchSichangCard("this-slug-does-not-exist-xyzzy-12345");
	// 站点可能返回 200 + 空对象，也可能 404；两种都算「没静默成功」
	t("不存在的 slug 未静默返回空卡", false, "竟然成功了");
} catch (e) {
	t("不存在的 slug 报错", true);
	console.log(`    错误: ${String(e.message).slice(0, 70)}`);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
