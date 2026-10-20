/**
 * 思畅（sichang.xyz）中文角色卡客户端 —— **中文原生卡库**。
 *
 * 这是本插件找到的**唯一可编程的中文卡源**。探测结论（2026-10-12，全部一手）：
 *
 *   · 列表：`GET /api/characters` → `{characters:[...], hiddenNsfwCount}`，**84 张一次全量返回**。
 *   · 服务端过滤**有效**的只有两个参数：`?q=<词>`（实测「老师」→1、「古风」→5、「林」→11、
 *     不存在的词→0）与 `?category=<分类>`（实测「古风」→5）。
 *   · **无效参数**（传了也返回全量 84，别用）：`tags`、`gender`、`search`。
 *   · **不支持分页**：`page` / `limit` / `offset` / `skip` 全部返回 84 条 → 客户端本地过滤。
 *   · 详情：`GET /api/characters/{slug}` 或 `{id}`（两种都 200）→ 顶层含
 *     `description`、`greeting`（实测 3880 字开场白）、`alternateGreetings`、
 *     `prompt{isStructured,personality,background,speakStyle}`、`tagline`、`tags`、
 *     `avatar`、`chatCount`、`nsfw`、`voice`。
 *
 * ⚠️ 一个必须兼容的形态：**很多卡的 `prompt` 三个字段都是空串**，人设实际写在
 * `description`（实测 299 字）与 `greeting`（3880 字）里。所以映射时人设主体取
 * `description`，并把 `prompt.*` 非空的字段拼进去补充；开场白取 `greeting`。
 *
 * ⚠️ 这是第三方站点：无公开 API 文档、无 rate limit 说明，接口可能随时漂移。
 * 因此这里全部走 try/catch + 结构校验，**失败时抛错让调用方回退到 Chub**，不静默注入空人设。
 */
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://sichang.xyz";
const SICHANG_SCHEME = "sichang://";

const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const TIMEOUT_MS = 20_000;

export class SichangError extends Error {
	constructor(message, { status, url } = {}) {
		super(message);
		this.name = "SichangError";
		this.status = status;
		this.url = url;
	}
}

/** 卡标识：sichang://<slug>。前缀用于跨源分发；source 字段才是权威。 */
export function sichangRef(slug) {
	return `${SICHANG_SCHEME}${String(slug ?? "").trim()}`;
}

export function isSichangRef(ref) {
	return String(ref ?? "").startsWith(SICHANG_SCHEME);
}

/** 从各种输入形态里取 slug。 */
export function slugOf(ref) {
	const s = String(ref ?? "").trim();
	return s.startsWith(SICHANG_SCHEME) ? s.slice(SICHANG_SCHEME.length) : s;
}

async function requestJson(url, { signal, timeoutMs = TIMEOUT_MS } = {}) {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
	const onAbort = () => ac.abort(signal?.reason);
	if (signal !== undefined) {
		if (signal.aborted) ac.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const res = await fetch(url, {
			headers: { Accept: "application/json", "User-Agent": UA },
			signal: ac.signal,
		});
		const text = await res.text();
		if (!res.ok) {
			// 403 常见于 Cloudflare 拦截页（同批探测里 aicharactercards 就是这个形态）
			const hint = res.status === 403 ? "（可能被 WAF 拦截）" : "";
			throw new SichangError(`思畅返回 HTTP ${res.status}${hint}`, { status: res.status, url });
		}
		try {
			return JSON.parse(text);
		} catch {
			throw new SichangError(`思畅返回的不是 JSON（${text.length} 字节，可能被拦截页替换）`, {
				status: res.status,
				url,
			});
		}
	} catch (error) {
		if (error instanceof SichangError) throw error;
		if (error?.name === "AbortError") {
			throw new SichangError(signal?.aborted ? "请求已取消" : `请求超时（${timeoutMs}ms）`, { url });
		}
		throw new SichangError(`请求失败：${error?.message ?? error}`, { url });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", onAbort);
	}
}

