/**
 * Chub API 客户端（只读）。
 *
 * 端点契约来自 `https://api.chub.ai/openapi.json`（title "Chub API" v0.2.0，197 端点在册）：
 *   · 搜索：`GET /search?search=&first=&page=` → `{data:{count,cursor,nodes[],page,previous_cursor}}`
 *   · 读卡：`GET /api/{namespace}/{creator}/{project_name}?full=true` → `{node:{definition:{...}}}`
 *     （namespace 枚举：characters / character / lorebooks / presets / extension / stage / scenario…）
 *   · PNG ：`node.max_res_url` 指向 chara_card_v2.png（内嵌 `chara` tEXt chunk）
 *
 * 三条本机实测过的坑，写在这里免得后人重踩：
 *  1) **200 不代表鉴权通过**。`/api/self` 对无效凭据不返 401，而是给占位匿名身份
 *     （id=-22358、user_name='You'）。所以不要用状态码判断 key 是否有效 —— 同理，
 *     读卡拿到 200 也要验 `node.definition` 真的在，否则可能是个空壳响应。
 *  2) **openapi 里的 security 字段不可信**。它给 `/api/public/...`、`/api/leaderboard/v1`、
 *     `/tags` 都声明了 key，但匿名实测后两者都直接 200。
 *  3) **`/api/public/...` 匿名会 500**。公开读走 `/api/{namespace}/...` 那条通配路由。
 *
 * 另：读卡返回的 `definition` 字段是给 Tavern 用的旧命名（personality 里其实是完整人设），
 * 与 V2 spec 的映射由 normalizeCard 负责，别指望字段名自解释。
 */
import { setTimeout as sleep } from "node:timers/promises";

const API = "https://api.chub.ai";
const AVATARS = "https://avatars.charhub.io";

/** 站点很可能要求真实 UA；默认 UA 在部分路径会被挡。 */
const UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** 单次请求预算。Chub 偶尔很慢，卡住比失败更糟（注入段要等它）。 */
const TIMEOUT_MS = 25_000;

export class ChubError extends Error {
	constructor(message, { status, url } = {}) {
		super(message);
		this.name = "ChubError";
		this.status = status;
		this.url = url;
	}
}

async function requestJson(url, { signal, timeoutMs = TIMEOUT_MS } = {}) {
	// 自己控超时：插件的 abort 信号与 fetch 的超时是两个独立上限，取先到的那个。
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
			// 422 是 FastAPI 的参数校验回显 —— 对调试极有价值，单独保留 detail。
			let detail = "";
			try {
				const parsed = JSON.parse(text);
				detail = parsed?.detail !== undefined ? ` ${JSON.stringify(parsed.detail).slice(0, 300)}` : "";
			} catch {
				detail = ` ${text.slice(0, 200)}`;
			}
			throw new ChubError(`Chub 返回 HTTP ${res.status}${detail}`, { status: res.status, url });
		}
		try {
			return JSON.parse(text);
		} catch {
			throw new ChubError(`Chub 返回的不是 JSON（${text.length} 字节，可能被风控页替换）`, {
				status: res.status,
				url,
			});
		}
	} catch (error) {
		if (error instanceof ChubError) throw error;
		if (error?.name === "AbortError") {
			throw new ChubError(signal?.aborted ? "请求已取消" : `请求超时（${timeoutMs}ms）`, { url });
		}
		throw new ChubError(`请求失败：${error?.message ?? error}`, { url });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", onAbort);
	}
}

/**
 * 把 Chub 的 definition 归一成卡（保留原始字段，附加便捷视图）。
 * 字段名沿用 Chub 的旧命名，注释标出它们实际是什么 —— 这些名字有误导性。
 */
