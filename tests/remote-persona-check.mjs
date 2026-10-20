/**
 * 回归闸：remote 取卡路径下 `personaDerived` 必须**现算**，不能沿用远端 JSON 里的旧快照。
 *
 * 被这个测试钉住的 BUG（2026-10-16 发现，症状极具迷惑性）：
 *   lib/local.js 的 personaFromBook 早已修好（整条进出 + 20000 预算），本地路径实测
 *   6/6 条常驻全进；但**重新召唤后注入量纹丝不动**（9700 字符），因为
 *   index.js 的 fetchAnyCard 在 remote 分支**整对象透传**远端 JSON —— 而远端那份
 *   `personaDerived` 是「当初推送索引时」用当时预算生成并写死的 6005 字快照
 *   （`personaDerivedDropped` 字段压根不存在），尾部断在 `phase_1_布局` 的
 *   `event: "丈夫({{user}})的异…`。用户默认走 remote，于是提炼逻辑的一切升级对这条
 *   路径永远无效 —— 表现就是「改了半天、重新召唤还是没反应」。
 *   修法：新增 withFreshPersona 收口，派生字段（可从 lorebook 现算）一律重算；
 *   整对象透传只适用于**源数据**。
 *
 * 另有第四处（同一轮发现）：inject.js 的 BUDGET.personality=12000 会把提炼出的 12759
 * 二次截断，而作者把主角条目放在 order=101（末位）→ 切掉的正是它的尾部。
 * 故本测试同时断言「含主角人设」。
 *
 * 跑法：node tests/remote-persona-check.mjs   （需要网络 + gh auth token）
 */
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const REF =
	"local://2025-11-19/已分类/NTR/～老公 真的可以让他插进来吗～ 清纯又温顺的妻子被寝取时会兴奋的变态性癖.png";

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

let token = "";
try {
	token = execSync("gh auth token", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
} catch {
	/* 无 token：私有仓库取不到，跳过 */
}
if (token.length === 0) {
	console.log("跳过：取不到 gh auth token（远端卡库是私有仓库）");
	process.exit(0);
}

const calls = { sections: [], tools: [], routes: [], effects: 0 };
const SESSION = "probe-remote-persona";
const ctx = {
	effect(fn) {
		calls.effects += 1;
		const d = fn();
		return typeof d === "function" ? d : () => {};
	},
	on() {
		return () => {};
	},
	systemPrompt: {
		section(def) {
			calls.sections.push(def);
			return () => {};
		},
	},
	tools: {
		register(def) {
			calls.tools.push(def);
			return () => {};
		},
	},
	webServer: {
		register(def) {
			calls.routes.push(def);
			return () => {};
		},
	},
	agents: {
		currentInitiator: () => ({ sessionId: SESSION, session: { header: { id: SESSION } } }),
	},
	logger: { info: () => {}, warn: () => {} },
};

const mod = await import(pathToFileURL(new URL("../index.js", import.meta.url).pathname).href);
await mod.apply(ctx, { remoteRepo: "jipika/dsh-card-library", remoteToken: token });

const summon = calls.tools.find((x) => x.name === "card_summon");
const out = await summon.execute({ fullPath: REF }, {});
console.log(`  card_summon → via=${out.via} injectedChars=${out.injectedChars}`);

// 注入现在是**多槽位**的：逐条按 order 求值再拼起来，才能还原宿主真正看到的整段。
// 只读 calls.sections[0] 会只看得到 main 那一句（94 字符），断言会全假。
const evalAll = () =>
	calls.sections
		.slice()
		.sort((a, b) => a.order - b.order)
		.map((s) => s.text({ agent: { sessionId: SESSION, session: { header: { id: SESSION } } } }))
		.filter((x) => x.length > 0)
		.join("\n\n");
const text = evalAll();
const slotSizes = Object.fromEntries(
	calls.sections.map((s) => [
		s.name.replace("dsh-card-summon:", ""),
		s.text({ agent: { sessionId: SESSION, session: { header: { id: SESSION } } } }).length,
	]),
);
console.log(`  槽位字符数: ${JSON.stringify(slotSizes)}`);

t("确实走 remote 路径（否则本测试没覆盖到目标分支）", out.via === "remote", `实得 ${out.via}`);
t("注入段 > 14000 字符（旧快照版实测 9700）", text.length > 14_000, `实得 ${text.length}`);
t("含**主角人设**（献身情结）—— 第四处预算对齐的守门", text.includes("献身情结"));
t("含 NSFW 文风语料库（反差白描法）", text.includes("反差白描法"));
t("含完整时间线 phase_4（旧快照断在 phase_1）", text.includes("phase_4_堕落与净化"));
t("含写作规范（默认注入）", text.includes("写作规范"));
t("注入段无自造标签残留（转换层已处理）", !/<StatusBar>|<Status_block>/i.test(text));
t("不再有旧的整节格式规则标题", !text.includes("## 输出格式"));
t("含丈夫设定（寝取爱好者）", text.includes("寝取爱好者"));
t("旧快照的截断残留「的异…」已消失", !text.includes("的异…"));
t("没有文档式骨架（旧版首行 # 本会话已召唤角色卡）", !text.includes("# 本会话已召唤角色卡"));
t("首行是 main 槽的一句话", text.startsWith("写「"), JSON.stringify(text.slice(0, 20)));

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
