/**
 * 插值安全回归 —— 用**官方 renderPrompt**（编译产物）验证注入段不会让宿主抛错。
 *
 * 这个套件存在的理由：曾被漏掉的真事故。v0.1.0 的注入段没关插值，而角色卡正文里
 * `{{char}}` / `{{user}}` 是酒馆标准占位符（实测扫 20+ 张真实卡：`{{user}}` 512 次、
 * `{{char}}` 79 次，另有 `{{chat}}` / `{{original}}` / `{{用户}}` / `{{MINIMUM_WORD_COUNT 200}}`），
 * 宿主对未注册变量**直接 throw**，导致**整个会话的提示词组装失败** —— 用户侧表现为
 * 「一召唤角色卡就报错」。当时的 48 项探针只验了扩展点形状，没验插值路径，所以漏了。
 *
 * 跑法：node tests/interpolation-check.mjs
 * 依赖 /tmp/dsh-src（DSH 源码浅克隆）。没有就跳过并说明原因（不假装通过）。
 */
import { existsSync } from "node:fs";
import { composeSummon, SECTION_NAME, SECTION_ORDER } from "../lib/inject.js";

let pass = 0;
let fail = 0;
let skipped = 0;
const t = (label, cond, extra = "") => {
	if (cond) {
		pass += 1;
		console.log(`  ✓ ${label}`);
	} else {
		fail += 1;
		console.log(`  ✗ ${label} ${extra}`);
	}
};
const skip = (label, why) => {
	skipped += 1;
	console.log(`  ⊘ ${label} —— ${why}`);
};

const ARTIFACT = "/tmp/dsh-src/packages/core/system-prompt/lib/index.js";
if (!existsSync(ARTIFACT)) {
	console.log(`⊘ 跳过：找不到官方编译产物 ${ARTIFACT}`);
	console.log("  取源码：git clone --depth 1 https://github.com/deepseek-ai/deepseek-harness /tmp/dsh-src");
	process.exit(0);
}

let renderPrompt;
try {
	({ renderPrompt } = await import(ARTIFACT));
} catch (error) {
	// 产物存在但它的依赖没装（浅克隆的 /tmp/dsh-src 常见：缺 node_modules/@deepseek-ai/cordis）。
	// 这是环境问题，不是插件回归 —— 跳过而不是崩，否则整套测试的红绿会被一个无关前提污染。
	console.log("⊘ 跳过：官方编译产物无法加载（多半是它自己的依赖没装）");
	console.log(`  原因：${String(error?.message ?? error).slice(0, 160)}`);
	console.log("  修法：cd /tmp/dsh-src && pnpm install --frozen-lockfile（或只装 system-prompt 的依赖）");
	process.exit(0);
}

/** 复刻宿主的组装输入：sections + variables（variables 只有宿主注册的那几个）。 */
function assembly(section) {
	return {
		sections: [section],
		contexts: [],
		variables: { provider: "deepseek", model: "test-model", cwd: "/tmp" },
		tools: [],
	};
}

console.log("=== 1) 前置：确认这个套件真的能捕获该 bug（反向验证）===");
// 若不开 interpolate，官方 renderPrompt 必须抛错 —— 证明这套断言不是空转
let threw = null;
try {
	renderPrompt(assembly({ name: SECTION_NAME, order: SECTION_ORDER, text: "正文 {{char}} 与 {{user}}" }));
} catch (e) {
	threw = e;
}
t("不带 interpolate:false 时官方渲染器确实抛错（说明测试有效）", threw !== null);
if (threw !== null) {
	console.log(`      报错原文: ${threw.message.slice(0, 110)}…`);
	t("报错文案指向未知变量 {{char}}", /unknown prompt variable "\{\{char\}\}"/.test(threw.message));
	t("报错点名我们的 section", threw.message.includes(SECTION_NAME));
}