export function normalizeCard(node, { fullPath } = {}) {
	const def = node?.definition ?? {};
	const creator = node?.fullPath?.split("/")?.[0] ?? fullPath?.split("/")?.[0] ?? "";
	const slug = node?.fullPath?.split("/")?.[1] ?? fullPath?.split("/")?.[1] ?? "";
	return {
		// ── 身份 ──
		fullPath: node?.fullPath ?? fullPath ?? (creator && slug ? `${creator}/${slug}` : ""),
		creator,
		slug,
		name: def.name ?? node?.name ?? "",
		// ── 人设主体：Chub 把它塞在 personality 里（实测可达 7k+ 字符），不是"性格" ──
		personality: def.personality ?? "",
		// description 是作者写给使用者的简介，不是人设 ──
		description: def.description ?? node?.description ?? "",
		scenario: def.scenario ?? "",
		firstMessage: def.first_message ?? "",
		exampleDialogs: def.example_dialogs ?? "",
		alternateGreetings: Array.isArray(def.alternate_greetings) ? def.alternate_greetings : [],
		systemPrompt: def.system_prompt ?? "",
		postHistoryInstructions: def.post_history_instructions ?? "",
		// 卡的"作者注"（酒馆 extensions.depth_prompt，默认 depth=4 / role=system）。
		// 旧版整条丢掉 —— 带它的卡会少掉作者专门写给模型的一段语气/禁忌说明。
		depthPrompt: def.extensions?.depth_prompt?.prompt ?? "",
		creatorNotes: def.creator_notes ?? "",
		// ── Tavern V2 兼容命名（导出/互操作时用） ──
		tavernPersonality: def.tavern_personality ?? "",
		// ── 元数据 ──
		tags: Array.isArray(node?.topics) ? node.topics : [],
		rating: node?.rating,
		nsfwImage: node?.nsfw_image === true,
		stats: {
			chats: node?.nChats,
			messages: node?.nMessages,
			favorites: node?.n_favorites,
			tokens: node?.nTokens,
		},
		// ── 资源 ──
		// avatar_url 是 webp 缩略图（实测几十 KB），列表/头像一律用它；
		// max_res_url 是内嵌 chara chunk 的完整 PNG，实测单张 12.9 MB —— 只在显式下载卡文件时才取。
		avatarUrl: node?.avatar_url ?? def.avatar ?? "",
		cardPngUrl: node?.max_res_url ?? "",
		// 内嵌世界书（有的话）
		lorebook: def.embedded_lorebook ?? null,
		raw: node,
	};
}

/**
 * 语言/标签过滤辅助。
 *
 * ⚠️ 实测结论（2026-10-12）：**tags 筛的是主题、不是语言**。
 *   `tags=Chinese` 返回的 57 条卡里，抽检 30 张只有 3 张内容真是中文（CJK≥30%），
 *   其余 27 张是「以中国角色为主题、但用英文写」的卡（Xianxia fantasy / Diao Chan 等）。
 *   找中文卡的**正确姿势**是：中文关键词搜索（实测 `修仙` 100%、`中文` 第一页 83% 是真中文卡）
 *   配合 `langId` 客户端过滤（实测精确率 93%、召回率 97%）。
 *
 * 保留这个映射是为了让 `tags=` 透传能力可用（用户可能想按主题筛），而不是当语言筛。
 */
export const LANG_TAGS = {
	chinese: "Chinese",
	nonEnglish: "NonEnglish",
	english: "English",
	japanese: "Japanese",
	korean: "Korean",
	russian: "Russian",
	spanish: "Spanish",
};

/** 把语言选项归一成标签数组（接受 'chinese' 或 'Chinese'）。 */
export function langTagsOf(lang) {
	if (lang === undefined || lang === null) return [];
	const arr = Array.isArray(lang) ? lang : [lang];
	const out = [];
	for (const raw of arr) {
		const key = String(raw).trim().toLowerCase();
		if (key.length === 0 || key === "all" || key === "any") continue;
		out.push(LANG_TAGS[key] ?? String(raw).trim());
	}
	return out;
}

/** 搜索卡。匿名可用（实测 count/nodes/游标分页）。 */
/**
 * 分页语义（2026-10-12 用 fullPath 反推全局偏移验证过，勿凭直觉改）：
 *   · `page` 是**标准页号**，页大小 = `first`，`首偏移 = (page-1) × first`。
 *     （曾误以为 page 是「恒 10 条/页的游标」——那是巧合，已证伪。）
 *   · **终点偏移 = count − 1**。四个不同 first（10/24/50/100）测出的终点偏移
 *     全部等于 152 = 153−1，不存在隐藏的 150/160 常量限制。
 *   · ⚠️ **深页会回吐重复条目**：first=10 查「修仙」时，page=10~15 分别重复
 *     4/2/1/0/2/1 条（唯一卡 143 / count 153）。实测规律：**页大小越大越干净**
 *     （同关键词 first=50 零重复）。所以调用方应按 fullPath 去重。
 *     「满页且全为新条目」的边界在 5 个关键词 × 逐页取样里**未出现过**。
 *   · `first` 实测支持到 100（原实现误限 50，已放宽）。
 */
