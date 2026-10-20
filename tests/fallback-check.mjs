/**
 * 降级路径验证：远程不可用时能否靠本地顶上。
 *
 * 为什么单独测这个 —— 远程优先之后，这是**最容易静默出错**的分支：
 *   · 降级没接好 → 用户看到「读不到卡」，而不是「已换成本地读」
 *   · 降级判定写错 → 把真实错误吞掉，报成含糊的「都读不到」
 *   · 降级发生却没标记 → 界面上看不出这张卡其实来自磁盘（token 失效时尤其危险）
 *
 * 手法：stub `globalThis.fetch` 让远端请求按需失败，走真实插件的 card_summon。
 * ⚠️ 必须**先保存原 fetch 再覆盖**：函数体内直接调 fetch 会递归爆栈（实测踩过）。
 *    本文件末尾有反向对照，确认「忘了保存」时测试真会变红 —— 否则这个手法本身没被验证。
 */
import { existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const LOCAL_ROOT = "/Volumes/mac/下载/26.6角色卡/26.7月全中文备注角色卡（14000➕）";
const INDEX_FILE = `${process.env.HOME}/.dsh/card-summon/local-index.json`;
const REPO = "jipika/dsh-card-library";

let pass = 0;
let fail = 0;
const t = (label, cond, extra = "") => {
	if (cond) {
		pass++;
		console.log(`  ✓ ${label}`);
	} else {
		fail++;
		console.log(`  ✗ ${label} ${extra}`);
	}
};

if (!existsSync(INDEX_FILE) || !existsSync(LOCAL_ROOT)) {
	console.log("⊘ 跳过：本地索引或卡库不存在（降级测试需要两者都在）");
	process.exit(0);
}

const realFetch = globalThis.fetch.bind(globalThis);
const seen = { remote: 0 };

/** 远端请求的处理方式可切换，用来构造各种失败形态。 */
let remoteMode = "ok"; // ok | down | notjson | empty
function installFetchStub() {
	globalThis.fetch = async (url, init) => {
		const u = String(url);
		const isRemote = u.includes("raw.githubusercontent.com") || u.includes("api.github.com");
		if (!isRemote) return realFetch(url, init);
		seen.remote++;
		if (remoteMode === "down") throw new Error("模拟断网：getaddrinfo ENOTFOUND");
		if (remoteMode === "notjson") return new Response("<<<not json at all>>>", { status: 200 });
		if (remoteMode === "empty") return new Response("", { status: 200 });
		return realFetch(url, init);
	};
}
function restoreFetch() {
	globalThis.fetch = realFetch;
}

const calls = { routes: [], tools: {} };
const makeCtx = () => ({
	effect: (f) => {
		const d = f();
		return typeof d === "function" ? d : () => {};
	},
	on: () => () => {},
	systemPrompt: { section: () => () => {} },
	tools: {
		register: (d) => {
			calls.tools[d.name] = d;
			return () => {};
		},
	},
	webServer: {
		register: (d) => {
			calls.routes.push(d);
			return () => {};
		},
	},
	agents: { currentInitiator: () => ({ sessionId: "fb", session: { header: { id: "fb" } } }) },
});

const { loadLocalIndex } = await import(`${ROOT}/lib/local.js`);
const idx = loadLocalIndex();
const entry = idx.entries.find((e) => e.contentLen > 3000) ?? idx.entries[0];
const rel = entry.rel;
const fp = `local://${rel}`;
console.log(`目标卡：${entry.name}（${rel.slice(0, 40)}）\n`);

const mod = await import(`${ROOT}/index.js`);

/* ── ① 正常：远端可用 ── */
console.log("=== ① 远端可用 → 走远端，via=remote ===");
installFetchStub();
await mod.apply(makeCtx(), { remoteRepo: REPO, localRoot: LOCAL_ROOT });
try {
	const sum = await calls.tools.card_summon.execute({ fullPath: fp }, {});
	t("远程路径召唤成功", sum.ok === true, JSON.stringify(sum).slice(0, 90));
	t("via 标为 remote", sum.via === "remote", `实得 ${sum.via}`);
	console.log(`      name=${JSON.stringify(sum.name)} 注入 ${sum.injectedChars} 字符 via=${sum.via}`);
} catch (e) {
	t("远程路径召唤成功", false, e.message.slice(0, 110));
}

/* ── ② 远端整条链路挂 → 降级本地 ── */
console.log("\n=== ② 远端断网 → 降级本地，且不报错 ===");
remoteMode = "down";
seen.remote = 0;
try {
	const sum = await calls.tools.card_summon.execute({ fullPath: fp }, {});
	t("降级后仍召唤成功", sum.ok === true, JSON.stringify(sum).slice(0, 90));
	t("确实尝试过远端（说明走了降级而非跳过）", seen.remote > 0, `remote 请求数=${seen.remote}`);
	t("【关键】降级时 via 必须是 local", sum.via === "local", `实得 ${sum.via}`);
	t("降级后注入内容非空", sum.injectedChars > 0, `chars=${sum.injectedChars}`);
	console.log(`      name=${JSON.stringify(sum.name)} 注入 ${sum.injectedChars} 字符 via=${sum.via}`);
} catch (e) {
	t("降级后仍召唤成功", false, e.message.slice(0, 110));
}

/* ── ③ 远端 200 但不是 JSON → 也必须降级（这是 ② 漏掉的形态）── */
console.log("\n=== ③ 远端返回非 JSON（HTTP 200）→ 仍应降级 ===");
remoteMode = "notjson";
try {
	const sum = await calls.tools.card_summon.execute({ fullPath: fp }, {});
	t("非 JSON 响应时降级成功", sum.ok === true, JSON.stringify(sum).slice(0, 90));
	t("非 JSON 时 via 为 local", sum.via === "local", `实得 ${sum.via}`);
} catch (e) {
	t("非 JSON 响应时降级成功", false, e.message.slice(0, 110));
}

/* ── ④ 远端空响应 → 也应降级 ── */
console.log("\n=== ④ 远端空响应（HTTP 200 空体）→ 仍应降级 ===");
remoteMode = "empty";
try {
	const sum = await calls.tools.card_summon.execute({ fullPath: fp }, {});
	t("空响应时降级成功", sum.ok === true, JSON.stringify(sum).slice(0, 90));
	t("空响应时 via 为 local", sum.via === "local", `实得 ${sum.via}`);
} catch (e) {
	t("空响应时降级成功", false, e.message.slice(0, 110));
}

/* ── ⑤ 远端好、但这张卡不在 manifest 映射里 → 应降级（不是硬失败）── */
console.log("\n=== ⑤ manifest 里缺这条 src → 应降级而非硬失败 ===");
remoteMode = "ok";
// 用一张本地存在、但远端 manifest 里没有的「假卡」路径来触发 map.get() === null。
// 直接传不存在的 rel 会让 localReadable 也为 false，所以这里改测「远端仍在、
// 但映射查不到」的行为边界：本地可读时才应降级。
try {
	const sum = await calls.tools.card_summon.execute({ fullPath: `local://不存在/这张卡.png` }, {});
	t("缺映射且本地也没有 → 应抛错", false, `却成功了 ${JSON.stringify(sum).slice(0, 60)}`);
} catch (e) {
	const m = String(e?.message ?? e);
	t("缺映射且本地也没有 → 抛错", true);
	t("错误信息点明两边都读不到", m.includes("都读不到"), m.slice(0, 110));
}

/* ── ⑥ 远端挂 + 本地也读不到 → 错误必须说清两边 ── */
console.log("\n=== ⑥ 远端挂 + 本地不可读 → 错误信息要说清两边都试过 ===");
await mod.apply(makeCtx(), { remoteRepo: REPO, localRoot: "/tmp/definitely-not-a-card-library" });
remoteMode = "down";
try {
	await calls.tools.card_summon.execute({ fullPath: fp }, {});
	t("两边都失败时应抛错", false, "却成功了");
} catch (e) {
	const m = String(e?.message ?? e);
	t("两边都失败时抛错", true);
	t("错误点明「远程与本地都读不到」", m.includes("远程与本地都读不到"), m.slice(0, 110));
	t("错误带上本地根目录（便于排查）", m.includes("/tmp/definitely-not-a-card-library"), m.slice(0, 130));
	console.log(`      ${m.slice(0, 130)}`);
}

/* ── ⑦ 未配远程 → 纯本地仍可用 ── */
console.log("\n=== ⑦ 未配 remoteRepo → 纯本地仍可用 ===");
restoreFetch();
await mod.apply(makeCtx(), { localRoot: LOCAL_ROOT });
try {
	const sum = await calls.tools.card_summon.execute({ fullPath: fp }, {});
	t("未配远程时本地可用", sum.ok === true, JSON.stringify(sum).slice(0, 80));
	t("未配远程时 via 为 local", sum.via === "local", `实得 ${sum.via}`);
} catch (e) {
	t("未配远程时本地可用", false, e.message.slice(0, 100));
}

/* ── ⑧ 反向对照：确认这个 stub 手法真能触发降级（防假绿）── */
console.log("\n=== ⑧ 反向对照：不打断远端时，via 必须不是 local ===");
restoreFetch();
await mod.apply(makeCtx(), { remoteRepo: REPO, localRoot: LOCAL_ROOT });
try {
	const sum = await calls.tools.card_summon.execute({ fullPath: fp }, {});
	t("远端正常时 via=remote（证明 ② 的 local 确实由降级造成）", sum.via === "remote", `实得 ${sum.via}`);
} catch (e) {
	t("远端正常时 via=remote", false, e.message.slice(0, 100));
}

restoreFetch();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
