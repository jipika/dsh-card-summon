/**
 * dsh-card-summon — Host half
 *
 * 把 Chub 上的 AI 角色卡「召唤」进当前会话：抓卡 → 渲染成系统提示段 → 该会话后续每轮
 * 都以这个角色的身份说话。未召唤的会话完全不受影响（求值器返回空串，零注入）。
 *
 * 依赖服务：systemPrompt（注入段）、tools（模型侧工具）、webServer（UI 路由）、agents（取会话 id）
 *
 * 设计要点（照搬本机已验证的 dsh-workbuddy-summon，不重新发明）：
 *   · 三条硬规则：求值器只查表 / 未召唤=空串 / 长正文必须截断。
 *   · 每张卡在**召唤那一刻**抓完并落盘，重启后从盘读回，不必回网重算。
 *   · 状态自持在 ~/.dsh/card-summon/，不写 profile，改完即生效。
 *   · 内容不过滤：卡的原文照注入；只有「疑似未成年元数据」会要求用户显式确认（不删改内容）。
 */
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { ChubError, fetchCard, searchCards } from "./lib/chub.js";
import { fetchSichangCard, isSichangRef, listSichang, SichangError } from "./lib/sichang.js";
import {
	buildLocalIndex,
	isLocalRef,
	loadLocalIndex,
	localRef,
	LocalError,
	normalizeLocalCard,
	personaFromBook,
	queryLocalIndex,
	readLocalCardFile,
	relOf,
	saveLocalIndex,
} from "./lib/local.js";
import {
	buildRemoteMap,
	cacheInfo,
	fetchRemoteCard,
	fetchRemoteImage,
	fetchRemoteIndex,
	fetchRemoteManifest,
	RemoteError,
	setTokenResolver,
} from "./lib/remote.js";
import {
	composeSummon,
	composeSlots,
	composeCast,
	composeDynamicLore,
	cardView,
	detectMinorFlag,
	dynamicSourceOf,
	hasAssistantMessage,
	mergeDynamicSources,
	recentTextOf,
	DYNAMIC_SCAN_DEPTH,
	SLOTS,
	SECTION_NAME,
	SECTION_ORDER,
	BUDGET,
} from "./lib/inject.js";
import { markdownizeCard } from "./lib/markdownize.js";
import {
	STATE_ROOT,
	MAX_SUMMON_SESSIONS,
	clearSummon,
	getSummon,
	listSummons,
	loadCardFile,
	loadSectionFromDisk,
	pruneSummons,
	sessionIdOf,
	setSummon,
	sweepSectionFiles,
	writeCardFile,
	writeSectionFile,
} from "./lib/state.js";
import {
	extractFromCard,
	loadVars,
	resolveVarsFor,
	setVar,
	varsPath,
} from "./lib/vars.js";
import {
	addQuickReply,
	qrPath,
	removeQuickReply,
	resolveQuickReplies,
	updateQuickReply,
} from "./lib/quick-replies.js";

export const name = "dsh-card-summon";
// sessions / sessionController 只服务 Quick Reply 的投递（把按钮正文当作「用户发的消息」）。
// 参考官方 schedule 插件的同类需求：它 inject 的也是 agents + sessions + sessionController。
export const inject = ["systemPrompt", "tools", "webServer", "agents", "sessions", "sessionController"];

const ROUTE = "/dsh-card-summon";

function log(...args) {
	console.log("[dsh-card-summon]", ...args);
}

/** 当前会话 id（工具调用时用）。 */
function currentSessionId(ctx) {
	const agent = ctx.agents?.currentInitiator?.() ?? ctx.agents?.requireInitiator?.();
	return sessionIdOf(agent);
}

function reply(res, status, obj) {
	try {
		res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
		res.end(JSON.stringify(obj));
	} catch {
		/* 客户端已断开 */
	}
}

/**
 * 工具返回的统一 JSON 渲染。**签名与返回类型都不能改。**
 *
 * ⚠️ 宿主契约（/tmp/dsh-src `packages/core/tools/src/index.ts`，v0.2.1 @d7432673 核对）：
 *     :218   render(args: unknown, value: JsonValue): ContentBlock[]
 *     :1845  rendered = tool.output.render(exec.arguments, value)   // 第 1 参是 args
 *
 * 原先写成 `function jsonRender(value) { return { type: "text", ... } }` —— 一句话踩两个坑：
 *   ① 参数位错：收到的 `value` 其实是 `exec.arguments`（工具入参），所以渲染出来的永远是
 *      入参而不是执行结果 —— 即使返回值类型对了，模型看到的仍是错的。
 *   ② 返回类型错：返回单个对象而非 ContentBlock[]。宿主把渲染结果直接作为工具结果的
 *      `content` 往下传，任何对 content 做数组操作的消费点都会抛
 *      `TypeError: content.filter is not a function`
 *      （实测消费点：`experimental/claude-code-mods/src/host-ops.ts:114` 的 `textOf(content: readonly ContentBlock[])`，
 *        与 hooks-claude-code:326 / hooks-codex:289 同构；tools 包内亦有 `ptc.ts:644` 的 `result.content.some`）。
 *
 * 该错误不是局部故障：本插件 7 个工具全部走 jsonRender，一处写错 → search/read/status/summon/cast/
 * unsummon/local_scan **一起失效**（用户侧表现为「插件所有工具都报同一个错」）。
 * 两个坑必须同时修：只补数组包装，渲染的仍是 args。
 */
function jsonRender(_args, value) {
	return [{ type: "text", text: JSON.stringify(value, null, 2) }];
}

/* ─────────────── 卡字段读取（card_read 与阵容共用） ─────────────── */

/** 卡 → 可读字段映射（键名与 card_read 的 enum 一致）。 */
function cardFields(card) {
	return {
		personality: card.personality ?? "",
		description: card.description ?? "",
		scenario: card.scenario ?? "",
		first_message: card.firstMessage ?? "",
		example_dialogs: card.exampleDialogs ?? "",
		system_prompt: card.systemPrompt ?? "",
		post_history_instructions: card.postHistoryInstructions ?? "",
		alternate_greetings: Array.isArray(card.alternateGreetings)
			? card.alternateGreetings.map((g, i) => `── #${i + 1} ──\n${g}`).join("\n\n")
			: "",
		lorebook: card.lorebook === null || card.lorebook === undefined ? "" : JSON.stringify(card.lorebook, null, 1),
	};
}

/** 从卡里取字段原文（支持偏移分段，长文不一次爆上下文）。 */
function readCardField(card, { field = "all", from = 0, maxChars = 20_000 } = {}) {
	const MAP = cardFields(card);
	const pick = (text) => {
		const body = String(text ?? "");
		const slice = body.slice(from, from + maxChars);
		return { text: slice, original: body.length, nextFrom: from + maxChars < body.length ? from + maxChars : null };
	};
	if (field === "all") {
		const out = {};
		const sizes = {};
		for (const [k, v] of Object.entries(MAP)) {
			sizes[k] = String(v ?? "").length;
			const r = pick(v);
			if (r.text.length === 0) continue;
			out[k] = { text: r.text, original: r.original, nextFrom: r.nextFrom };
		}
		return { fields: out, sizes };
	}
	if (!(field in MAP)) throw new Error(`未知字段 ${field}（可用：all / ${Object.keys(MAP).join(" / ")}）`);
	return { field, ...pick(MAP[field]) };
}

/* ─────────────── 双源分发：中文站优先，失败回退 Chub ─────────────── */

/** 数据源标识。Chub 是国际站（英文为主），sichang 是中文原生卡库。 */
export const SOURCES = ["all", "sichang", "chub", "local"];

/**
 * 统一搜索。`source` 决定走哪个源：
 *   "sichang" → 只用中文站；"chub" → 只用 Chub；"all"（默认）= 两边都取再合并。
 * 中文站失败**不影响** Chub 结果（catch 成空数组并记录原因），避免第三方单点拖垮主流程。
 */