export async function searchCards({ query, first = 20, page = 1, tags, lang, langId, signal } = {}) {
	const q = String(query ?? "").trim();
	// 空查询也合法：裸调用 /search 返回 200（实测）。让它返回热门，而不是报错。
	const params = new URLSearchParams();
	if (q.length > 0) params.set("search", q);
	const pageSize = Math.max(1, Math.min(100, Number(first) || 20));
	params.set("first", String(pageSize));
	params.set("page", String(Math.max(1, Number(page) || 1)));
	// tags 是 Chub 上唯一生效的标签过滤器（多个用逗号连接 = 同时满足）。
	// ⚠️ 但 tags=Chinese 筛的是**主题**不是**语言** —— 实测 30 张里只有 3 张内容真是中文
	// （其余是「以中国角色为主题、但用英文写」的卡）。找中文卡请用中文关键词 + langId 过滤。
	const tagList = [
		...langTagsOf(lang),
		...(Array.isArray(tags) ? tags : typeof tags === "string" && tags.length > 0 ? [tags] : []),
	].filter((x) => typeof x === "string" && x.length > 0);
	if (tagList.length > 0) params.set("tags", tagList.join(","));
	// 语言过滤：Chub 的 /search **没有**语言参数（实测 `lang=12` / `lang_id=12` /
	// `language=Chinese` / `lang=zh` 全被静默忽略 —— 同 query 有无 lang 的 count 完全一致）。
	// 只能拉到结果后按卡片的 lang_id 自己筛。实测（232 张样本）：
	//   精确率 93%（lang_id=12 里 194/209 真是中文）、召回率 97%（真中文卡里 194/200 标了 12）
	//   → 会漏约 3% 中文卡（如「大凤」标 24、「修仙之路」标 58），也会误收约 7%。
	const langIdFilter = langId === undefined || langId === null || langId === "all" ? undefined : Number(langId);
	const url = `${API}/search?${params.toString()}`;
	const json = await requestJson(url, { signal });
	const data = json?.data ?? {};
	const nodes = Array.isArray(data.nodes) ? data.nodes : [];
	const rawCount = nodes.length;
	const total = Number.isFinite(Number(data.count)) ? Number(data.count) : null;
	return {
		count: total,
		page: Number(data.page ?? page),
		cursor: data.cursor ?? null,
		previousCursor: data.previous_cursor ?? null,
		tags: tagList,
		items: nodes.map((node) => {
			// 搜索结果里的节点形态与读卡一致；有的包一层 node。
			const n = node?.node ?? node;
			const card = normalizeCard(n);
			return {
				fullPath: card.fullPath,
				source: "chub",
				name: card.name,
				creator: card.creator,
				tagline: oneLine(card.description, 160),
				tags: card.tags.slice(0, 8),
				rating: card.rating,
				nsfwImage: card.nsfwImage,
				avatarUrl: card.avatarUrl,
				// 语言标注：作者自选，实测不可靠（有中文卡标 24），但作客户端过滤仍是当前最优解
				langId: n?.lang_id ?? null,
				stats: card.stats,
			};
		}).filter((x) => langIdFilter === undefined || x.langId === langIdFilter),
		// hasMore：本页取满 ⇒ 还有下一页（实测终点页均不满页：修仙 3 / 校园 4 / 古风 2 /
		// 老师 8；「龙」恰好 10 条满页，故再用 count 兜一道 —— 已翻到的偏移量 < count）。
		// 注意：用**服务端返回条数**（rawCount）而非 langId 过滤后的条数判断，
		// 否则客户端过滤会让 hasMore 误判为「到底了」。
		hasMore: rawCount === pageSize && (total === null || page * pageSize < total),
		pageSize,
		// 客户端语言过滤是否生效 —— 生效时 total（服务端 count）**不能**用来算总页数：
		// 实测 langId=12 + pageSize=10 时，服务端 total=153 → 算出 16 页，
		// 但每页实际只留 ~9.5 条，第 16 页是空的。上层需据此改用保守估法。
		langFiltered: langIdFilter !== undefined,
	};
}

