/**
 * 注入前转换层回归闸（2026-10-19）。
 *
 * 用户要求：不靠提示词规则，而是在注入前把卡里的酒馆标签/状态栏模板**转换成 Markdown**。
 * 这样模型看不到可照抄的 `<StatusBar>` 模板，就不会输出 DSH 渲染不了的标签。
 *
 * 本测试锁死：
 *   ① 状态栏模板块 → Markdown 引用块（字段名加粗、嵌套字段与两条 "无" 不丢）；
 *   ② 含 <StatusBar> 的指令行 → 「用 Markdown 引用块输出」，不残留 ```
 *   ③ `<user>` / `{{<user>}}` → `{{user}}`，不产生 `{{{{user}}}}`；
 *   ④ `<br>` 转换、`<b>` → `**`、`</text>`/`<center>` 去掉、`<START>` 保留；
 *   ⑤ composeSlots / composeCast 全槽位无自造标签残留，且 auto 下不注入格式规则；
 *   ⑥ 世界书条目的 content 同样被转换。
 */
import { markdownizeCard, markdownizeText } from "../lib/markdownize.js";
import { composeCast, composeSlots } from "../lib/inject.js";

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

const TAG_RE = /<\/?[A-Za-z][A-Za-z0-9_-]*(?:\s[^<>]*)?>/g;

const statusBlock = `每轮结尾必须输出：
\`\`\`
<StatusBar>
Status_Bar:
  Date_and_Time: "2025-01-17 23:15"
  Location: "卧室"
  User_List:
    - User:
        Name: "{{<user>}}"
        Action: "说话"
  Recent_Sexual_Activity:
    - "无"
    - "无"
</StatusBar>
\`\`\``;

console.log("=== 1) 单元：状态栏块 → 引用块 ===");
const converted = markdownizeText(statusBlock);
t("不再含 <StatusBar>", !converted.includes("<StatusBar>"));
t("不再含孤立 ```", !converted.includes("```"));
t("变成引用块", converted.includes("> **Status_Bar**:"));
t("字段名加粗", converted.includes("**Date_and_Time**"));
t("嵌套 User_List 保留", converted.includes("**User_List**"));
t("Recent_Sexual_Activity 两条 \"无\" 都在", (converted.match(/- "无"/g) || []).length === 2);
t("{{<user>}} 变成 {{user}}", converted.includes("{{user}}") && !converted.includes("{{<user>}}"));
t("没有 {{{{user}}}} 嵌套", !converted.includes("{{{{"));

console.log("\n=== 2) 单元：指令行与常见标签 ===");
const directive = markdownizeText("- 外层必须用<StatusBar></StatusBar>再用代码块(```)包裹");
t("指令行改成 Markdown 说明", directive.includes("用 Markdown 引用块输出"));
t("指令行不残留标签", !/<StatusBar>/i.test(directive));
t("<br> → 换行", markdownizeText("甲<br>乙") === "甲\n乙");
t("<b> → **", markdownizeText("<b>重点</b>") === "**重点**");
t("</text> 去掉", markdownizeText("正文</text>") === "正文");
t("<center> 去掉", markdownizeText("<center>正文</center>") === "正文");
t("<user> → {{user}}", markdownizeText("你<user>说") === "你{{user}}说");
t("<START> 保留", markdownizeText("<START>") === "<START>");

console.log("\n=== 3) 卡级：composeSlots 全槽位 ===");
const card = {
	name: "转换探针",
	systemPrompt: `你是转换探针。\n${statusBlock}`,
	personality: "她<user>看着你</text>，<br>脸红了。<center>正文</center>",
	firstMessage: `开场</text>\n\n\`\`\`\n<StatusBar>\nStatus_Bar:\n  Location: "卧室"\n  Recent_Sexual_Activity:\n    - "无"\n    - "无"\n</StatusBar>\n\`\`\``,
	exampleDialogs: "<START>\n转换探针: 示例一\n<START>\n转换探针: 示例二",
	lorebook: {
		entries: [
			{ keys: ["房间"], content: "<center>房间很暗</center><b>重点</b>", constant: true, enabled: true, insertion_order: 1 },
		],
	},
};
const composed = composeSlots(card);
const slotText = Object.values(composed.slots).filter(Boolean).join("\n");
t("所有槽位无 <StatusBar>", !/<StatusBar>/i.test(slotText));
t("所有槽位无 </text> / <center>", !/<center>|<\/text>/i.test(slotText));
t("只允许 <START> 残留", (slotText.match(TAG_RE) || []).every((x) => x === "<START>"), `实得 ${JSON.stringify(slotText.match(TAG_RE))}`);
t("persona 槽保留正文", composed.slots.persona.includes("脸红了"));
t("greeting 槽是引用块", composed.slots.greeting.includes("> **Status_Bar**:"));
t("世界书条目被转换（<b> → **）", slotText.includes("**重点**"));
t("格式提示词已移除：slots 里没有 format 槽", !("format" in composed.slots));

console.log("\n=== 4) 卡级：composeCast ===");
const cast = composeCast([{ card: { ...card, fullPath: "probe/convert" } }]);
t("cast 无 <StatusBar>", !/<StatusBar>/i.test(cast.text));
t("cast 无 <center>", !cast.text.includes("<center>"));
t("cast 保留引用块", cast.text.includes("> **Status_Bar**:"));

console.log("\n=== 5) markdownizeCard 不改原卡 ===");
const before = JSON.stringify(card);
markdownizeCard(card);
t("原卡未被修改", JSON.stringify(card) === before);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