/** 列表项 → 精简视图（面板用）。 */
function toListItem(c) {
	return {
		fullPath: sichangRef(c?.slug ?? c?.id ?? ""),
		id: c?.id ?? null,
		slug: c?.slug ?? c?.id ?? "",
		source: "sichang",
		name: c?.name ?? "",
		creator: String(c?.creatorUsername ?? "").trim(),
		tagline: String(c?.tagline ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
		tags: [],
		category: c?.category ?? null,
		gender: c?.gender ?? null,
		chatCount: c?.chatCount ?? null,
		favoriteCount: c?.favoriteCount ?? null,
		nsfw: c?.nsfw === true,
		rating: c?.nsfw === true ? 18 : 0,
		nsfwImage: false,
		avatarUrl: c?.avatar ?? c?.portrait ?? "",
		langId: 12, // 中文原生，恒为中文
		stats: { chats: c?.chatCount ?? null, favorites: c?.favoriteCount ?? null },
	};
}

/**
 * 列卡。支持 `?q=` 模糊词与 `?category=` 分类（服务端过滤，实测有效）。
 * 无分页，一次全量；`q`/`category` 都不传则返回全部 84 张。
 */
export async function listSichang({ query, category, signal } = {}) {
	const params = new URLSearchParams();
	const q = String(query ?? "").trim();
	if (q.length > 0) params.set("q", q);
	const cat = String(category ?? "").trim();
	if (cat.length > 0) params.set("category", cat);
	const url = `${API}/api/characters${params.size > 0 ? `?${params}` : ""}`;
	const json = await requestJson(url, { signal });
	const arr = Array.isArray(json?.characters) ? json.characters : null;
	// 结构校验：字段改名/被拦截时宁可报错，也不返回空列表冒充成功
	if (arr === null) {
		throw new SichangError(`响应里没有 characters 数组（顶层键：${Object.keys(json ?? {}).join(", ") || "空"}）`, {
			url,
		});
	}
	return {
		source: "sichang",
		total: arr.length,
		items: arr.map(toListItem),
	};
}

/**
 * 拉单卡完整定义，映射成与 Chub 卡**同构**的内部结构
 * （这样 composeSummon 不用改，直接复用注入契约）。
 *
 * 映射依据（实测该卡 prompt 三字段全空，人设靠 description + greeting）：
 *   personality   ← description（人设主体）+ prompt.personality/background/speakStyle 非空部分
 *   firstMessage  ← greeting（实测 3880 字）
 *   scenario      ← tagline（标签式氛围串）
 *   description   ← tagline（对外简介）
 */
export async function fetchSichangCard(slugOrRef, { signal } = {}) {
	const slug = slugOf(slugOrRef);
	if (slug.length === 0) throw new SichangError("缺少 slug");
	const url = `${API}/api/characters/${encodeURIComponent(slug)}`;
	const c = await requestJson(url, { signal });
	if (c === null || typeof c !== "object" || (c.name === undefined && c.description === undefined)) {
		throw new SichangError(`卡 ${slug} 的响应结构异常（缺少 name/description）`, { url });
	}

	// 人设主体：description 优先，再把 prompt 里非空的字段拼上（实测常为空，但不能假设）
	const promptParts = [];
	const p = c.prompt ?? {};
	if (typeof p.personality === "string" && p.personality.trim().length > 0) promptParts.push(p.personality.trim());
	if (typeof p.background === "string" && p.background.trim().length > 0) promptParts.push(p.background.trim());
	if (typeof p.speakStyle === "string" && p.speakStyle.trim().length > 0) {
		promptParts.push(`说话风格：${p.speakStyle.trim()}`);
	}
	// 思畅的卡普遍是「短卡」（实测 description 常为 0、greeting 仅 100–200 字，
	// 与 Chub 动辄 7000 字的 card 形态完全不同）。所以人设按优先级兜底：
	//   description → prompt.* → tagline → greeting 摘要
	// 保证 composeSummon 的「角色定义」段不会是空的（那会让模型凭空编人设）。
	const base = String(c.description ?? "").trim();
	const fallback = [];
	if (base.length === 0) {
		const tag = String(c.tagline ?? "").trim();
		if (tag.length > 0) fallback.push(tag);
		const greet = String(c.greeting ?? "").trim();
		if (greet.length > 0) fallback.push(greet.slice(0, 500));
	}
	const personality = [base, ...fallback, ...promptParts].filter((x) => x.length > 0).join("\n\n");

	const greetings = Array.isArray(c.alternateGreetings) ? c.alternateGreetings.filter((g) => typeof g === "string") : [];

	return {
		source: "sichang",
		fullPath: sichangRef(slug),
		creator: c.creatorUsername ?? "",
		slug,
		name: c.name ?? "",
		personality,
		description: String(c.tagline ?? c.description ?? ""),
		scenario: String(c.tagline ?? "").trim(),
		firstMessage: String(c.greeting ?? ""),
		exampleDialogs: "",
		alternateGreetings: greetings,
		systemPrompt: "",
		postHistoryInstructions: "",
		creatorNotes: "",
		tavernPersonality: "",
		tags: Array.isArray(c.tags) ? c.tags : [],
		tagline: String(c.tagline ?? ""),
		category: c.category ?? null,
		gender: c.gender ?? null,
		nsfw: c.nsfw === true,
		rating: c.nsfw === true ? 18 : 0,
		nsfwImage: false,
		voice: c.voice ?? null,
		series: c.series ?? null,
		stats: { chats: c.chatCount ?? null, favorites: c.favoriteCount ?? null },
		avatarUrl: c.avatar ?? c.portrait ?? "",
		cardPngUrl: "",
		lorebook: null,
		langId: 12,
		raw: c,
	};
}

export { sleep, API, SICHANG_SCHEME };