async function searchAll({ query, pageSize = 24, page = 1, langId, source = "all", localFilters = null, signal } = {}) {
	const wantSichang = source === "all" || source === "sichang";
	const wantChub = source === "all" || source === "chub";
	const wantLocal = source === "all" || source === "local";
	const notes = [];
	const items = [];
	// 双源的「总数 / 是否还有下一页」分开算，最后合并给 UI —— 两边的分页机制完全不同：
	//   · 中文站：无服务端分页（一次全量 84 张），这里做客户端切片
	//   · Chub：真页号分页，终点偏移 = count−1，深页会回吐重复条目（见 chub.js 注释）
	let sichangTotal = 0;
	let chubTotal = null;
	let sichangHasMore = false;
	let chubHasMore = false;
	let localTotal = 0;
	let localHasMore = false;
	let localFacets = null;

	if (wantSichang) {
		try {
			const r = await listSichang({ query, signal });
			const all = r.items;
			sichangTotal = all.length;
			// 客户端切片：中文站把全量一次返回，按页号切
			const start = (page - 1) * pageSize;
			const slice = all.slice(start, start + pageSize);
			items.push(...slice);
			sichangHasMore = start + pageSize < all.length;
			notes.push(
				`中文站 ${all.length} 张${String(query ?? "").trim() ? `（服务端按「${query}」过滤）` : ""}`
				+ (all.length > 0 ? `，本页 ${slice.length} 张` : ""),
			);
		} catch (error) {
			notes.push(`中文站不可用：${error?.message ?? error}`);
		}
	}
	if (wantChub) {
		try {
			const r = await searchCards({ query, first: pageSize, page, langId, signal });
			items.push(...r.items);
			// ⚠️ 客户端语言过滤生效时，服务端 count 不可用于算总页数（实测会多出翻不到的空页）。
			// 改用「保守估法」：以本页实际取到的条数反推 —— 页数 = 已翻过的页 + (还有更多 ? 1 : 0)，
			// 并在 UI 只保证「当前页可达」，翻到空页时 hasMore 自然变 false 收敛。
			if (r.langFiltered === true) {
				const perPage = Math.max(1, r.items.length || pageSize);
				chubTotal = r.hasMore === true ? (page + 1) * perPage : (page - 1) * perPage + r.items.length;
			} else {
				chubTotal = r.count;
			}
			chubHasMore = r.hasMore === true;
			notes.push(
				`Chub ${r.count ?? "?"} 条匹配${langId !== undefined && langId !== null ? "（已按语言标注过滤）" : ""}`
				+ (r.items.length > 0 ? `，本页 ${r.items.length} 条` : ""),
			);
		} catch (error) {
			notes.push(`Chub 不可用：${error?.message ?? error}`);
		}
	}

	// ── 本地卡库（PNG 卡）──
	// 与线上源不同：走**本地索引**（元数据）而非网络。查询维度可叠加（见 lib/local.js）。
	if (wantLocal) {
		try {
			// 索引来源：本地优先（快），没有则从远端拉（换机器 / 未建本地索引的场景）。
			// 远端索引 24MB gzip，首次拉完落盘，6 小时内走缓存。
			// 索引来源也听偏好：选了 GitHub 就**优先**用远端索引（否则用户切了源却发现
			// 搜索还是本地那套，会以为切换没生效）；远端不可用时回落到本地索引。
			let idx = null;
			let idxOrigin = "local";
			if (remoteEnabled() && getPreferredOrigin() === "remote") {
				try {
					idx = await ensureRemoteIndex({ signal });
					idxOrigin = idx._fromCache ? "remote-cache" : "remote";
				} catch (error) {
					notes.push(`远端索引不可用，改用本地：${String(error?.message ?? error).slice(0, 70)}`);
				}
			}
			if (idx === null) {
				idx = currentLocalIndex();
				idxOrigin = "local";
			}
			if (idx === null && remoteEnabled()) {
				try {
					idx = await ensureRemoteIndex({ signal });
					idxOrigin = idx._fromCache ? "remote-cache" : "remote";
				} catch (error) {
					notes.push(`远端索引拉取失败：${String(error?.message ?? error).slice(0, 80)}`);
				}
			}
			if (idx === null) {
				notes.push("卡库索引未建立（本地未扫描、远端未配置或不可达）");
			} else {
				if (idxOrigin !== "local") notes.push(`索引来源：${idxOrigin}`);
				const lf = localFilters ?? {};
				const r = queryLocalIndex(idx, {
					keyword: query,
					categories: lf.categories ?? null,
					months: lf.months ?? null,
					classified: lf.classified ?? null,
					hasLorebook: lf.hasLorebook ?? null,
					minPersona: lf.minPersona ?? null,
					maxPersona: lf.maxPersona ?? null,
					minContent: lf.minContent ?? null,
					maxContent: lf.maxContent ?? null,
					minBookEntries: lf.minBookEntries ?? null,
					fileTags: lf.fileTags ?? null,
					spec: lf.spec ?? null,
					sort: lf.sort ?? "name",
					offset: (page - 1) * pageSize,
					limit: pageSize,
				});
				items.push(...r.items);
				localTotal = r.total;
				localHasMore = page * pageSize < r.total;
				localFacets = r.facets;
				notes.push(`本地卡库 ${r.total} 张匹配，本页 ${r.items.length} 张`);
			}
		} catch (error) {
			notes.push(`本地卡库不可用：${error?.message ?? error}`);
		}
	}

	// 跨源去重（同名精简卡可能两边都有）；页内也可能因 Chub 深页回吐而重复
	const seen = new Set();
	const merged = items.filter((x) => {
		const k = `${x.source ?? "chub"}::${x.fullPath}`;
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
	const duplicatesRemoved = items.length - merged.length;

	// 合并后的总页数：**只在单源时可精确算**。合并（source=all）时两源数量级差很多
	// （中文站 84、Chub 可能 3.8 万），用 max 会得到 3800 页这种对合并结果毫无意义的数字。
	// 故：单源 → ceil(该源 total / pageSize)；合并 → 以「当前页 + 是否还有下一页」给出
	// 保守的可翻页数（至少 page+1，还有更多就再给一段），避免误导用户以为能翻 3800 页。
	let total;
	let totalPages;
	if (source === "sichang") {
		total = sichangTotal;
		totalPages = Math.max(1, Math.ceil(sichangTotal / pageSize));
	} else if (source === "chub") {
		total = chubTotal ?? merged.length;
		totalPages = Math.max(1, Math.ceil((chubTotal ?? merged.length) / pageSize));
	} else if (source === "local") {
		// 本地源可精确算（索引里就是全集）
		total = localTotal;
		totalPages = Math.max(1, Math.ceil(localTotal / pageSize));
	} else {
		// 合并：给一个「已探索到的上界」——各源里已知的较大可翻页，但封顶，避免无意义的巨大数字。
		const sPages = Math.max(1, Math.ceil(sichangTotal / pageSize));
		const cPages = chubTotal !== null ? Math.ceil(chubTotal / pageSize) : 0;
		const lPages = wantLocal ? Math.max(1, Math.ceil(localTotal / pageSize)) : 0;
		totalPages = Math.max(sPages, lPages, Math.min(cPages, page + 9)); // Chub 最多再给 10 页探索空间
		if (sichangHasMore || chubHasMore || localHasMore) totalPages = Math.max(totalPages, page + 1);
		total = totalPages * pageSize;
	}

	return {
		source,
		page,
		pageSize,
		items: merged,
		notes,
		total,
		totalPages,
		hasMore: sichangHasMore || chubHasMore,
		duplicatesRemoved,
		counts: {
			items: merged.length,
			sichang: merged.filter((x) => x.source === "sichang").length,
			local: merged.filter((x) => x.source === "local").length,
			chub: merged.filter((x) => x.source === "chub").length,
		},
		totals: { sichang: sichangTotal, chub: chubTotal, local: localTotal },
		// 本地源的分面统计（面板据此渲染筛选下拉的计数）
		localFacets,
	};
}

/**
 * 派生字段收口：`personaDerived` 一律**现算**，不信任任何来源的快照。
 *
 * 为什么必须收在这里：远程取卡路径（fetchAnyCard 的 remote 分支）是**整对象透传**
 * 远端 JSON 的，而远端 JSON 里的 `personaDerived` 是**当初推送索引时用当时的预算
 * 生成并写死的快照**。实测这张卡：远端快照 6005 字符（6000 预算的产物，连
 * `personaDerivedDropped` 字段都不存在），尾部正好断在 `phase_1_布局` 的
 * `event: "丈夫({{user}})的异…`；而用同一份 lorebook 现算应是 12759 字符、6 条全进。
 *
 * 「整对象透传、不手工枚举 key」这条设计本身是对的（枚举会漏字段），但**它只适用于
 * 源数据**；`personaDerived` 是能从 `lorebook` 现算的**派生值**，透传快照会让提炼逻辑的
 * 任何升级对 remote 路径永远失效 —— 用户视角就是「改了半天重新召唤还是没反应」。
 *
 * 判定用 personality：它非空时 personaDerived 本就该是空串（注入层走 personality 分支）。
 */
function withFreshPersona(card) {
	if (card === null || card === undefined) return card;
	const hasPersona = typeof card.personality === "string" && card.personality.trim().length > 0;
	if (hasPersona) return { ...card, personaDerived: "", personaDerivedDropped: [] };
	const book = card.lorebook;
	if (book === null || book === undefined) return card;
	const fresh = personaFromBook(book, bookPersona);
	return { ...card, personaDerived: fresh.text, personaDerivedDropped: fresh.dropped };
}

/**
 * 统一取卡。按 ref 前缀路由到对应源；找不到源就报错（不静默换源，否则用户会
 * 拿到一张名字不同、内容完全无关的卡）。
 */
async function fetchAnyCard(ref, { signal } = {}) {
	if (isSichangRef(ref)) return fetchSichangCard(ref, { signal });
	if (isLocalRef(ref)) {
		const rel = relOf(ref);

		// ── 取数顺序由用户选的来源决定（面板「本地磁盘 / GitHub」切换）──
		// 默认 remote（用户要求「都连到远程」）；切到本地就本地优先。
		// 无论走哪条，失败都降级到另一条，两边都不行才报错。
		if (remoteEnabled() && getPreferredOrigin() === "remote") {
			try {
				// 必须经 manifest 的 src→card 映射：远端正文用六位 id（000341.json），
				// 且分类层级与本地不同，**不能靠路径拼接**。
				// 实测 11480 条本地 rel 与 manifest 的 src 一一对应（0 缺口）。
				const map = await ensureRemoteMap(signal);
				const hit = map.get(rel);
				if (hit === null) throw new RemoteError(`远端 manifest 里没有这张卡：${rel}`);
				const body = await fetchRemoteCard(hit.card, { cfg: remoteConfig, signal });
				// 远端 JSON 与本地内部模型**逐键同构**（实测 16/16 一致），
				// 所以整个对象透传 + 补上本地模型特有的字段即可 ——
				// 不要手工枚举 key（枚举会漏，将来新增字段会静默丢失）。
				//
				// ⚠️ 但**派生字段不能透传**：`personaDerived` 是远端推送时的旧快照
				// （实测 6005 字符、断在 phase_1，且不含主角人设与文风语料库），
				// 必须用当前 lorebook 现场重算，否则提炼逻辑的升级对 remote 路径永远无效。
				return withFreshPersona({
					...body,
					source: "local",
					via: "remote",
					fullPath: ref,
					creator: body.category ?? "",
					slug: rel.split("/").pop()?.replace(/\.png$/i, "") ?? "",
					tags: [body.category, body.month].filter(Boolean),
					creatorNotes: body.creatorNotes ?? "",
					tavernPersonality: body.tavernPersonality ?? "",
					nsfw: body.nsfw === true,
					rating: body.rating ?? null,
					nsfwImage: false,
					stats: body.stats ?? null,
					avatarUrl: body.avatarUrl ?? "",
					cardPngUrl: body.cardPngUrl ?? "",
					langId: body.langId ?? 12,
					raw: body,
				});
			} catch (error) {
				if (!localReadable(ref)) {
					throw new LocalError(
						`远程与本地都读不到：${error?.message ?? error}；本地根目录 ${localConfigRoot || "(未配置)"}`,
					);
				}
				log(`远程取卡失败，降级本地：${String(error?.message ?? error).slice(0, 80)}`);
			}
		}

		// 降级：本地读
		const idx = currentLocalIndex();
		const root = localConfigRoot;
		if (typeof root !== "string" || root.length === 0) {
			throw new LocalError("读不到卡：远程未启用，且本地卡库根目录未配置");
		}
		let parsed;
		try {
			parsed = readLocalCardFile(join(root, rel));
		} catch (error) {
			throw new LocalError(
				`读本地卡失败：${error?.message ?? error}（外置盘未挂载？根目录 ${root}）`,
			);
		}
		const entry = idx?.entries?.find((e) => e.rel === rel);
		// `via` 必须标出来：远程优先之后，token 失效会**静默降级到本地** ——
		// 不标的话界面上完全看不出这张卡是从磁盘读的还是从 GitHub 拉的，
		// 用户会以为远程一直在工作（实测：本地路径原先不带 via，恒为 undefined）。
		return {
			...normalizeLocalCard(parsed, {
				file: rel,
				fullPath: ref,
				category: entry?.category ?? null,
				month: entry?.month ?? null,
				classified: entry?.classified ?? false,
				fileTags: entry?.fileTags ?? [],
				maxBookPersona: bookPersona,
			}),
			via: "local",
		};
	}
	return fetchCard(ref, { signal });
}


/* ───────────────────── 封面缩略图（替换原先的 PNG 截断方案） ───────────────────── */

/**
 * 缩略图缓存目录。
 *
 * 全部缓存放这里，按「相对路径 + 源文件 mtime/size + 目标像素」做键：
 *   · 只哈希文件名 → 卡库多级目录里同名文件会串图
 *   · 只哈希路径   → 原图被换掉后旧缩略图永远生效
 * 所以三者都要进键。
 */
const THUMB_DIR = join(STATE_ROOT, "thumbs");
/** macOS 有 sips；探测失败只记一次，避免每次请求都 spawn 一个必然失败的命令。 */
let sipsAvailable = null;

function thumbKey(rel, st, px) {
	return createHash("sha1").update(`${rel}|${st.size}|${Math.round(st.mtimeMs)}|${px}`).digest("hex") + `.${px}.jpg`;
}

/** sips 能否用（结果缓存，失败只记一次日志）。 */
function hasSips() {
	if (sipsAvailable !== null) return sipsAvailable;
	try {
		execSync("command -v sips", { stdio: ["ignore", "ignore", "ignore"] });
		sipsAvailable = true;
	} catch {
		sipsAvailable = false;
		log("未找到 sips（非 macOS？）→ 封面退回原图发送，不再截断");
	}
	return sipsAvailable;
}

/** 读缓存并校验（坏缓存自愈删除）。 */
function readThumb(file) {
	try {
		const buf = readFileSync(file);
		// 校验 JPEG 魔数 + 结尾 EOI，坏文件删掉重生成
		if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
			try { unlinkSync(file); } catch { /* 删不掉就算了 */ }
			return null;
		}
		return buf;
	} catch {
		return null;
	}
}

/**
 * 取（或生成）缩略图。失败返回 null，由调用方退回原图。
 * 原子写入：先写 .tmp 再 rename，避免并发请求读到半个文件。
 */
function thumbnailOf(abs, rel, px) {
	if (!hasSips()) return null;
	try {
		mkdirSync(THUMB_DIR, { recursive: true });
		const st = statSync(abs);
		const dest = join(THUMB_DIR, thumbKey(rel, st, px));
		const hit = readThumb(dest);
		if (hit !== null) return hit;

		const tmp = `${dest}.${process.pid}.tmp`;
		try {
			execSync(`sips -Z ${px} -s format jpeg -s formatOptions 72 ${JSON.stringify(abs)} --out ${JSON.stringify(tmp)}`, {
				stdio: ["ignore", "ignore", "ignore"],
				timeout: 20_000,
			});
			renameSync(tmp, dest);
		} catch (error) {
			try { unlinkSync(tmp); } catch { /* 忽略 */ }
			return null;
		}
		return readThumb(dest);
	} catch {
		return null;
	}
}

/** 缓存体积与条数（供 /thumbs 路由查看/清理）。 */
function thumbsStats() {
	try {
		const files = readdirSync(THUMB_DIR);
		let bytes = 0;
		for (const f of files) {
			try { bytes += statSync(join(THUMB_DIR, f)).size; } catch { /* 跳过 */ }
		}
		return { count: files.length, bytes };
	} catch {
		return { count: 0, bytes: 0 };
	}
}

/** 超过上限时按 mtime 删最旧的（不做复杂 LRU，够用）。 */
const THUMB_CACHE_MAX_BYTES = 512 * 1024 * 1024;
function pruneThumbs() {
	try {
		const files = readdirSync(THUMB_DIR).map((f) => {
			try {
				const st = statSync(join(THUMB_DIR, f));
				return { f, size: st.size, mtime: st.mtimeMs };
			} catch {
				return null;
			}
		}).filter(Boolean);
		let total = files.reduce((a, x) => a + x.size, 0);
		if (total <= THUMB_CACHE_MAX_BYTES) return 0;
		files.sort((a, b) => a.mtime - b.mtime);
		let removed = 0;
		for (const x of files) {
			if (total <= THUMB_CACHE_MAX_BYTES) break;
			try { unlinkSync(join(THUMB_DIR, x.f)); total -= x.size; removed++; } catch { /* 跳过 */ }
		}
		return removed;
	} catch {
		return 0;
	}
}

/** 本地这张卡是否可读（用于决定失败时该报「都读不到」还是可降级）。 */
function localReadable(ref) {
	const root = localConfigRoot;
	if (typeof root !== "string" || root.length === 0) return false;
	try {
		readLocalCardFile(join(root, relOf(ref)));
		return true;
	} catch {
		return false;
	}
}

/** 本地卡库根目录（apply 时从插件配置注入）。 */
let localConfigRoot = "";
/**
 * 世界书常驻条目（`constant: true`）的注入预算（字符）。
 *
 * 这不是「随便定的数字」：一张 6 条常驻共 12749 字的卡在 6000 下会丢掉整条主角人设。
 * 默认给 20000（容下绝大多数中文卡的全部常驻条目），并开放 config.maxBookPersona 覆盖 ——
 * 预算该由「这张卡有多大 / 还剩下多少上下文」决定，而不是写死在提炼函数里。
 */
let bookPersona = 20_000;
/** 远程卡库配置（apply 时从插件配置注入）。 */
let remoteConfig = null;
/** `src → {card, cover}` 映射（懒加载，来自远端 manifest）。 */
let remoteMapCache = null;
let remoteIndexCache = null;

/**
 * 取数来源偏好：`local`（本地磁盘）或 `remote`（GitHub）。
 *
 * 为什么要这个开关 —— 两侧是**同一批 11480 张卡**（实测 rel 集合完全相同：
 * 仅本地 0 / 仅远端 0 / 交集 11480，抽样字段也一致），只是取数路径不同：
 *   · local  ：读外置盘，封面走 sips 缩略图（一屏 24 张 ≈ 0.42MB）
 *   · remote ：走 GitHub raw，封面**首次**要拉整张 PNG（中位 880KB，
 *              一屏 ≈ 20.6MB），之后命中本地缩略图缓存就快了
 * 所以这不是「两批不同的卡」，而是「同一批卡的两种取法」——文案要准确。
 */
let preferredOrigin = "remote";

function getPreferredOrigin() {
	return preferredOrigin;
}

function setPreferredOrigin(value) {
	if (value === "local" || value === "remote") preferredOrigin = value;
	return preferredOrigin;
}

/** 远程是否启用（配置了 repo 即启用）。 */
function remoteEnabled() {
	return remoteConfig !== null && typeof remoteConfig.repo === "string" && remoteConfig.repo.length > 0;
}

/** 拿远端映射（首次会拉 4.2MB manifest，之后走缓存）。 */
async function ensureRemoteMap(signal) {
	if (remoteMapCache !== null) return remoteMapCache;
	const man = await fetchRemoteManifest({ cfg: remoteConfig, signal });
	remoteMapCache = buildRemoteMap(man);
	return remoteMapCache;
}

/** 拿远端索引（首次拉 24MB gzip，之后 6 小时内走磁盘缓存）。 */
async function ensureRemoteIndex({ force = false, signal } = {}) {
	if (!force && remoteIndexCache !== null) return remoteIndexCache;
	remoteIndexCache = await fetchRemoteIndex({ cfg: remoteConfig, force, signal });
	return remoteIndexCache;
}
/** 索引内存缓存：避免每次查询都读 4MB JSON。 */
let localIndexCache = null;
function currentLocalIndex(force = false) {
	if (!force && localIndexCache !== null) return localIndexCache;
	localIndexCache = loadLocalIndex();
	return localIndexCache;
}

/* ───────────────────────── 注入段缓存（内存 Map，求值器只读它） ───────────────────────── */

/** sessionId → { slots, text, fullPath, name, chars, truncatedFields, minorFlag, kind?, dynSource?, at } */
const sections = new Map();

/**
 * 非空槽位的字符数（给 card_status 与面板用）。
 * 只列非空的：12 个槽位里通常只有 3-5 个有内容，全列会把面板刷满 0。
 */
function slotSizesOf(hit) {
	if (hit?.slots === undefined || hit.slots === null) return null;
	const out = {};
	for (const { key } of SLOTS) {
		const len = String(hit.slots[key] ?? "").length;
		if (len > 0) out[key] = len;
	}
	return out;
}

/** 抓卡 + 渲染 + 落盘，然后把段塞进内存 Map。这是唯一会走网络的地方。 */
async function buildSection(sessionId, card, cfg) {
	// 按酒馆的槽位模型渲染：每个槽位一条 section（顺序与依据见 lib/inject.js 的 SLOTS）。
	const composed = composeSlots(card, {
		maxPersonality: cfg?.maxPersonality,
		writingStyle: cfg?.writingStyle,
		writingStyleText: cfg?.writingStyleText,
		fictionFrame: cfg?.fictionFrame,
		fictionFrameText: cfg?.fictionFrameText,
	});
	if (composed.text.length === 0) {
		throw new Error(`卡 ${card?.fullPath ?? "(未知)"} 渲染出的注入段为空（可能没有 name/personality）`);
	}
	sections.set(sessionId, {
		// 槽位表是求值器的唯一数据源：每条 section 只读自己那一格。
		slots: composed.slots,
		text: composed.text,
		fullPath: card.fullPath,
		name: card.name,
		chars: composed.chars,
		truncatedFields: composed.truncatedFields,
		minorFlag: detectMinorFlag(card),
		// 动态世界书的候选条目（keys + 正文），求值器每轮拿它撞关键词。见 dynamicSourceOf。
		// 正文走注入前转换（标签/状态栏 → Markdown），与静态段保持同一份文本。
		dynSource: dynamicSourceOf(markdownizeCard(card)),
		// 卡自带的 depth_prompt（酒馆默认 depth=4 / role=system），已并入 phi 槽。
		at: new Date().toISOString(),
	});
	try {
		writeSectionFile(sessionId, composed.text);
		writeCardFile(sessionId, card);
	} catch (error) {
		log("段落盘失败（不影响本次注入）", error?.message ?? error);
	}
	return sections.get(sessionId);
}

/* ───────────────────────────── 工具 ───────────────────────────── */

function toolSearch() {
	return {
		name: "card_search",
		description:
			"搜角色卡（三个源）。默认 source=all 合并三源；也可只搜某一个源。" +
			"**本地卡库（source=local）支持多维度筛选**：按分类（32 个，如 修仙/古风/同人/后宫）、月份、" +
			"内容量、世界书条目数、文件名标签等任意组合。" +
			"⚠️ 本地卡的 keyword 只匹配卡名与路径（索引不存正文），搜不到人设正文里的词。" +
			"搜到后用 card_summon / card_cast 用起来。",
		parameters: {
			type: "object",
			properties: {
				query: { type: "string", description: "搜索词（角色名 / 关键词）。留空则返回热门/全部。" },
				source: {
					type: "string",
					enum: ["all", "sichang", "chub", "local"],
					description:
						"数据源。sichang = 中文站（84 张）；chub = 国际站（量大）；" +
						"local = **本地卡库（1.1 万张中文卡，支持分类筛选）**；all（默认）= 三源合并。",
				},
				categories: {
					type: "array",
					items: { type: "string" },
					description: "【本地源】按分类筛，可多选。如 [\"修仙\",\"古风\"]。先用 source=local 空查询看有哪些分类。",
				},
				months: { type: "array", items: { type: "string" }, description: "【本地源】按月份目录筛，如 [\"5-6月\"]。" },
				fileTags: { type: "array", items: { type: "string" }, description: "【本地源】按文件名标签筛，如 [\"蒸汽朋克\"]。" },
				minContent: {
					type: "number",
					description:
						"【本地源】内容总量下限（人设+开场白+世界书字符数）。**推荐用它而不是人设长度** —— " +
						"实测 48% 的卡人设为 0，内容全在世界书里。",
				},
				minBookEntries: { type: "number", description: "【本地源】世界书条目数下限（想找设定厚的卡就用它，如 50）。" },
				minDynEntries: {
					type: "number",
					description:
						"【本地源】**可触发**世界书条目数下限（非 constant 且带 keys 的条目）—— " +
						"这才是「召唤后 keys 关键词触发能吃到几条」的信号，与 minBookEntries 不是一个数：" +
						"世界书可能全是 constant（那走静态人设提炼，不吃 keys）。想找 keys 触发用得上的卡就用它，如 3。",
				},
				hasLorebook: { type: "boolean", description: "【本地源】只要带世界书的卡。" },
				langId: { type: "number", description: "【Chub 源】按卡片语言标注过滤。实测中文=12。" },
				first: { type: "number", description: "每页条数，默认 24。" },
				page: { type: "number", description: "页码，从 1 开始，默认 1。" },
				sort: {
					type: "string",
					enum: ["name", "contentDesc", "bookDesc", "dynDesc", "personaDesc", "mtimeDesc"],
					description:
						"【本地源】排序：name / contentDesc（内容最多）/ bookDesc（世界书最大）/ " +
						"dynDesc（可触发条数最多）/ personaDesc / mtimeDesc。",
				},
			},
			required: [],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args, execCtx) {
			const result = await searchAll({
				query: args?.query,
				pageSize: Number(args?.first) || 24,
				page: Number(args?.page) || 1,
				source: args?.source,
				langId: args?.langId,
				localFilters: {
					categories: args?.categories ?? null,
					months: args?.months ?? null,
					fileTags: args?.fileTags ?? null,
					hasLorebook: args?.hasLorebook ?? null,
					minContent: args?.minContent ?? null,
					minBookEntries: args?.minBookEntries ?? null,
					minDynEntries: args?.minDynEntries ?? null,
					sort: args?.sort ?? "name",
				},
				signal: execCtx?.signal,
			});
			return {
				source: result.source,
				page: result.page,
				total: result.total,
				totalPages: result.totalPages,
				hasMore: result.hasMore,
				counts: result.counts,
				totals: result.totals,
				notes: result.notes,
				// 本地源的分面统计：面板/智能体据此知道有哪些分类可选及各自数量
				localFacets: result.localFacets,
				items: result.items,
				note:
					"用 card_summon（单角色）或 card_cast（多角色开团）并传 fullPath。" +
					"本地卡的 fullPath 形如 local://<月份>/<分类>/<文件名>.png。",
			};
		},
	};
}

function toolSummon(ctx, cfg) {
	return {
		name: "card_summon",
		description:
			"把一张 Chub 角色卡召唤进**当前会话**（等价于用户在面板点「召唤」）。" +
			"生效后，该角色的定义会注入本会话的系统提示词，后续每一轮都以这个角色的人格与语气回应，" +
			"直到 card_unsummon 或用户取消。只影响当前会话。" +
			"若该卡元数据触发了疑似未成年提示，会返回 needConfirm，需带 confirm:true 重试。",
		parameters: {
			type: "object",
			properties: {
				fullPath: { type: "string", description: "卡的 creator/slug 路径（card_search 结果的 fullPath 字段）" },
				confirm: {
					type: "boolean",
					description: "仅在返回 needConfirm 时使用：用户已被明确告知提示内容并同意继续。",
				},
			},
			required: ["fullPath"],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args, execCtx) {
			const sessionId = currentSessionId(ctx);
			if (sessionId === undefined) {
				throw new Error("card_summon: 取不到当前会话 id（无法定位注入目标）");
			}
			const fullPath = String(args?.fullPath ?? "").trim();
			if (fullPath.length === 0) throw new Error("card_summon: 缺少 fullPath");

			const card = await fetchAnyCard(fullPath, { signal: execCtx?.signal });

			// 知情确认闸门：命中疑似未成年元数据时，先把话说清楚再继续。内容一字不改。
			const flag = detectMinorFlag(card);
			if (flag.flagged && args?.confirm !== true) {
				return {
					ok: false,
					needConfirm: true,
					fullPath: card.fullPath,
					name: card.name,
					why: flag.why,
					hits: flag.hits,
					note:
						"这不是插件的内容判定，也不代表插件改写了任何内容。" +
						"请把 why 原样转达用户并征得明确同意；用户同意后带 confirm:true 重新调用即可召唤。",
				};
			}

			const section = await buildSection(sessionId, card, cfg);
			setSummon(sessionId, {
				fullPath: card.fullPath,
				name: card.name,
				creator: card.creator,
				slug: card.slug,
				chars: section.chars,
				truncatedFields: section.truncatedFields.join(","),
				minorConfirmed: flag.flagged,
				// 记下这张卡是从哪来的（remote / local）—— 远程优先后，token 失效会
				// 静默降级到本地，不记就完全看不出差别（见 fetchAnyCard 注释）。
				via: card.via ?? "local",
			});
			return {
				ok: true,
				fullPath: card.fullPath,
				name: card.name,
				injectedChars: section.chars,
				via: card.via ?? "local",
				truncatedFields: section.truncatedFields,
				tags: card.tags.slice(0, 12),
				view: cardView(card),
				note: "注入已生效，从下一轮请求开始按该角色身份回应。",
			};
		},
	};
}

function toolUnsummon(ctx) {
	return {
		name: "card_unsummon",
		description: "解除当前会话的角色卡召唤，恢复默认助手人格。只影响当前会话。",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute() {
			const sessionId = currentSessionId(ctx);
			if (sessionId === undefined) throw new Error("card_unsummon: 取不到当前会话 id");
			const prev = getSummon(sessionId);
			sections.delete(sessionId);
			const removed = clearSummon(sessionId);
			return {
				ok: removed,
				was: prev === undefined ? null : { fullPath: prev.fullPath, name: prev.name },
				note: removed ? "召唤已解除，已恢复默认人格。" : "当前会话本来就没有召唤。",
			};
		},
	};
}

function toolStatus(ctx) {
	return {
		name: "card_status",
		description: "查看当前会话的召唤状态：召唤了哪张卡、注入段多大、有没有被截断的字段。",
		parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute() {
			const sessionId = currentSessionId(ctx);
			if (sessionId === undefined) throw new Error("card_status: 取不到当前会话 id");
			const record = getSummon(sessionId);
			const section = sections.get(sessionId);
			return {
				summoned: record !== undefined,
				record: record ?? null,
				injected: section?.chars ?? 0,
				// 每个槽位的实际字符数（空槽位不列）。用来确认"角色正文到底进了哪一段"。
				slots: slotSizesOf(section),
				// 这张卡是从远端拉的还是从本地磁盘读的（远程优先后，静默降级要可观测）
				via: record?.via ?? null,
				truncatedFields: section?.truncatedFields ?? [],
				minorFlag: section?.minorFlag?.flagged === true ? section.minorFlag : null,
				note: "未召唤时注入段为空，本插件对会话零影响。",
			};
		},
	};
}

/**
 * card_cast：组建阵容 —— **只读取、不注入**（默认）。
 *
 * 这是「让智能体自己去读角色卡」的主入口：
 *   · 一次读入多张卡 → 返回每张的人设正文（供你直接扮演）
 *   · inject=true 时才把阵容写进会话（像召唤那样）
 * 不注入是默认值，因为开团/写文时不该让某个角色接管主会话的人格。
 */
function toolCast(ctx, cfg) {
	return {
		name: "card_cast",
		description:
			"组建一个**多角色阵容**：一次读入多张角色卡，让智能体同时扮演（开团 / 群像 / 写文）。" +
			"默认**只读取、不注入** —— 返回每张卡的人设正文，由你照着演，不接管会话人格；" +
			"传 inject=true 才会像 card_summon 那样把整个阵容注入系统提示（此后每轮都保持）。" +
			"先用 card_search 找卡，把 fullPath 列表传进来。",
		parameters: {
			type: "object",
			properties: {
				members: {
					type: "array",
					description: "阵容成员。每项是卡的 fullPath，或 {fullPath, role}（role 是此人在团里的身份，如「队长」「反派」）。",
					items: {
						type: "object",
						properties: {
							fullPath: { type: "string", description: "卡路径" },
							role: { type: "string", description: "可选：此人在本场戏里的身份/职能" },
						},
						required: ["fullPath"],
						additionalProperties: false,
					},
				},
				inject: {
					type: "boolean",
					description: "true = 把阵容注入本会话（此后每轮生效）；默认 false = 只返回卡内容不注入。",
				},
				maxCharsPerRole: {
					type: "number",
					description: "注入模式下每人人设的字符上限，默认 12000。只读模式下表示每张卡返回的正文上限，默认 12000。",
				},
				confirm: {
					type: "boolean",
					description: "仅在返回 needConfirm 时使用：用户已被明确告知提示内容并同意继续。",
				},
			},
			required: ["members"],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args, execCtx) {
			const raw = Array.isArray(args?.members) ? args.members : [];
			if (raw.length === 0) throw new Error("card_cast: members 不能为空");
			if (raw.length > 12) throw new Error(`card_cast: 一次最多 12 人（收到 ${raw.length}）`);
			const perRole = Math.max(500, Math.min(60_000, Number(args?.maxCharsPerRole) || 12_000));

			// 逐张取卡（并行；跨源由 fetchAnyCard 分发）
			const settled = await Promise.allSettled(
				raw.map(async (m) => {
					const fp = typeof m === "string" ? m : String(m?.fullPath ?? "");
					const role = typeof m === "object" && m !== null ? m.role : undefined;
					if (fp.trim().length === 0) throw new Error("成员缺少 fullPath");
					const card = await fetchAnyCard(fp, { signal: execCtx?.signal });
					return { card, role };
				}),
			);
			const cast = [];
			const failed = [];
			settled.forEach((r, i) => {
				if (r.status === "fulfilled") cast.push(r.value);
				else failed.push({ index: i, why: String(r.reason?.message ?? r.reason) });
			});
			if (cast.length === 0) {
				throw new Error(`card_cast: 全部成员取卡失败 —— ${failed.map((f) => f.why).join("; ")}`);
			}

			// 疑似未成年知情闸门：阵容里任一命中就要求确认（内容一字不改）
			const flags = cast.map(({ card }) => ({ card, flag: detectMinorFlag(card) })).filter((x) => x.flag.flagged);
			if (flags.length > 0 && args?.confirm !== true) {
				return {
					ok: false,
					needConfirm: true,
					hits: flags.map((x) => ({ name: x.card.name, hit: x.flag.hits, why: x.flag.why })),
					note: "请把命中理由原样转达用户并征得同意；同意后带 confirm:true 重试。阵容内容不会被改写。",
				};
			}

			// 只读模式（默认）：把每张卡的人设正文直接给出来
			if (args?.inject !== true) {
				return {
					ok: true,
					mode: "read-only",
					count: cast.length,
					failed,
					members: cast.map(({ card, role }) => {
						const r = readCardField(card, { field: "all", maxChars: perRole });
						return {
							fullPath: card.fullPath,
							name: card.name,
							source: card.source ?? "chub",
							role: role ?? null,
							// 正文直接给（这是"让智能体读到卡"的关键 —— 不需要再调 card_read）
							personality: r.fields.personality?.text ?? "",
							scenario: r.fields.scenario?.text ?? "",
							firstMessage: r.fields.first_message?.text ?? "",
							description: r.fields.description?.text ?? "",
							sizes: r.sizes,
							truncated: Object.entries(r.fields)
								.filter(([, v]) => v.nextFrom !== null)
								.map(([k]) => k),
						};
					}),
					note:
						"以上是各角色的人设正文（未注入会话，你的默认人格不变）。" +
						"直接按这些人设扮演即可，用【角色名】区分发言。" +
						"需要更多细节（例对话/世界书）就 card_read({fullPath}) 只取那一段。" +
						"想让阵容持续注入后续每一轮，改用 card_cast({members, inject:true})。",
				};
			}

			// 注入模式
			const sessionId = currentSessionId(ctx);
			if (sessionId === undefined) throw new Error("card_cast: 取不到当前会话 id（无法注入）");
			const composed = composeCast(cast, {
				maxPersonalityPerRole: perRole,
				writingStyle: cfg?.writingStyle,
				writingStyleText: cfg?.writingStyleText,
				fictionFrame: cfg?.fictionFrame,
				fictionFrameText: cfg?.fictionFrameText,
			});
			if (composed.text.length === 0) throw new Error("card_cast: 渲染出的阵容注入段为空");
			const minorFlag = flags.length > 0 ? { flagged: true, hits: flags.flatMap((x) => x.flag.hits) } : { flagged: false };
			sections.set(sessionId, {
				// 阵容不是单卡槽位模型：整段放进 main 槽，其余槽位留空（求值器返回空串即不注入）。
				slots: { main: composed.text },
				text: composed.text,
				fullPath: cast.map(({ card }) => card.fullPath).join(","),
				name: `阵容(${composed.cast.length}人)：${composed.cast.join("、")}`,
				chars: composed.chars,
				truncatedFields: composed.truncatedFields,
				minorFlag,
				kind: "cast",
				// 阵容的动态世界书是各成员的合并表（按成员顺序）。
				dynSource: mergeDynamicSources(cast.map(({ card }) => card)),
				at: new Date().toISOString(),
			});
			try {
				writeSectionFile(sessionId, composed.text);
				writeCardFile(sessionId, { kind: "cast", members: cast.map(({ card, role }) => ({ card, role })) });
			} catch (error) {
				log("阵容段落盘失败（不影响本次注入）", error?.message ?? error);
			}
			setSummon(sessionId, {
				fullPath: cast.map(({ card }) => card.fullPath).join(","),
				name: `阵容(${composed.cast.length}人)：${composed.cast.join("、")}`,
				kind: "cast",
				chars: composed.chars,
				truncatedFields: composed.truncatedFields.join(","),
				minorConfirmed: flags.length > 0,
			});
			return {
				ok: true,
				mode: "injected",
				count: composed.cast.length,
				cast: composed.cast,
				injectedChars: composed.chars,
				truncatedFields: composed.truncatedFields,
				failed,
				note: "阵容已注入，从下一轮开始你同时扮演这些人。",
			};
		},
	};
}

/**
 * card_local_scan：扫描本地卡库建索引（一次性，约 30 秒 / 1.1 万张）。
 * 之后查询走内存索引，不再扫盘。
 */
function toolLocalScan(ctx, cfg) {
	return {
		name: "card_local_scan",
		description:
			"扫描本地角色卡库（PNG 卡目录）并建立索引。索引只存元数据（卡名/分类/人设长度/世界书条目数等），" +
			"**不复制卡正文**。约 1 万张耗时 30 秒左右；之后查询走内存索引，可毫秒级按分类/月份/内容量等多维度筛选。" +
			"已建索引时不必重复调用，除非卡库有更新。",
		parameters: {
			type: "object",
			properties: {
				root: { type: "string", description: "卡库根目录；省略则用插件配置的 localRoot。" },
				force: { type: "boolean", description: "true = 强制重建（默认 false 时若已有索引直接返回概况）。" },
			},
			required: [],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args) {
			const root = String(args?.root ?? "").trim() || localConfigRoot;
			if (root.length === 0) {
				throw new Error("card_local_scan: 缺少卡库根目录（传 root，或在 cordis.patch.yml 配置 localRoot）");
			}
			if (args?.force !== true) {
				const existing = currentLocalIndex(true);
				if (existing !== null && existing.root === root) {
					return {
						ok: true,
						cached: true,
						root,
						cards: existing.entries.length,
						failed: existing.failed?.length ?? 0,
						builtAt: existing.builtAt,
						note: "已有索引，直接返回。要重建传 force:true。",
					};
				}
			}
			const index = await buildLocalIndex(root);
			saveLocalIndex(index);
			localIndexCache = index;
			return {
				ok: true,
				cached: false,
				root,
				scanned: index.total,
				cards: index.entries.length,
				failed: index.failed.length,
				elapsedMs: index.elapsedMs,
				note: `索引已建立：${index.entries.length} 张卡。可用 card_search({source:"local", categories:[...]}) 按分类筛选。`,
			};
		},
	};
}

function toolRead(ctx) {
	return {
		name: "card_read",
		description:
			"读取**任意**角色卡的完整原文 —— 不需要先召唤。用于「让智能体自己读卡」的场景：" +
			"开团（一次读多张卡，各演一个角色）、写文（取人设/世界书做素材）、" +
			"或取回召唤时被截断的字段。" +
			"不传 fullPath 时读当前会话已召唤的那张（缓存优先，不再回网）。" +
			"字段：personality / description / scenario / first_message / example_dialogs / " +
			"system_prompt / post_history_instructions / alternate_greetings / lorebook / all。" +
			"长文用 from/maxChars 分段读（返回 nextFrom，非 null 表示还有后续）。",
		parameters: {
			type: "object",
			properties: {
				fullPath: {
					type: "string",
					description:
						"要读的卡路径（card_search 结果的 fullPath；中文站卡形如 sichang://<slug>）。" +
						"省略则读当前会话已召唤的卡。",
				},
				field: {
					type: "string",
					description: "要取回的字段，默认 all。",
					enum: [
						"all",
						"personality",
						"description",
						"scenario",
						"first_message",
						"example_dialogs",
						"system_prompt",
						"post_history_instructions",
						"alternate_greetings",
						"lorebook",
					],
				},
				from: { type: "number", description: "起始字符偏移，默认 0（长文本分段读取）" },
				maxChars: { type: "number", description: "本次最多返回多少字符，默认 20000，上限 60000。" },
			},
			required: [],
			additionalProperties: false,
		},
		output: { schema: { type: "object", additionalProperties: true }, render: jsonRender },
		async execute(args, execCtx) {
			const maxChars = Math.max(1, Math.min(60_000, Number(args?.maxChars) || 20_000));
			const from = Math.max(0, Number(args?.from) || 0);
			const field = String(args?.field ?? "all");
			const ref = String(args?.fullPath ?? "").trim();

			// 指定了 fullPath → 直接从数据源取（**不需要**先召唤；这是「智能体自己读卡」的主路径）
			if (ref.length > 0) {
				const card = await fetchAnyCard(ref, { signal: execCtx?.signal });
				const r = readCardField(card, { field, from, maxChars });
				return { fullPath: card.fullPath, name: card.name, source: card.source ?? "chub", from: ref.length > 0 ? from : 0, ...r };
			}

			// 未指定 → 读当前会话已召唤的卡（缓存优先）
			const sessionId = currentSessionId(ctx);
			if (sessionId === undefined) throw new Error("card_read: 取不到当前会话 id");
			const cached = loadCardFile(sessionId);
			if (cached === undefined) {
				throw new Error(
					"card_read: 没传 fullPath，且当前会话没有已召唤的卡。" +
						"想读某张卡就传 fullPath（如 card_read({fullPath: \"creator/slug\"})）—— 无需先召唤。",
				);
			}
			const r = readCardField(cached, { field, from, maxChars });
			return { fullPath: cached.fullPath, name: cached.name, source: cached.source ?? "chub", from: "session-cache", ...r };
		},
	};
}

/* ───────────────────────────── HTTP 路由（面板数据面） ───────────────────────────── */

/**
 * 变量改动后，把受影响的会话的注入段重建一遍。
 *
 * 为什么必须重建：注入段是**建段时**渲染好、写进宿主 systemPrompt 的，
 * 之后每一轮都复用那份文本。只改 vars.json 的话，当前会话在重新召唤之前仍是旧值，
 * 面板会显得「改了没用」—— 用户最容易踩的坑，必须堵死。
 *
 * @param {string} fullPath 卡 ref；**传空串表示全局变量变了** → 所有会话都重建
 * @returns {Promise<string[]>} 被重建的 sessionId
 */
async function rerenderSessionsFor(fullPath, cfg) {
	const want = String(fullPath ?? "").trim();
	const touched = [];
	for (const [sessionId, section] of sections) {
		// 阵容段没有单一 fullPath（它是多张卡的合成），跳过；否则会误伤。
		if (typeof section?.fullPath !== "string") continue;
		if (want.length > 0 && section.fullPath !== want) continue;
		const card = loadCardFile(sessionId);
		if (card === undefined) continue;
		try {
			await buildSection(sessionId, card, cfg);
			touched.push(sessionId);
		} catch (error) {
			log(`变量改动后重建 ${sessionId} 注入段失败：${error?.message ?? error}`);
		}
	}
	return touched;
}

function makeHandler(ctx, cfg) {
	return async (req, res) => {
		// kind:"prefix" 下 req.url 是含前缀的完整路径；两种形态都收，避免静默 404。
		const url = new URL(req.url ?? "/", "http://localhost");
		let path = url.pathname;
		if (!path.startsWith(ROUTE)) path = `${ROUTE}${path.startsWith("/") ? "" : "/"}${path}`;
		path = path.replace(/\/+$/, "");
		const seg = path.slice(ROUTE.length).replace(/^\//, "");

		const statusFor = (sessionId) => {
			const live = sessionId === undefined ? undefined : sections.get(sessionId);
			const record = sessionId === undefined ? undefined : getSummon(sessionId);
			// `summon.chars` 是**上次召唤那一刻**落盘的字符数；重启后槽位会按当前代码从卡快照
			// 重算，两者可能不同（实测同一张卡持久化 2995、重算后 2510）。面板读的正是这个字段
			// （client.js:646/1855 → setCurrent(d.summon)），所以单条分支用内存实时值覆盖它。
			//
			// ⚠️ 必须**展开成新对象**再覆盖：`getSummon()` 返回的是 summons Map 里的**那条引用**
			// （lib/state.js:128），就地赋值会把实时值写回持久化记录，下次落盘就把历史值永久改掉。
			// 同理 list 分支（sessionId 缺省）保持原样：那是「sessionId → 记录」的字典，形状不能动。
			const summon =
				sessionId === undefined
					? listSummons()
					: record === undefined
						? null
						: { ...record, chars: live?.chars ?? record.chars };
			return {
				ok: true,
				route: ROUTE,
				summon,
				injected: sessionId === undefined ? sections.size : (live?.chars ?? 0),
				// 每个槽位的字符数：让面板能显示"角色正文/世界书/示例/PHI 各占多少"，
				// 而不是只有一个总数（旧版只有一个 text，面板看不出哪段被撑爆）。
				// 注意：各槽位之和 < injected，差值是非空槽位之间的 `\n\n` 分隔符（4 槽 = 6 字符）。
				slots: sessionId === undefined ? null : slotSizesOf(live),
				// 当前这张卡来自远端还是本地磁盘（远程优先后，静默降级必须可观测）
				via: sessionId === undefined ? null : (record?.via ?? null),
				minorFlag: sessionId === undefined ? null : (live?.minorFlag ?? null),
				// 动态世界书候选条目数（0 = 这张卡没有可被关键词触发的条目；null = 没传 sessionId）。
				// 命中与否取决于本轮对话，这里只报「有多少条待撞」，让这个功能可观测。
				dynamicEntries: sessionId === undefined ? null : (live?.dynSource?.lorebook?.entries?.length ?? 0),
			};
		};

		try {
			if (req.method === "GET" && (seg === "" || seg === "health" || seg === "status")) {
				return reply(res, 200, statusFor(url.searchParams.get("sessionId") ?? undefined));
			}

			// 搜索：面板主入口。匿名可用（实测 count/nodes/游标分页）。
			if (req.method === "GET" && seg === "search") {
				const q = url.searchParams.get("q") ?? "";
				const pageSize = Number(url.searchParams.get("pageSize") ?? url.searchParams.get("first") ?? 24);
				const page = Number(url.searchParams.get("page") ?? 1);
				const source = url.searchParams.get("source") ?? "all";
				// 面板带的取数来源偏好（local / remote）。带了就临时生效 ——
				// 这样即使用户没点切换器、只是刷新了页面，请求本身也自带意图。
				// 分类筛选走 localFilters.categories（已有的 list("category")），
				// 这里不必再读一遍 —— 多读一次是死代码。
				const orgParam = url.searchParams.get("origin");
				if (orgParam === "local" || orgParam === "remote") setPreferredOrigin(orgParam);
				const langRaw = url.searchParams.get("langId");
				const langId = langRaw === null || langRaw === "" ? undefined : Number(langRaw);
				// 本地源的筛选参数（多维度，可叠加）
				const num = (k) => {
					const v = url.searchParams.get(k);
					return v === null || v === "" ? null : Number(v);
				};
				const list = (k) => {
					const vals = url.searchParams.getAll(k).flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean);
					return vals.length > 0 ? vals : null;
				};
				const bool = (k) => {
					const v = url.searchParams.get(k);
					return v === null || v === "" ? null : v === "1" || v === "true";
				};
				const localFilters = {
					categories: list("category"),
					months: list("month"),
					fileTags: list("fileTag"),
					classified: bool("classified"),
					hasLorebook: bool("hasLorebook"),
					minPersona: num("minPersona"),
					maxPersona: num("maxPersona"),
					minContent: num("minContent"),
					maxContent: num("maxContent"),
					minBookEntries: num("minBookEntries"),
					minDynEntries: num("minDynEntries"),
					spec: url.searchParams.get("spec") || null,
					sort: url.searchParams.get("sort") || "name",
				};
				const result = await searchAll({ query: q, pageSize, page, source, langId, localFilters });
				return reply(res, 200, { ok: true, ...result });
			}

			// 详情：返回**完整提示词原文**（供右键详情面板直接显示）
			// ⚠️ 这条走 HTTP JSON，不经过 systemPrompt.section 的插值路径，
			//    所以卡里的 {{char}} / {{user}} 会**原样**返回，不会被宿主解析或抛错。
			//    用户要的就是「看到提示词」，故不做任何转义/替换。
			// 注入原文：把「当前实际塞进系统提示的那段文本」原样回给面板。
			//
			// 与 /detail 的区别：/detail 给的是**卡的提示词字段**（人设/开场白/…），
			// 这条给的是**渲染后真正注入的整段**（含标题、名单、截断标记等）。
			// 用户点「3731 注入字符」旁想看的正是后者。
			//
			// ⚠️ 两件必须说清的事：
			//   1) 文本含卡原文（可能有 {{char}} 等占位符）—— 这条走 HTTP JSON，
			//      **不经过** systemPrompt 的插值路径，所以不会触发那个报错（与 /detail 同理）。
			//   2) **未召唤返回空文本而非报错** —— 那是正常状态，不是失败。
			//      为让调用方能区分，这里显式带 `summoned` 布尔字段。
			if (req.method === "GET" && seg === "section") {
				const sessionId = url.searchParams.get("sessionId") ?? "";
				if (sessionId.length === 0) return reply(res, 400, { ok: false, error: "缺少 sessionId" });
				const hit = sections.get(sessionId);
				const record = getSummon(sessionId) ?? null;
				return reply(res, 200, {
					ok: true,
					// summoned=false 且 text="" = 没召唤（正常）；调用方据此区分「空注入」与「接口失败」
					summoned: hit !== undefined || record !== null,
					chars: hit?.chars ?? 0,
					truncatedFields: hit?.truncatedFields ?? [],
					kind: hit?.kind ?? (record?.kind ?? "single"),
					name: hit?.name ?? record?.name ?? null,
					fullPath: hit?.fullPath ?? record?.fullPath ?? null,
					text: hit?.text ?? "",
					// 分段：注入段可达 1.3 万字符，面板一次渲染全部会卡；默认回全部但允许取片段
					total: (hit?.text ?? "").length,
				});
			}

			if (req.method === "GET" && seg === "detail") {
				const fullPath = url.searchParams.get("fullPath") ?? "";
				const card = await fetchAnyCard(fullPath);
				return reply(res, 200, {
					ok: true,
					source: card.source ?? "chub",
					fullPath: card.fullPath,
					name: card.name,
					creator: card.creator,
					slug: card.slug,
					avatarUrl: card.avatarUrl,
					tags: card.tags,
					tagline: card.tagline ?? card.description ?? "",
					category: card.category ?? null,
					gender: card.gender ?? null,
					nsfw: card.nsfw === true,
					rating: card.rating,
					stats: card.stats,
					voice: card.voice ?? null,
					// ── 提示词正文（原文，不截断、不转义）──
					prompt: {
						personality: card.personality ?? "",
						description: card.description ?? "",
						scenario: card.scenario ?? "",
						firstMessage: card.firstMessage ?? "",
						exampleDialogs: card.exampleDialogs ?? "",
						systemPrompt: card.systemPrompt ?? "",
						postHistoryInstructions: card.postHistoryInstructions ?? "",
						alternateGreetings: Array.isArray(card.alternateGreetings) ? card.alternateGreetings : [],
						lorebook: card.lorebook ?? null,
					},
					sizes: {
						personality: String(card.personality ?? "").length,
						description: String(card.description ?? "").length,
						scenario: String(card.scenario ?? "").length,
						firstMessage: String(card.firstMessage ?? "").length,
						exampleDialogs: String(card.exampleDialogs ?? "").length,
						systemPrompt: String(card.systemPrompt ?? "").length,
						postHistoryInstructions: String(card.postHistoryInstructions ?? "").length,
						alternateGreetings: (card.alternateGreetings ?? []).length,
					},
					minorFlag: detectMinorFlag(card),
				});
			}

			// 取数来源偏好：面板的「本地磁盘 / GitHub」切换器读写它。
			if (seg === "origin") {
				if (req.method === "GET") {
					return reply(res, 200, {
						ok: true,
						origin: getPreferredOrigin(),
						remoteEnabled: remoteEnabled(),
						localConfigured: localConfigRoot.length > 0,
						thumbs: thumbsStats(),
					});
				}
				if (req.method === "POST") {
					const body = await readJsonBody(req);
					const next = setPreferredOrigin(String(body?.origin ?? ""));
					log(`取数来源切换为：${next}`);
					return reply(res, 200, { ok: true, origin: next });
				}
			}

			// 缩略图缓存：查看 / 手动清理
			if (req.method === "GET" && seg === "thumbs") {
				return reply(res, 200, { ok: true, ...thumbsStats(), dir: THUMB_DIR });
			}
			if (req.method === "POST" && seg === "thumbs-clear") {
				let removed = 0;
				try {
					for (const f of readdirSync(THUMB_DIR)) {
						try { rmSync(join(THUMB_DIR, f), { force: true }); removed++; } catch { /* 跳过 */ }
					}
				} catch { /* 目录不存在 */ }
				return reply(res, 200, { ok: true, removed });
			}

			// 单卡预览（点开详情，不召唤）
			if (req.method === "GET" && seg === "card") {
				const fullPath = url.searchParams.get("fullPath") ?? "";
				const card = await fetchAnyCard(fullPath);
				return reply(res, 200, { ok: true, view: cardView(card), minorFlag: detectMinorFlag(card) });
			}

			// 卡封面图。
			//
			// ── 这里曾经有个 bug，教训值得留档 ──
			// 原先「只回 PNG 前 96KB」并声称「截断的 PNG 仍可解码」——**那个验证是错的**：
			// 我当时用 `sips` 读出 512x768 就下了结论，但**宽高在 IHDR（前 33 字节）**，
			// 与像素数据无关。实测该卡 IDAT 有 850325 字节，截到 96KB 只拿到 98271 字节
			// （丢 88%），浏览器只画得出上半截 —— 用户截图证实了这点。
			// 现在改为**生成真缩略图**（`sips -Z`，实测 256px JPEG ≈ 18KB / 24ms），落盘缓存复用。
			// 语义：默认回缩略图；`?full=1` 回原图；sips 不可用时**退回原图而不截断**。
			if (req.method === "GET" && seg === "local-image") {
				const rel = url.searchParams.get("rel") ?? "";
				const root = localConfigRoot;
				const wantFull = url.searchParams.get("full") === "1";
				const px = Math.min(512, Math.max(64, Number(url.searchParams.get("px") ?? 256) || 256));

				// ⚠️ 防路径穿越：只允许**索引里存在**的相对路径（白名单来自我们自己的索引），
				//    且解析后必须仍在 root 内。比单纯 replace("../") 可靠。
				const idx = currentLocalIndex();
				const known = idx === null ? null : idx.entries.some((e) => e.rel === rel);

				// ① 本地有就地出图（缩略图走缓存）
				if (root.length > 0 && (known === true || idx === null)) {
					const absRoot = resolve(root);
					const abs = resolve(absRoot, rel);
					if (abs === absRoot || abs.startsWith(absRoot + sep)) {
						try {
							if (statSync(abs).isFile()) {
								if (!wantFull) {
									const thumb = thumbnailOf(abs, rel, px);
									if (thumb !== null) {
										res.writeHead(200, {
											"Content-Type": "image/jpeg",
											"Content-Length": String(thumb.length),
											"Cache-Control": "public, max-age=604800, immutable",
											"X-Card-Source": "local-thumb",
										});
										res.end(thumb);
										return undefined;
									}
								}
								// 原图路径（?full=1，或 sips 不可用时的兜底）—— **一律发完整文件**
								const buf = readFileSync(abs);
								res.writeHead(200, {
									"Content-Type": "image/png",
									"Content-Length": String(buf.length),
									"Cache-Control": "public, max-age=604800, immutable",
									"X-Card-Source": wantFull ? "local-full" : "local-noThumb",
								});
								res.end(buf);
								return undefined;
							}
						} catch {
							/* 本地读不到 → 往下走远程 */
						}
					}
				}

				// ② 本地没有则回源远程（images 分支）。
				//    注意 `cover` 字段自带 `images/` 前缀，交给 fetchRemoteImage 处理。
				if (remoteEnabled()) {
					try {
						const map = await ensureRemoteMap();
						const hit = map.get(rel);
						if (hit === null) return reply(res, 404, { ok: false, error: "远端 manifest 里没有这张卡" });
						const img = await fetchRemoteImage(hit.cover, { cfg: remoteConfig });
						res.writeHead(200, {
							"Content-Type": "image/png",
							"Content-Length": String(img.length),
							"Cache-Control": "public, max-age=604800, immutable",
							"X-Card-Source": "remote",
						});
						res.end(img);
						return undefined;
					} catch (error) {
						return reply(res, 502, { ok: false, error: `远程取封面失败：${error?.message ?? error}` });
					}
				}

				return reply(res, 404, { ok: false, error: "封面不可用：本地未配置且远程未启用" });
			}

			// 本地卡库：扫描建索引（面板「扫描本地卡库」按钮）
			// 注意要**同步等它跑完**（约 30 秒）再返回，否则面板会在索引建好前就刷新。
			if (req.method === "POST" && seg === "local-scan") {
				const body = await readJsonBody(req);
				const root = String(body?.root ?? "").trim() || localConfigRoot;
				if (root.length === 0) {
					return reply(res, 400, { ok: false, error: "未配置本地卡库根目录（cordis.patch.yml 的 localRoot）" });
				}
				const force = body?.force === true;
				if (!force) {
					const existing = currentLocalIndex(true);
					if (existing !== null && existing.root === root) {
						return reply(res, 200, {
							ok: true,
							cached: true,
							root,
							cards: existing.entries.length,
							failed: existing.failed?.length ?? 0,
							builtAt: existing.builtAt,
						});
					}
				}
				const index = await buildLocalIndex(root);
				saveLocalIndex(index);
				localIndexCache = index;
				log(`本地卡库扫描完成：${index.entries.length} 张入索引，${index.failed.length} 张失败，${(index.elapsedMs / 1000).toFixed(1)}s`);
				return reply(res, 200, {
					ok: true,
					cached: false,
					root,
					scanned: index.total,
					cards: index.entries.length,
					failed: index.failed.length,
					elapsedMs: index.elapsedMs,
				});
			}

			// 召唤（面板点「召唤」）
			if (req.method === "POST" && seg === "summon") {
				const body = await readJsonBody(req);
				const sessionId = String(body?.sessionId ?? "").trim();
				if (sessionId.length === 0) return reply(res, 400, { ok: false, error: "缺少 sessionId" });
				const card = await fetchAnyCard(String(body?.fullPath ?? ""));
				const flag = detectMinorFlag(card);
				if (flag.flagged && body?.confirm !== true) {
					return reply(res, 200, {
						ok: false,
						needConfirm: true,
						fullPath: card.fullPath,
						name: card.name,
						why: flag.why,
						hits: flag.hits,
					});
				}
				const section = await buildSection(sessionId, card, cfg);
				setSummon(sessionId, {
					fullPath: card.fullPath,
					name: card.name,
					creator: card.creator,
					slug: card.slug,
					chars: section.chars,
					truncatedFields: section.truncatedFields.join(","),
					minorConfirmed: flag.flagged,
				});
				return reply(res, 200, { ok: true, name: card.name, injectedChars: section.chars, view: cardView(card) });
			}

			// 解除召唤
			if (req.method === "POST" && seg === "unsummon") {
				const body = await readJsonBody(req);
				const sessionId = String(body?.sessionId ?? "").trim();
				if (sessionId.length === 0) return reply(res, 400, { ok: false, error: "缺少 sessionId" });
				sections.delete(sessionId);
				const removed = clearSummon(sessionId);
				return reply(res, 200, { ok: removed });
			}

			// 变量页：这张卡要几个变量、哪些已填、哪些还空着（面板「变量」页的唯一数据源）。
			//
			// ⚠️ 这里回的是**卡原文里的宏**，不是渲染结果：用户要编辑的正是前者。
			//    所以这条路由不能拿注入段来扫（注入段里的 `{{user}}` 已经被换掉了）。
			if (req.method === "GET" && seg === "vars") {
				const fullPath = String(url.searchParams.get("fullPath") ?? "").trim();
				if (fullPath.length === 0) return reply(res, 400, { ok: false, error: "缺少 fullPath" });
				const card = await fetchAnyCard(fullPath);
				const table = loadVars();
				const extracted = extractFromCard(card, resolveVarsFor(card));
				return reply(res, 200, {
					ok: true,
					fullPath: card.fullPath,
					name: card.name,
					file: varsPath(),
					// 全局 user/char 单独回显：面板顶部那两个「我是谁 / 这张卡里我叫谁」的框
					global: { user: String(table.global?.user ?? ""), char: String(table.global?.char ?? "") },
					extracted,
					missing: extracted.missing,
				});
			}

			// 变量写入：批量 set（value 传空串 = 清掉该变量，回到「待填」）。
			//
			// 全局 scope 不带 fullPath —— `rerenderSessionsFor("")` 会把**所有**会话重建，
			// 因为 `{{user}}` 这类全局变量一改，每张卡的注入段都变了。
			if (req.method === "POST" && seg === "vars") {
				const body = await readJsonBody(req);
				const fullPath = String(body?.fullPath ?? "").trim();
				const scope = body?.scope === "global" ? "global" : "card";
				if (scope === "card" && fullPath.length === 0) {
					return reply(res, 400, { ok: false, error: "卡级变量必须给 fullPath" });
				}
				const entries = Array.isArray(body?.entries) ? body.entries : [];
				let written = 0;
				for (const entry of entries) {
					const name = String(entry?.name ?? "").trim();
					if (name.length === 0) continue;
					await setVar({ scope, fullPath, name, value: entry?.value ?? "" });
					written += 1;
				}
				const touched = await rerenderSessionsFor(fullPath, cfg);
				return reply(res, 200, { ok: true, written, touched, file: varsPath() });
			}

			// ── Quick Reply（快捷按钮）─────────────────────────────────────────
			// 查：不传 fullPath 也能用（全局按钮对任何卡可见）。
			if (req.method === "GET" && seg === "qr") {
				const fullPath = String(url.searchParams.get("fullPath") ?? "").trim();
				return reply(res, 200, {
					ok: true,
					fullPath,
					...resolveQuickReplies(fullPath),
					file: qrPath(),
				});
			}

			// 增 / 改 / 删：同一个端点，body.action 分流（client 侧只需一份 fetch 包装）。
			if (req.method === "POST" && seg === "qr") {
				const body = await readJsonBody(req);
				const action = String(body?.action ?? "add");
				const scope = body?.scope === "global" ? "global" : "card";
				const fullPath = String(body?.fullPath ?? "").trim();
				if (action === "add") {
					const { item } = await addQuickReply({ scope, fullPath, label: body?.label, text: body?.text });
					return reply(res, 200, { ok: true, action, item, ...resolveQuickReplies(fullPath) });
				}
				if (action === "update") {
					const { item } = await updateQuickReply({
						scope,
						fullPath,
						id: body?.id,
						label: body?.label,
						text: body?.text,
					});
					return reply(res, 200, { ok: true, action, item, ...resolveQuickReplies(fullPath) });
				}
				if (action === "remove") {
					const { removed } = await removeQuickReply({ scope, fullPath, id: body?.id });
					return reply(res, 200, { ok: true, action, removed, ...resolveQuickReplies(fullPath) });
				}
				return reply(res, 400, { ok: false, error: `未知 action：${action}` });
			}

			// 投递：把按钮正文当作「用户发的一条消息」送进会话。
			//
			// 用 followup 而不是 steer —— 官方两个「外部事件投递」先例（schedule 的提醒、
			// webhook）都用 followup：它的语义正是「用户敲了回车、agent 正在跑时排队」，
			// 与手打一条消息完全一致；steer 是「插进当前轮的下一步」，与点按钮的直觉不符。
			// 投递完必须 flush：不 flush 会话要等下一轮才落盘，用户会以为按钮没生效。
			if (req.method === "POST" && seg === "qr/send") {
				const body = await readJsonBody(req);
				const text = String(body?.text ?? "").trim();
				if (text.length === 0) return reply(res, 400, { ok: false, error: "按钮正文为空" });
				const sessionId = String(body?.sessionId ?? "").trim();
				if (sessionId.length === 0) return reply(res, 400, { ok: false, error: "缺少 sessionId" });
				const mode = await deliverToSession(ctx, sessionId, text);
				return reply(res, 200, { ok: true, sessionId, mode });
			}

			return reply(res, 404, { ok: false, error: `unknown route: ${seg || "/"}` });
		} catch (error) {
			const code = error instanceof ChubError || error instanceof SichangError ? 502 : 500;
			const status = error?.status === 404 ? 404 : code;
			log(`路由 ${seg} 失败：${error?.message ?? error}`);
			return reply(res, status, { ok: false, error: String(error?.message ?? error) });
		}
	};
}

/**
 * 把一条文本当作「用户发的消息」送进会话。
 *
 * 这是本插件唯一会写会话的地方 —— 但它走的仍是用户消息通道（role: "user"、
 * source.kind: "user"）：渲染、落盘、下游处理都与用户手打一条消息一致，
 * 不是插件自造的事件类型。
 *
 * 为什么不 import createUserMessage：本插件 package.json 没有 dependencies，
 * 而 @deepseek-ai/dsh-llm 并不在 profile 的 node_modules 里（它只在宿主内部被内联进
 * 各个包）。下面这份是按官方实现照抄的最小等价物：
 *   createUserMessage(input) → createMessage({...input, role:"user"})
 *   createMessage(input)     → deepFreeze(structuredClone({...input, id: randomUUID()}))
 *
 * @param {object} ctx 插件上下文（需要 inject 了 sessions + sessionController）
 * @returns {Promise<"started"|"queued">} 投递前空闲 → 立刻起一轮；否则排队
 */
async function deliverToSession(ctx, sessionId, text) {
	const resolved = await ctx.sessionController.resolveAgent(sessionId);
	// resolveAgent 失败时返回 {error} 而不是抛（官方 schedule 插件的同款判据）
	if (resolved !== null && typeof resolved === "object" && "error" in resolved) {
		throw new Error(`找不到会话 ${sessionId}：${resolved.error?.message ?? resolved.error}`);
	}
	const agent = resolved?.agent;
	if (!agent || typeof agent.followup !== "function") {
		throw new Error(`会话 ${sessionId} 没有可投递的 agent`);
	}
	// 投递前先看相位：这决定回给 UI 的是「已发出」还是「已排队」，
	// 两者观感差别很大（后者要等当前轮跑完），不说清用户会以为按钮点空了。
	const idle = agent.phase?.kind === "idle";
	const message = deepFreeze(
		structuredClone({
			role: "user",
			content: [{ type: "text", text }],
			source: { kind: "user" },
			id: randomUUID(),
		}),
	);
	agent.followup(message);
	// 必须 flush：不然会话要等下一轮结束才落盘，用户刷新页面会看到消息没了。
	await ctx.sessions.flush(agent.session);
	return idle ? "started" : "queued";
}

/** 递归冻结（官方 createMessage 在发布前做的同一件事：挡住下游对消息的意外改写）。 */
function deepFreeze(value) {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const inner of Object.values(value)) deepFreeze(inner);
	}
	return value;
}