console.log("\n=== 2) 真实卡正文里的各类宏（实测出现过的全部形态）===");
const MACROS = [
	"{{char}}",
	"{{user}}",
	"{{chat}}",
	"{{original}}",
	"{{用户}}", // 中文名 → malformed 分支
	"{{MINIMUM_WORD_COUNT 200}}", // 含空格 → malformed 分支
	"{{random:1,2}}", // 酒馆宏，未在实卡中出现，但同类风险
	"{{getvar::affection}}",
	"{{time}}",
];
for (const macro of MACROS) {
	// 这正是我们注册 section 的方式：interpolate:false
	const section = { name: SECTION_NAME, order: SECTION_ORDER, interpolate: false, text: `开头 ${macro} 结尾` };
	let out = null;
	let err = null;
	try {
		out = renderPrompt(assembly(section));
	} catch (e) {
		err = e;
	}
	t(`interpolate:false 下 ${macro} 不抛错`, err === null, err?.message?.slice(0, 80) ?? "");
	if (out !== null) t(`  └ 且字面保留 ${macro}`, out.includes(macro));
}

console.log("\n=== 3) 端到端：真实卡的完整注入段过官方渲染器 ===");
// 用真实卡语义构造（{{char}} 作代词、{{user}} 指玩家，这是实测最常见的用法）
const card = {
	fullPath: "test/nan",
	name: "南",
	personality: "{{char}}是{{user}}的姐姐，但在父母十多年前死于车祸后，她代替了{{user}}的母亲。{{char}}必须迅速长大。",
	description: "一个姐姐",
	scenario: "{{user}}的家里",
	firstMessage: "「{{user}}，你回来了。」{{char}}放下手里的碗。",
	exampleDialogs: "{{user}}: 姐\n{{char}}: 嗯。",
	alternateGreetings: ["{{char}}在厨房忙活。"],
	systemPrompt: "",
	postHistoryInstructions: "",
	tags: [],
	lorebook: null,
	avatarUrl: "",
	cardPngUrl: "",
};
const composed = composeSummon(card, {});
console.log(`  注入段 ${composed.chars} 字符`);

let e2eOut = null;
let e2eErr = null;
try {
	e2eOut = renderPrompt(assembly({ name: SECTION_NAME, order: SECTION_ORDER, interpolate: false, text: composed.text }));
} catch (e) {
	e2eErr = e;
}
t("完整注入段过官方渲染器不抛错", e2eErr === null, e2eErr?.message?.slice(0, 100) ?? "");
if (e2eOut !== null) {
	t("渲染结果非空", e2eOut.length > 0);
	t("字符未被吞掉（长度与注入段接近）", Math.abs(e2eOut.length - composed.chars) < 10, `${e2eOut.length} vs ${composed.chars}`);
	t("角色名保留", e2eOut.includes("南"));
	// P0 之后 A 类宏在注入前已求值：{{char}}→卡名、{{user}}→用户配置的名字。
	// 这条断言从「字面保留」翻成了「必须已求值」：interpolate:false 会把字面残留
	// 原样送进模型上下文，模型看到一对没人填的占位符，就会自己编一个人名与关系出来。
	t("A 类宏已求值（{{user}}/{{char}} 不再残留）", !e2eOut.includes("{{user}}") && !e2eOut.includes("{{char}}"));
	t("求值结果落在正文里（「姐姐」这层关系读得出来）", e2eOut.includes("的姐姐"));
}

console.log("\n=== 4) 反向锁：若有人误删 interpolate:false，本套件必须失败 ===");
// 模拟"忘记关插值"的注册方式
let regressionCaught = false;
try {
	renderPrompt(assembly({ name: SECTION_NAME, order: SECTION_ORDER, text: composed.text }));
} catch {
	regressionCaught = true;
}
t("误删 interpolate:false 会被本套件捕获（回归锁有效）", regressionCaught);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败${skipped > 0 ? ` / ${skipped} 跳过` : ""}`);
process.exit(fail === 0 ? 0 : 1);