/** 读一张卡的完整定义。`?full=true` 才有 definition（不带的响应小得多，实测 3771B vs 16824B）。 */
export async function fetchCard(fullPath, { signal, namespace = "characters" } = {}) {
	const cleaned = String(fullPath ?? "").trim().replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || parts.some((p) => p.length === 0)) {
		throw new ChubError(`卡路径必须是 creator/slug 形式，收到：${fullPath}`);
	}
	const [creator, slug] = parts;
	// 主路由是文档化的 {namespace} 通配那条；characters 是它的枚举首值。
	const url = `${API}/api/${namespace}/${encodeURIComponent(creator)}/${encodeURIComponent(slug)}?full=true`;
	const json = await requestJson(url, { signal });
	if (json?.errors !== null && json?.errors !== undefined) {
		throw new ChubError(`Chub 报告错误：${JSON.stringify(json.errors).slice(0, 200)}`, { url });
	}
	const node = json?.node;
	// 显式判「200 但空壳」：本站对无效凭据/异常会返 200，只看状态码会把空响应当成功。
	if (node === undefined || node === null) {
		const keys = Object.keys(json ?? {});
		throw new ChubError(
			`响应里没有 node 字段（顶层键：${keys.join(", ") || "空响应"}）——` +
				`Chub 会在异常时也返 200，不要只看状态码`,
			{ status: 200, url },
		);
	}
	const card = normalizeCard(node, { fullPath: cleaned });
	// 同一条坑的第二道闸：node 在但 definition 被摘空（私密卡 / 已删除 / 未登录态降级）。
	if (card.name.length === 0 && card.personality.length === 0) {
		throw new ChubError(
			`卡 ${cleaned} 的定义为空（name 与 personality 都空）——可能是私密卡、已删除，` +
				`或该响应走了未登录降级路径`,
			{ status: 200, url },
		);
	}
	return card;
}

/**
 * 取卡的 PNG（内嵌 `chara` tEXt chunk，是酒馆生态的通用卡文件形态）。
 * 同时返回它落在哪个 URL —— UI 显示头像用同一份来源。
 */
export async function fetchCardPng(card, { signal, timeoutMs = TIMEOUT_MS } = {}) {
	const url = card?.cardPngUrl || `${AVATARS}/avatars/${card?.fullPath}/chara_card_v2.png`;
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
	const onAbort = () => ac.abort(signal?.reason);
	if (signal !== undefined) {
		if (signal.aborted) ac.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	try {
		const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ac.signal });
		if (!res.ok) throw new ChubError(`PNG 下载失败 HTTP ${res.status}`, { status: res.status, url });
		const buf = Buffer.from(await res.arrayBuffer());
		const magicOk =
			buf.length > 8 &&
			buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
		return { bytes: buf, url, magicOk, hasCharaChunk: magicOk && hasCharaChunk(buf) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", onAbort);
	}
}

/**
 * 扫 PNG chunk，找 `chara` 元数据块。
 * 逐项防越界：长度字段可能被截断（i+8+len 超过文件尾）、zTXt 是压缩的不解压、
 * 遇到 IEND 就停，非 PNG 布局也不抛错。
 */
function hasCharaChunk(buf) {
	let i = 8;
	while (i + 8 <= buf.length) {
		const len = buf.readUInt32BE(i);
		const type = buf.toString("latin1", i + 4, i + 8);
		if (type === "tEXt" || type === "iTXt" || type === "zTXt") {
			const end = Math.min(i + 8 + len, buf.length);
			const data = buf.subarray(i + 8, end);
			const zero = data.indexOf(0);
			const keyword = zero > 0 ? data.toString("latin1", 0, zero) : "";
			if (keyword === "chara" || keyword === "Chara") return true;
		}
		if (type === "IEND") break;
		// len 巨大或损坏时直接停，别让 i 溢出跑飞
		if (len > buf.length) break;
		i += 12 + len;
	}
	return false;
}

/** 压成一行并截断，避免注入段/列表被长描述撑爆。 */
export function oneLine(text, max) {
	const flat = String(text ?? "").replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
}

export { sleep, API, AVATARS, UA };