function readJsonBody(req) {
	return new Promise((resolve) => {
		let raw = "";
		req.on("data", (chunk) => {
			raw += chunk;
			if (raw.length > 1_000_000) req.destroy();
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(raw || "{}"));
			} catch {
				resolve({});
			}
		});
		req.on("error", () => resolve({}));
	});
}

/* ───────────────────────────── apply ───────────────────────────── */

export async function apply(ctx, config) {
	const cfg = config ?? {};
	mkdirSync(STATE_ROOT, { recursive: true });
	// 本地卡库根目录来自插件配置（cordis.patch.yml 的 localRoot）
	localConfigRoot = typeof cfg.localRoot === "string" ? cfg.localRoot : "";
	if (Number.isFinite(cfg.maxBookPersona) && cfg.maxBookPersona > 0) bookPersona = cfg.maxBookPersona;

	// 远程卡库（GitHub 私有仓库）。配了 remoteRepo 即启用，**默认优先走远程** ——
	// 用户要求「都连到远程」，本地只作降级。
	if (typeof cfg.remoteRepo === "string" && cfg.remoteRepo.trim().length > 0) {
		remoteConfig = {
			repo: cfg.remoteRepo.trim(),
			mainBranch: typeof cfg.remoteBranch === "string" && cfg.remoteBranch.length > 0 ? cfg.remoteBranch : "main",
			imagesBranch:
				typeof cfg.remoteImagesBranch === "string" && cfg.remoteImagesBranch.length > 0 ? cfg.remoteImagesBranch : "images",
			token: typeof cfg.remoteToken === "string" ? cfg.remoteToken : "",
		};
		// token 兜底：配置没给就试 `gh auth token`
		setTokenResolver(() => {
			if (typeof cfg.remoteToken === "string" && cfg.remoteToken.trim().length > 0) return cfg.remoteToken.trim();
			try {
				// ⚠️ 本文件是 ESM —— 不能用 require()（实测：抛 "require is not defined"
				// 且被 catch 吞掉 → token 恒为空 → 远程全 404）。必须用顶部 import 的 execSync。
				return String(execSync("gh auth token", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim();
			} catch {
				return "";
			}
		});
		log(`远程卡库：${remoteConfig.repo}（main=${remoteConfig.mainBranch} / images=${remoteConfig.imagesBranch}）`);
	} else {
		remoteConfig = null;
	}

	if (localConfigRoot.length > 0) {
		const idx = currentLocalIndex();
		log(
			`本地卡库（降级用）：${localConfigRoot}｜` +
				(idx === null ? "索引未建立（面板点「扫描本地卡库」）" : `索引 ${idx.entries.length} 张，建于 ${idx.builtAt}`),
		);
	}
	const ci = cacheInfo();
	if (remoteEnabled() && (ci.index !== null || ci.manifest !== null)) {
		log(
			`远程缓存：索引 ${ci.index ? `${(ci.index.bytes / 1024 / 1024).toFixed(0)}MB` : "无"} / ` +
				`manifest ${ci.manifest ? `${(ci.manifest.bytes / 1024 / 1024).toFixed(1)}MB` : "无"}`,
		);
	}

	// 重启恢复：优先用卡快照**按当前代码现算槽位** —— 这样升级注入模型后，旧会话不必重新召唤
	// 就能拿到新排版（落盘的整段文本是上一版渲染的，直接读回会把旧骨架一起复活）。
	// 卡快照缺失时才退回落盘整段（放进 main 槽，至少不丢注入）。
	for (const [sessionId] of Object.entries(listSummons())) {
		const diskText = loadSectionFromDisk(sessionId);
		let restored;
		try {
			const card = loadCardFile(sessionId);
			if (card !== null && typeof card === "object") {
				if (card.kind === "cast") {
					const members = Array.isArray(card.members) ? card.members : [];
					const composed = composeCast(members, {
						writingStyle: cfg?.writingStyle,
						writingStyleText: cfg?.writingStyleText,
						fictionFrame: cfg?.fictionFrame,
						fictionFrameText: cfg?.fictionFrameText,
					});
					restored = {
						slots: { main: composed.text },
						text: composed.text,
						chars: composed.chars,
						truncatedFields: composed.truncatedFields,
						fullPath: members.map((m) => m?.card?.fullPath ?? "").join(","),
						name: `阵容(${composed.cast.length}人)：${composed.cast.join("、")}`,
						kind: "cast",
						dynSource: mergeDynamicSources(members.map((m) => m?.card ?? m)),
					};
				} else {
					const composed = composeSlots(card, {
						maxPersonality: cfg?.maxPersonality,
						writingStyle: cfg?.writingStyle,
						writingStyleText: cfg?.writingStyleText,
						fictionFrame: cfg?.fictionFrame,
						fictionFrameText: cfg?.fictionFrameText,
					});
					restored = {
						slots: composed.slots,
						text: composed.text,
						chars: composed.chars,
						truncatedFields: composed.truncatedFields,
						fullPath: card.fullPath,
						// 动态世界书的候选条目是**内存态**（不随注入段文本落盘）—— 这里从卡快照现算，
						// 否则重启后「之前召唤过的会话」会静默失去 keys 触发，而且 /status 的
						// dynamicEntries 显示 0，与「这张卡压根没有候选条目」无法区分。
						// 正文与静态段一致，走注入前转换。
						dynSource: dynamicSourceOf(markdownizeCard(card)),
					};
				}
			}
		} catch (error) {
			log(`恢复 ${sessionId} 槽位失败，退回整段落盘`, error?.message ?? error);
		}
		if (restored === undefined) {
			if (diskText === undefined || diskText.length === 0) continue;
			restored = { slots: { main: diskText }, text: diskText, chars: diskText.length, truncatedFields: [] };
		}
		sections.set(sessionId, { ...restored, at: new Date().toISOString() });
	}

	// 状态文件封顶，随后回收孤儿段文件（顺序不能反）。
	const all = Object.entries(listSummons()).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)));
	if (all.length > MAX_SUMMON_SESSIONS) {
		pruneSummons(new Set(all.slice(all.length - MAX_SUMMON_SESSIONS).map(([id]) => id)));
	}
	const swept = sweepSectionFiles();
	if (swept > 0) log(`回收 ${swept} 个失效段落文件`);

	// ── 注入段：一个槽位一条 section；未召唤 → 空串（宿主过滤空段，零残留） ──
	for (const slot of SLOTS) {
		ctx.effect(
			() =>
				ctx.systemPrompt.section({
					name: slot.name,
					order: slot.order,
					// ⚠️ 必须关插值。宿主 renderPrompt 对**未注册/不合法**的 `{{name}}` 直接抛错
					// （packages/core/system-prompt/src/index.ts:361-363 是 unknown 分支、
					//  :357-358 是 malformed 分支；renderPrompt 在 :287 按 interpolate 分流）。
					// 而角色卡正文里 `{{char}}` / `{{user}}` 是酒馆生态的标准占位符 —— 实测扫 20+ 张
					// 真实卡：`{{user}}` 出现 512 次、`{{char}}` 79 次，另有 `{{chat}}` / `{{original}}` /
					// `{{用户}}`（中文名不合法）/ `{{MINIMUM_WORD_COUNT 200}}`（含空格，不合法）。
					// 走插值会让**整个会话的提示词组装失败**（用户侧表现为「一召唤就报错」）。
					//
					// interpolate:false 是官方手段：保留字面文本、跳过变量解析（已用官方编译产物
					// `packages/core/system-prompt/lib/index.js` 实测：6 种宏全部原样保留、零抛错）。
					// 卡占位符的语义转换（{{char}}→角色名 等）属另一件事，不在这一步做。
					interpolate: false,
					text: (context) => {
						const sessionId = sessionIdOf(context);
						if (sessionId === undefined) return "";
						const hit = sections.get(sessionId);
						if (hit === undefined) {
							// 有召唤记录但段没进内存（刚重启）：本轮先不注入。
							return "";
						}
						// 开场白只在会话里**还没有 assistant 消息**时给（酒馆里它就是第一条消息）。
						// 首轮重生成/删除首条回复时这个条件会翻转一次 —— 那是预期行为。
						if (slot.key === "greeting") {
							return hasAssistantMessage(context) ? "" : (hit.slots?.greeting ?? "");
						}
						// 世界书动态触发 + 静态 atDepth 条目合并在 lore 槽里，每轮重算。
						// 这里**只能做纯内存字符串匹配** —— 求值器每轮都跑，任何 IO 都会拖慢整轮。
						if (slot.key === "lore") {
							const staticLore = hit.slots?.lore ?? "";
							if (hit.dynSource === undefined) return staticLore;
							const lore = composeDynamicLore(hit.dynSource, recentTextOf(context, DYNAMIC_SCAN_DEPTH)).text;
							return [staticLore, lore].filter((x) => x.length > 0).join("\n");
						}
						return hit.slots?.[slot.key] ?? "";
					},
				}),
			`dsh-card-summon: system prompt section ${slot.key}`,
		);
	}

	// ── 模型侧工具 ──
	const builtTools = [
		toolSearch(),
		toolSummon(ctx, cfg),
		toolCast(ctx, cfg), // 多角色阵容：默认只读、可注入
		toolLocalScan(ctx, cfg), // 本地卡库：扫索引
		toolUnsummon(ctx),
		toolStatus(ctx),
		toolRead(ctx),
	];
	for (const tool of builtTools) {
		ctx.effect(() => ctx.tools.register(tool), `dsh-card-summon: tool ${tool.name}`);
	}

	// ── UI 路由 ──
	ctx.effect(
		() => ctx.webServer.register({ kind: "prefix", path: ROUTE, handler: makeHandler(ctx, cfg) }),
		"dsh-card-summon: http route",
	);

	log(
		`host half mounted｜注入段 ${SLOTS.length} 槽（main=${SECTION_ORDER} → ${SLOTS[SLOTS.length - 1].key}=${SLOTS[SLOTS.length - 1].order}，酒馆式顺序）｜` +
			`路由 ${ROUTE}/search｜状态 ${STATE_ROOT}｜恢复 ${sections.size} 个注入段`,
	);
}

export { composeSummon, composeSlots, detectMinorFlag, SLOTS, SECTION_NAME, SECTION_ORDER, BUDGET };
