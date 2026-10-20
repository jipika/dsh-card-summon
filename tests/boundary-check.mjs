/**
 * 边界与错误路径套件（原本在 /tmp，固化成仓库内资产，避免依赖临时目录）。
 *
 * 跑法：node tests/boundary-check.mjs   （需要网络，用真实卡验证结构）
 *
 * 隔离：必须先把状态根指到临时目录再 import —— 真实 `vars.json` 里用户可能配过
 * 自定义 `{{user}}`（本机就配过），否则「{{user}} 求值成默认用户名」这条会假失败，
 * 而失败原因与被测代码毫无关系。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = mkdtempSync(join(tmpdir(), "card-summon-boundary-"));
process.env.DSH_CARD_SUMMON_STATE = TMP;

const { composeSummon, detectMinorFlag, BUDGET } = await import("../lib/inject.js");
const { fetchCard } = await import("../lib/chub.js");

let pass = 0, fail = 0;
const t = (label, cond, extra = "") => {
	if (cond) { pass += 1; console.log(`  ✓ ${label}`); }
	else { fail += 1; console.log(`  ✗ ${label} ${extra}`); }
};

console.log("=== 空卡 / 缺字段 ===");
t("无名 → 空串", composeSummon({ name: "", personality: "" }).text === "");
t("空 name → 不注入", composeSummon({ name: "", personality: "x".repeat(100) }).text === "");
const onlyName = composeSummon({ name: "阿澈", personality: "" });
t(
	"只有名字 → 仍渲染且含警告",
	onlyName.text.includes("没有给出人设正文") && onlyName.text.includes("阿澈"),
	JSON.stringify(onlyName.slots),
);
// 人设那一格必须空着：系统提示不该混进"角色定义"里（那是旧版的文档式骨架）。
t("只有名字 → persona 槽为空", onlyName.slots.persona === "");
t("null 卡 → 空串", composeSummon(null).text === "");
t("undefined 卡 → 空串", composeSummon(undefined).text === "");

console.log("\n=== 超长截断 ===");
const huge = {
	name: "长人设",
	personality: "A".repeat(50000),
	scenario: "S".repeat(9000),
	exampleDialogs: "E".repeat(30000),
	firstMessage: "F".repeat(9000),
};
const c = composeSummon(huge);
t("personality 被截断", c.truncatedFields.includes("personality"));
t("scenario 被截断", c.truncatedFields.includes("scenario"));
t("example_dialogs 被截断", c.truncatedFields.includes("example_dialogs"));
t("first_message 被截断", c.truncatedFields.includes("first_message"));
t("截断后有 card_read 提示", c.text.includes("card_read"));
t("总长受控 (<40k)", c.chars < 40000, `实际 ${c.chars}`);

console.log("\n=== maxPersonality 配置生效 ===");
const c2 = composeSummon({ name: "X", personality: "Z".repeat(20000) }, { maxPersonality: 500 });
// 只断言 persona 槽本身受限；text 里还有默认注入的写作规范(1123)与格式规则(480)，不参与这个上限。
t("自定义上限 500 生效", c2.slots.persona.length <= 500, `persona 实际 ${c2.slots.persona.length}`);
t("标记为截断", c2.truncatedFields.includes("personality"));

console.log("\n=== detectMinorFlag 只读元数据、不扫正文 ===");
t("普通卡不误报", detectMinorFlag({ tags: ["Female", "Fantasy"], description: "一个骑士" }).flagged === false);
t("命中 loli 标签", detectMinorFlag({ tags: ["loli"], description: "" }).flagged === true);
t("命中 shota", detectMinorFlag({ tags: [], description: "a shota character" }).flagged === true);
t("命中 小学生", detectMinorFlag({ tags: ["小学生"], description: "" }).flagged === true);
t("命中 age regression", detectMinorFlag({ tags: ["age regression"], description: "" }).flagged === true);
t("不扫 personality 正文", detectMinorFlag({ tags: [], description: "", personality: "loli appears deep in persona" }).flagged === false);
const f = detectMinorFlag({ tags: ["loli"], description: "school" });
t("返回 why 与 hits", typeof f.why === "string" && Array.isArray(f.hits));

console.log("\n=== fetchCard 错误路径（200 但空壳不算成功）===");
try { await fetchCard("this/is-not-a-real-card-xyz-123456"); t("不存在的卡应报错", false, "却没报错"); }
catch { t("不存在的卡报错而非静默成功", true); }
try { await fetchCard("bad-path-no-slash"); t("非法路径应报错", false); }
catch { t("非法路径报错", true); }

console.log("\n=== 卡正文里的酒馆宏：能算的算掉，算不出的原样留着 ===");
const withMacros = composeSummon({
	name: "测试",
	personality: "{{char}}是{{user}}的姐姐，还有 {{random:1,2}} 与 {{getvar::x}}。",
	scenario: "{{time}}",
	firstMessage: "{{chat}}",
});
t("含宏仍能渲染", withMacros.chars > 0);
// A 类（user/char）：注入前求值，必须不再残留 —— 字面残留会让模型看到别人的占位符
// 而自己编一个人名/关系出来（实测 {{user}} 在真实卡里出现 24849 次，不是边角情况）。
t("{{char}} 求值成卡名", withMacros.text.includes("测试是") && !withMacros.text.includes("{{char}}"));
t("{{user}} 求值成默认用户名", withMacros.text.includes("你的姐姐") && !withMacros.text.includes("{{user}}"));
// B 类（酒馆标准宏）：认得出但算不了，**不许删** —— 删了用户就看不出这里缺东西。
t("B 类宏（random/getvar）原样保留", withMacros.text.includes("{{random:1,2}}") && withMacros.text.includes("{{getvar::x}}"));
t("B 类宏（time/chat）原样保留", withMacros.text.includes("{{time}}") && withMacros.text.includes("{{chat}}"));

rmSync(TMP, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
