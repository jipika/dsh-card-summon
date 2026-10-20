/**
 * client 分页逻辑断言（纯逻辑，不依赖浏览器）。
 *
 * client.js 是浏览器半边（走 window.__ModuleLoader__），不能直接 import，
 * 所以这里**复刻** client 里的判据与追加逻辑，用真实 Chub 数据跑断言 ——
 * 目的是验证判据本身对不对，而不是验证 client.js 的语法。
 *
 * 跑法：node tests/paging-check.mjs   （需要网络）
 *
 * 关键背景（实测得出，决定了判据怎么写）：
 *   · host `/search` 返回 { ok, count, page, cursor, previousCursor, items }，**没有 hasMore**
 *     —— hasMore 只在 card_search 工具里现算，client 用不上。
 *   · Chub 的 page 参数有效：page1–5 各 24 条、零重叠、count=556。
 *   · page 超出总页数时返回**空数组**且 count 不变（实测 page=999 → 0 条 / count=556）
 *     → 「上一批不足 PAGE_SIZE」是必需判据，否则空页后仍会显示「加载更多」。
 */
import { searchCards } from "../lib/chub.js";

const PAGE_SIZE = 24;
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

/* ── 复刻 client 的判据（必须与 lib/client.js 保持一致）── */
const lastBatchFull = (items) => items.length > 0 && items.length % PAGE_SIZE === 0;
const canLoadMore = (items, total, busy, exhausted = false) =>
	!busy && !exhausted && items.length > 0 && lastBatchFull(items) && (total === null || items.length < total);
const appendDedup = (prev, next) => {
	const seen = new Set(prev.map((x) => x.fullPath));
	return [...prev, ...next.filter((x) => !seen.has(x.fullPath))];
};

/* ── 复刻 client 的 doSearch 状态机（含 inFlight 幂等）── */
function makeSearcher() {
	let inFlight = false;
	const state = { items: [], total: null, page: 1, calls: 0 };
	async function doSearch(q, pageNo = 1) {
		if (inFlight) return state; // 幂等：在途时忽略
		inFlight = true;
		const append = pageNo > 1;
		try {
			state.calls += 1;
			const d = await searchCards({ query: q, first: PAGE_SIZE, page: pageNo });
			const next = Array.isArray(d.items) ? d.items : [];
			state.items = append ? appendDedup(state.items, next) : next;
			state.total = Number.isFinite(Number(d.count)) ? Number(d.count) : null;
			state.page = pageNo;
		} finally {
			inFlight = false;
		}
		return state;
	}
	return { state, doSearch };
}

console.log("=== 1) 单页搜索：判据与 count ===");
const a = await searchCards({ query: "elf", first: PAGE_SIZE, page: 1 });
t("第 1 页返回满页", a.items.length === PAGE_SIZE, `实得 ${a.items.length}`);
t("count 有值", Number.isFinite(a.count), `实得 ${a.count}`);
t("满页 + 未达 count → 可加载更多", canLoadMore(a.items, a.count, false) === true);

console.log("\n=== 2) 追加去重：逐页累加，长度单调增且无重复 ===");
const s = makeSearcher();
await s.doSearch("elf", 1);
const len1 = s.state.items.length;
await s.doSearch("elf", 2);
const len2 = s.state.items.length;
await s.doSearch("elf", 3);
const len3 = s.state.items.length;
console.log(`  累加长度: ${len1} → ${len2} → ${len3}`);
t("长度单调增", len2 > len1 && len3 > len2);
const paths = s.state.items.map((x) => x.fullPath);
t("无重复项", new Set(paths).size === paths.length, `去重后 ${new Set(paths).size} vs ${paths.length}`);
t("首页 24 条", len1 === PAGE_SIZE, `实得 ${len1}`);
t("三页共 72 条", len3 === PAGE_SIZE * 3, `实得 ${len3}`);

console.log("\n=== 3) 新搜索替换而非追加（重置到第 1 页）===");
await s.doSearch("dragon", 1);
t("换词后长度回到一页", s.state.items.length === PAGE_SIZE, `实得 ${s.state.items.length}`);
t("换词后 total 更新", s.state.total !== 556, `total=${s.state.total}`);
t("列表里不再有 elf 的条目", !s.state.items.some((x) => x.fullPath === paths[0]), "旧结果残留 ✗");

console.log("\n=== 4) 到底判据：超过总页数返回空数组时隐藏按钮 ===");
const beyond = await searchCards({ query: "elf", first: PAGE_SIZE, page: 999 });
t("超页返回空数组", beyond.items.length === 0, `实得 ${beyond.items.length}`);
t("超页后 count 仍不变（证明不能只看 count）", beyond.count === a.count, `${beyond.count} vs ${a.count}`);
// 模拟：已加载 5 页（120 条）后再翻，拿到空数组 → 追加后长度不变 → 判据须为 false
const fakeItems = Array.from({ length: 120 }, (_, i) => ({ fullPath: `x/${i}` }));
t("120 条时（满页、未达 556）→ 仍可加载", canLoadMore(fakeItems, 556, false) === true);
const afterEmpty = appendDedup(fakeItems, beyond.items);
t("追加空数组后长度不变", afterEmpty.length === 120);
t("**120 条仍是满页 → 单靠长度判不出来**（证明 exhausted 判据必需）", lastBatchFull(afterEmpty) === true);
// 这正是 exhausted 存在的理由：点空页后 items 不变、仍是满页，只有记录「上次空了」才能收掉按钮
t("加入 exhausted 后按钮正确隐藏", canLoadMore(afterEmpty, 556, false, true) === false);
t("未 exhausted 时仍可加载（不要误伤）", canLoadMore(fakeItems, 556, false, false) === true);

console.log("\n=== 5) items.length >= total 时隐藏 ===");
const all = Array.from({ length: 556 }, (_, i) => ({ fullPath: `y/${i}` }));
t("已加载 = count → 不可加载", canLoadMore(all, 556, false) === false);
t("已加载 > count → 不可加载", canLoadMore(all, 100, false) === false);

console.log("\n=== 6) 并发幂等：在途时重复触发只发一次请求 ===");
const c = makeSearcher();
const results = await Promise.all([
	c.doSearch("elf", 1),
	c.doSearch("elf", 1),
	c.doSearch("elf", 1),
	c.doSearch("elf", 1),
]);
t("4 次并发调用实际只发 1 个请求", c.state.calls === 1, `实得 ${c.state.calls}`);
t("返回的是同一状态对象", results.every((r) => r === c.state));
t("列表未被重复填充", c.state.items.length === PAGE_SIZE, `实得 ${c.state.items.length}`);

console.log("\n=== 7) busy 时按钮禁用（判据层）===");
t("busy=true → 不可加载", canLoadMore(fakeItems, 556, true) === false);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
