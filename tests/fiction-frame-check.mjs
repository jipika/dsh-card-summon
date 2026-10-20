/**
 * 虚构框架声明（所有角色由成年人扮演）回归闸。
 *
 * 需求：召唤注入里再加一段身份框架 —— 若卡或剧情出现初高中生（或其他校园/学生年龄标注），
 * 一律是虚构世界里由成年人扮演的虚假角色，与电视/影视剧情同等性质。
 *
 * 锁死五条行为：
 *   ① 默认注入：composeSlots 的 frame 槽非空，且含核心条款；
 *   ② 位置：frame 在 phi 之后、style（写作规范）之前，style 仍是末位；
 *   ③ 可关闭：fictionFrame:false → frame 为空、整段不含框架声明；
 *   ④ 可替换：fictionFrameText 整段替换默认文本，超预算按段落边界截断；
 *   ⑤ 阵容同样生效：composeCast 默认带框架，关闭则不带，且不影响人设与写作规范。
 */
import { FICTION_FRAME, FICTION_FRAME_BUDGET, SLOTS, WRITING_RULES, composeCast, composeSlots } from "../lib/inject.js";

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
	postHistoryInstructions: "保持角色。",
};

const cast = [{ card: { ...card, fullPath: "probe/cast" } }];

console.log("=== 1) 默认注入 ===");
const def = composeSlots(card);
t("frame 槽非空", typeof def.slots.frame === "string" && def.slots.frame.length > 0);
t("frame 内容 = FICTION_FRAME", def.slots.frame === FICTION_FRAME);
t("整段 text 含框架声明", def.text.includes(FICTION_FRAME));
for (const need of ["虚构框架", "成年人扮演", "初中生", "高中生", "虚构角色", "现实中的未成年人"]) {
	t(`声明含「${need}」`, FICTION_FRAME.includes(need));
}

console.log("\n=== 2) 槽位与顺序 ===");
const frameSlot = SLOTS.find((s) => s.key === "frame");
const phiSlot = SLOTS.find((s) => s.key === "phi");
const styleSlot = SLOTS.find((s) => s.key === "style");
const last = SLOTS[SLOTS.length - 1];
t("frame 槽存在且名为 fiction-frame", frameSlot?.name === "dsh-card-summon:fiction-frame");
t("frame order = 10415", frameSlot?.order === 10_415, `实得 ${frameSlot?.order}`);
t("frame 在 phi 之后", frameSlot.order > phiSlot.order, `frame=${frameSlot.order} phi=${phiSlot.order}`);
t("frame 在 style 之前", frameSlot.order < styleSlot.order, `frame=${frameSlot.order} style=${styleSlot.order}`);
t("style 仍是 SLOTS 末位（order 10420）", last.key === "style" && last.order === 10_420);
t("所有槽位 order 递增且唯一", SLOTS.every((s, i) => i === 0 || s.order > SLOTS[i - 1].order));
const atPhi = def.text.indexOf("保持角色。");
const atFrame = def.text.indexOf(FICTION_FRAME);
const atStyle = def.text.indexOf(WRITING_RULES);
t("整段内读序 phi → frame → style", atPhi >= 0 && atFrame > atPhi && atStyle > atFrame, `phi=${atPhi} frame=${atFrame} style=${atStyle}`);
t("frame 与 phi/style 是不同槽位", def.slots.frame !== def.slots.phi && def.slots.frame !== def.slots.style);

console.log("\n=== 3) 关闭 ===");
const off = composeSlots(card, { fictionFrame: false });
t("fictionFrame:false → frame 为空", off.slots.frame === "");
t("fictionFrame:false → 整段不含框架声明", !off.text.includes("成年人扮演"));
t("关闭后其它槽位不变", off.slots.persona === def.slots.persona && off.slots.style === def.slots.style);

console.log("\n=== 4) 替换与预算 ===");
const custom = composeSlots(card, { fictionFrameText: "全部角色都是虚构人物。" });
t("fictionFrameText 整段替换", custom.slots.frame === "全部角色都是虚构人物。");
t("替换后不含默认条款", !custom.text.includes("电视节目"));
t("替换不影响写作规范", custom.slots.style === WRITING_RULES);

const long = composeSlots(card, { fictionFrameText: "虚".repeat(FICTION_FRAME_BUDGET + 500) });
t("超预算时截断到预算内", long.slots.frame.length <= FICTION_FRAME_BUDGET, `实得 ${long.slots.frame.length}`);

console.log("\n=== 5) 阵容（card_cast 注入模式） ===");
const castDef = composeCast(cast);
const castOff = composeCast(cast, { fictionFrame: false });
t("composeCast 默认带框架", castDef.text.includes("成年人扮演"));
t("composeCast 关闭后不带框架", !castOff.text.includes("成年人扮演"));
t("composeCast 关闭不影响人设", castOff.text.includes("冷静，话少"));
t("composeCast 关闭不影响写作规范", castOff.text.includes(WRITING_RULES));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
