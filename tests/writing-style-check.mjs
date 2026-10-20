/**
 * 默认写作规范（三位一体·描写规范核心要求）回归闸。
 *
 * 需求：把三位一体创作规则里的【描写规范核心要求】做成插件默认提示词 ——
 * 每次召唤角色卡都自动注入，且排在 phi 之后（最后读，压过卡内含蓄/降重写法）。
 *
 * 锁死五条行为：
 *   ① 默认注入：composeSlots 的 style 槽非空，且含核心条款；
 *   ② 位置最后：style 是 SLOTS 末位，order 大于 phi；
 *   ③ 可关闭：writingStyle:false → style 为空、整段不含规范；
 *   ④ 可替换：writingStyleText 整段替换默认文本；
 *   ⑤ 阵容同样生效：composeCast 默认带规范，关闭则不带。
 */
import { SLOTS, WRITING_RULES, WRITING_RULES_BUDGET, composeCast, composeSlots } from "../lib/inject.js";

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

const card = {
	name: "探针",
	personality: "冷静，话少，惜字如金。",
	scenario: "深夜的便利店。",
	firstMessage: "……你来了。",
};

const cast = [{ card: { ...card, fullPath: "probe/cast" } }];

console.log("=== 1) 默认注入 ===");
const def = composeSlots(card);
t("style 槽非空", typeof def.slots.style === "string" && def.slots.style.length > 0);
t("style 内容 = WRITING_RULES", def.slots.style === WRITING_RULES);
t("整段 text 含规范（输出格式段在它之后）", def.text.includes(WRITING_RULES));
for (const need of ["极致详细", "最直白", "300 字", "呻吟", "体液", "微观动态"]) {
	t(`规范含「${need}」`, WRITING_RULES.includes(need));
}

console.log("\n=== 2) 槽位与顺序 ===");
const styleSlot = SLOTS.find((s) => s.key === "style");
const last = SLOTS[SLOTS.length - 1];
const phi = SLOTS.find((s) => s.key === "phi");
t("style 槽存在且名为 writing-style", styleSlot?.name === "dsh-card-summon:writing-style");
t("style order 大于 phi", styleSlot.order > phi.order, `style=${styleSlot.order} phi=${phi.order}`);
t("style 是 SLOTS 末位（格式提示词已移除）", last.key === "style" && last.order === 10_420);
t("style 槽在 composeSlots 输出里独立存在", def.slots.style !== def.slots.phi && def.slots.style !== def.slots.main);

console.log("\n=== 3) 关闭与替换 ===");
const off = composeSlots(card, { writingStyle: false });
t("writingStyle:false → style 为空", off.slots.style === "");
t("writingStyle:false → 整段不含规范", !off.text.includes("极致详细"));
t("关闭后其它槽位不变", off.slots.persona === def.slots.persona && off.slots.main === def.slots.main);

const custom = composeSlots(card, { writingStyleText: "只写短句，不写长段。" });
t("writingStyleText 整段替换", custom.slots.style === "只写短句，不写长段。");
t("替换后不含默认条款", !custom.text.includes("极致详细"));

const long = composeSlots(card, { writingStyleText: "规".repeat(WRITING_RULES_BUDGET + 500) });
t("超预算时截断到预算内", long.slots.style.length <= WRITING_RULES_BUDGET, `实得 ${long.slots.style.length}`);
t("截断长度接近预算", long.slots.style.length === WRITING_RULES_BUDGET, `实得 ${long.slots.style.length}`);

console.log("\n=== 4) 阵容（card_cast 注入模式） ===");
const castDef = composeCast(cast);
const castOff = composeCast(cast, { writingStyle: false });
t("composeCast 默认带规范", castDef.text.includes("极致详细"));
t("composeCast 关闭后不带规范", !castOff.text.includes("极致详细"));
t("composeCast 关闭不影响人设", castOff.text.includes("冷静，话少"));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
