/**
 * 本地角色卡源（PNG 卡库）。
 *
 * 目标目录形态（实测 13385 张 / 13GB）：
 *   <root>/<月份>/已分类/<分类>/*.png      ← 32 个分类，3272 张
 *   <root>/<月份>/未分类/*.png             ← 3171 张
 *   <root>/<月份>/世界书及其他/            ← JSON 世界书 / docx / zip，**不是卡**
 *   <root>/<月份>/*.png                    ← 部分月份是平铺的
 *
 * ── 三个与线上源截然不同的点（全部实测，别照搬 Chub 的假设）──
 *
 * 1) **文件格式**：PNG 内嵌 `chara` + `ccv3` 两个 tEXt chunk，内容是 **base64 编码的 JSON**
 *    （不是明文 —— 直接 JSON.parse 会报 `Unexpected token 'e', "eyJuYW1lIj"...`）。
 *    chunk 位于文件 **95%–98%** 处，所以**读尾部**即可，不必读整个 1.3–4MB 的图。
 *
 *    自适应窗口（起始 256KB，逐次翻倍到 8MB，最后回退全文）——这个数字与实测对齐：
 *    等距采样 300 张 / 全库 10678 张做 A/B（ground truth = 从头解析完整 chunk 链），
 *    **可读性判据下 300/300 = 100% 一致，退化为全文读的仅 19/300，单次约 2.7ms**。
 *    ⚠️ 判据是「解出能用的卡数据」而**不是**「拿到全部 chunk」：小窗口可能只覆盖 ccv3
 *    而切掉它前面的 chara，但 ccv3 本身已足够读出这张卡。
 *
 * 2) **字段映射与 Chub 相反**：实测抽样 32 张，`personality` **100% 为空**，
 *    人设主体在 `description`（均值 2032 字）。
 *      personality（人设主体） ← description（+ personality 非空时并入）
 *      description（简介）     ← creator_notes
 *      firstMessage           ← first_mes
 *      exampleDialogs         ← mes_example
 *      lorebook               ← character_book（实测 27/32 张有）
 *    **已知未映射**：`group_only_greetings`（群聊专用，单模型分饰场景用不上）。
 *
 * 3) **分类来自目录名，不是卡内 tags**（实测卡内 tags 全空，文件名 `#标签#` 仅占 0.4%）。
 *    所以目录结构是唯一的分类维度来源。
 *
 * V3 与 V2 混装（实测 23:9），两者字段都在 `.data` 下；V1 裸卡则字段在顶层。
 */
import { readFileSync, readdirSync, statSync, openSync, readSync, closeSync, writeFileSync, mkdirSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import { inflateSync } from "node:zlib";
import { STATE_ROOT } from "./state.js";
import { dynamicSourceOf } from "./inject.js";

export const LOCAL_SCHEME = "local://";
const INDEX_FILE = join(STATE_ROOT, "local-index.json");
/** 索引格式版本：结构变更时递增，旧索引会被判定失效并重建。 */
const INDEX_VERSION = 11;

/** 自适应窗口：起始 256KB（与 A/B 实测对齐），逐次翻倍，上限 8MB 后回退全文。 */
const TAIL_START_BYTES = 256 * 1024;
const TAIL_MAX_BYTES = 8 * 1024 * 1024;

export class LocalError extends Error {
	constructor(message, { path } = {}) {
		super(message);
		this.name = "LocalError";
		this.path = path;
	}
}

export function isLocalRef(ref) {
	return String(ref ?? "").startsWith(LOCAL_SCHEME);
}

export function localRef(relPath) {
	return `${LOCAL_SCHEME}${String(relPath ?? "").replace(/^\/+/, "")}`;
}

export function relOf(ref) {
	const s = String(ref ?? "").trim();
	return s.startsWith(LOCAL_SCHEME) ? s.slice(LOCAL_SCHEME.length) : s;
}

/* ───────────────────── PNG chunk 定位 ───────────────────── */

/**
 * 从一段 buffer 里提取所有可用的卡数据候选。
 *
 * 为什么不能从头解析 chunk 链：我们读的是**尾部**，起点很可能落在 IDAT 数据中间，
 * 不是合法的 chunk 边界。所以改为「搜 chunk 类型字面量 + 三重校验」。
 *
 * 消歧规则（**不依赖 chunk 顺序** —— 顺序只用于加速，不用于正确性）：
 *   ① 类型必须是 tEXt / zTXt / iTXt
 *   ② 其前 4 字节的长度字段自洽（>0、不超上限、数据不越界）
 *   ③ 关键字必须是 `chara` 或 `ccv3`
 *   ④ 载荷能 base64 解出 JSON
 * 四者同时满足才采纳；多个候选时按 keyword 优先 ccv3（V3 字段更全），与位置无关。
 */
function extractCandidates(buf, baseOffset = 0) {
	const out = [];
	for (const type of ["tEXt", "zTXt", "iTXt"]) {
		const marker = Buffer.from(type, "latin1");
		let from = 0;
		for (;;) {
			const at = buf.indexOf(marker, from);
			if (at < 0) break;
			from = at + 4;
			if (at < 4) continue; // 前面放不下长度字段
			const len = buf.readUInt32BE(at - 4);
			if (!(len > 0 && len <= 64 * 1024 * 1024)) continue;
			const dataStart = at + 4;
			if (dataStart + len > buf.length + 64) continue; // 数据越界（尾部截断时可能）
			const data = buf.subarray(dataStart, Math.min(dataStart + len, buf.length));
			const zero = data.indexOf(0);
			if (zero <= 0) continue;
			const kw = data.toString("latin1", 0, zero);
			if (kw !== "chara" && kw !== "ccv3") continue;

			let text = "";
			try {
				if (type === "tEXt") text = data.subarray(zero + 1).toString("latin1");
				else if (type === "zTXt") text = inflateSync(data.subarray(zero + 2)).toString("latin1");
				else {
					// iTXt: keyword\0 compFlag compMethod langTag\0 translated\0 text
					const compFlag = data[zero + 1];
					let p = zero + 3;
					p = data.indexOf(0, p) + 1;
					p = data.indexOf(0, p) + 1;
					const raw = data.subarray(p);
					text = (compFlag === 1 ? inflateSync(raw) : raw).toString("latin1");
				}
			} catch {
				continue;
			}
			const parsed = decodeChunkText(text);
			if (parsed === null) continue; // ④ 解不出 JSON → 丢弃
			out.push({ kw, type, bytes: len, offset: baseOffset + at, parsed });
		}
	}
	return out;
}

/**
 * base64 → JSON；也兼容明文 JSON（部分工具直接写明文）。
 * 返回 null 表示不是有效卡数据。
 */
function decodeChunkText(text) {
	const t = String(text ?? "").trim();
	if (t.length === 0) return null;
	if (t.startsWith("{")) {
		try {
			return JSON.parse(t);
		} catch {
			return null;
		}
	}
	// base64：剥掉非 base64 字符（chunk 数据可能夹带填充/空白）
	const cleaned = t.replace(/[^A-Za-z0-9+/=]/g, "");
	const usable = cleaned.slice(0, cleaned.length - (cleaned.length % 4));
	try {
		return JSON.parse(Buffer.from(usable, "base64").toString("utf8"));
	} catch {
		return null;
	}
}

/** 读一段窗口并抽候选。 */
function scanWindow(file, size, windowBytes) {
	const start = Math.max(0, size - windowBytes);
	const fd = openSync(file, "r");
	const buf = Buffer.alloc(size - start);
	try {
		readSync(fd, buf, 0, buf.length, start);
	} finally {
		closeSync(fd);
	}
	return extractCandidates(buf, start);
}

/**
 * 读一张本地卡：自适应窗口，拿到可用候选即停。
 *
 * 停止条件（与 A/B 实测对齐）：候选里**有 ccv3 或 chara 任一能解出 JSON** 就够 ——
 * 不要求两个 chunk 都拿到。窗口内没有候选才翻倍重试，直至 8MB，最后回退全文读。
 *
 * @returns {{raw: object, kw: string, chunkBytes: number, windowBytes: number, fullRead: boolean}}
 */
export function readLocalCardFile(file, { startBytes = TAIL_START_BYTES, maxBytes = TAIL_MAX_BYTES } = {}) {
	let size;
	try {
		size = statSync(file).size;
	} catch (error) {
		throw new LocalError(`文件不可访问：${error?.message ?? error}`, { path: file });
	}

	let window = Math.min(startBytes, size);
	let lastCandidates = [];
	for (;;) {
		let candidates;
		try {
			candidates = scanWindow(file, size, window);
		} catch (error) {
			throw new LocalError(`读卡失败：${error?.message ?? error}`, { path: file });
		}
		lastCandidates = candidates;
		const pick = candidates.find((c) => c.kw === "ccv3") ?? candidates.find((c) => c.kw === "chara");
		if (pick !== undefined) {
			return {
				raw: pick.parsed,
				kw: pick.kw,
				chunkBytes: pick.bytes,
				windowBytes: Math.min(window, size),
				fullRead: window >= size,
			};
		}
		if (window >= size || window >= maxBytes) break;
		window = Math.min(window * 2, size, Math.max(maxBytes, window * 2));
	}

	// 回退：全文读一次（窗口上限内没找到，或候选都被判定无效）
	let buf;
	try {
		buf = readFileSync(file);
	} catch (error) {
		throw new LocalError(`全文读失败：${error?.message ?? error}`, { path: file });
	}
	const all = extractCandidates(buf, 0);
	const pick = all.find((c) => c.kw === "ccv3") ?? all.find((c) => c.kw === "chara");
	if (pick === undefined) {
		const seen = lastCandidates.length;
		throw new LocalError(
			seen === 0
				? "PNG 里找不到可用的 chara / ccv3 数据块（可能不是角色卡）"
				: `找到 ${seen} 个候选但都无法解码为 JSON（可能不是 base64 卡数据）`,
			{ path: file },
		);
	}
	return { raw: pick.parsed, kw: pick.kw, chunkBytes: pick.bytes, windowBytes: size, fullRead: true };
}

/* ───────────────────── 字段映射 ───────────────────── */

/**
 * 从世界书提炼「常驻设定」文本。
 *
 * 为什么只取 `constant: true` 的条目：那是作者显式标记「总是要放进上下文」的设定；
 * 带 keys 的条目是被关键词触发的，不该无条件塞进注入段。
 * 实测某张 51 条的卡里 constant 有 15 条，正是世界观/派系这类基础设定。
 *
 * ⚠️ 两个曾经踩实了的坑（2026-10-15，一张 6 条常驻共 12749 字的卡）：
 *   ① **预算太小**：调用点曾用 `meta.maxBookPersona ?? 6000`，而该键**全仓没有任何注入点**
 *      （死参数，等价硬编码 6000）。按 order 排序后 6000 只装得下前 2 条 + 第 3 条的 308 字，
 *      order=101 的**主角本人人设（2911 字）连同后面的文风语料库被整条丢弃** ——
 *      结果「清纯温顺的妻子的人格」从头到尾没进过模型上下文，模型只能凭空发挥。
 *   ② **句中硬切**：`body.slice(0, room) + "…"` 会把一条设定切成半句话。半截设定比没有更坏：
 *      它让角色人格变成一个自相矛盾的版本，而模型分辨不出那是「作者写的」还是「本来如此」。
 *      现在改为**整条跳过** + 用 `continue`（而不是 `break`）让后面的短条目仍能填满剩余空间，
 *      并把跳过的条目交回注入层显式列出 —— 宁可说「这条没注入」，不要假装完整。
 *
 * @returns {{text: string, dropped: Array<{label: string, chars: number, order: number}>, used: number, total: number}}
 */
export function personaFromBook(book, maxChars) {
	const empty = { text: "", dropped: [], used: 0, total: 0 };
	if (book === null || book === undefined || !Array.isArray(book.entries)) return empty;
	const konst = book.entries.filter((e) => e !== null && typeof e === "object" && e.enabled !== false && e.constant === true);
	if (konst.length === 0) return empty;
	// 按 insertion_order 排（作者的预期顺序），无则按原序
	const sorted = konst.slice().sort((a, b) => (a.insertion_order ?? 100) - (b.insertion_order ?? 100));
	const parts = [];
	const dropped = [];
	let used = 0;
	let total = 0;
	for (const e of sorted) {
		const body = String(e.content ?? "").trim();
		if (body.length === 0) continue;
		total += body.length;
		if (used + body.length > maxChars) {
			const label = String(e.comment ?? "").trim();
			dropped.push({
				label: label.length > 0 ? label : `条目#${dropped.length + 1}`,
				chars: body.length,
				order: e.insertion_order ?? 100,
			});
			continue;
		}
		parts.push(body);
		used += body.length;
	}
	return { text: parts.join("\n\n"), dropped, used, total };
}

/** 内部卡模型 ← 本地 V2/V3 卡（字段名与 Chub 不同，见文件头注释）。 */
export function normalizeLocalCard(parsed, meta = {}) {
	const raw = parsed?.raw ?? parsed;
	// V2/V3 都把字段放在 .data；V1 裸卡则直接在顶层
	const d = raw?.data ?? raw ?? {};
	const spec = raw?.spec ?? "(v1)";
	const specVersion = raw?.spec_version ?? "";

	// 人设主体：description 优先（实测 personality 100% 为空），非空时并入
	const personaParts = [String(d.description ?? "").trim(), String(d.personality ?? "").trim()].filter(
		(x) => x.length > 0,
	);
	const personality = personaParts.join("\n\n");

	const book = d.character_book ?? null;
	// 兜底：实测 48.4% 的卡 personaLen=0，内容全在「世界书 + 开场白」里。
	// 世界书条目带 `constant: true` 标记 = 作者指定要常驻上下文的设定，用它提炼最贴合作者意图。
	// 只改这里不动 personality 本身（保持忠实），由注入层在 personality 为空时回退到它。
	// 兜底预算：实测一张 6 条常驻共 12749 字的卡，6000 会丢掉主角本人 + 文风语料库整条。
	// 20000 能容下绝大多数中文卡的全部常驻条目；可用 config.maxBookPersona 覆盖。
	// ⚠️ personaDerived 必须保持 **string**：local.js:372/533/546 与 inject.js:146/294
	// 都按字符串消费它（.length / 模板插值 / clean()），改成对象会静默产出 [object Object]。
	const derived = personality.length === 0 ? personaFromBook(book, meta.maxBookPersona ?? 20_000) : { text: "", dropped: [], used: 0, total: 0 };
	const personaDerived = derived.text;
	return {
		source: "local",
		fullPath: meta.fullPath ?? "",
		creator: meta.category ?? "",
		slug: basename(meta.file ?? "", extname(meta.file ?? "")),
		name: String(d.name ?? "").trim() || basename(meta.file ?? "", ".png"),
		// ── 提示词正文（映射后的）──
		personality,
		// 人设为空时的世界书兜底文本（注入层在 personality 为空时回退到它）
		personaDerived,
		// 因预算整条未能注入的常驻条目；注入层据此显式告知模型「哪些设定没进来」
		personaDerivedDropped: derived.dropped,
		description: String(d.creator_notes ?? "").trim(),
		scenario: String(d.scenario ?? ""),
		firstMessage: String(d.first_mes ?? ""),
		exampleDialogs: String(d.mes_example ?? ""),
		alternateGreetings: Array.isArray(d.alternate_greetings)
			? d.alternate_greetings.filter((x) => typeof x === "string")
			: [],
		systemPrompt: String(d.system_prompt ?? ""),
		postHistoryInstructions: String(d.post_history_instructions ?? ""),
		// 卡的"作者注"（酒馆 extensions.depth_prompt，默认 depth=4 / role=system）。
		// 旧版整条丢掉 —— 带它的卡会少掉作者专门写给模型的一段语气/禁忌说明。
		depthPrompt: String(d.extensions?.depth_prompt?.prompt ?? ""),
		creatorNotes: String(d.creator_notes ?? ""),
		tavernPersonality: "",
		// ── 分类元数据（来自目录，不是卡内 tags —— 实测卡内 tags 全空）──
		tags: [meta.category, meta.month].filter((x) => typeof x === "string" && x.length > 0),
		category: meta.category ?? null,
		month: meta.month ?? null,
		classified: meta.classified === true,
		spec,
		specVersion,
		nsfw: meta.category !== "正常向" && meta.category !== "纯爱",
		rating: null,
		nsfwImage: false,
		stats: null,
		avatarUrl: "",
		cardPngUrl: "",
		lorebook: book,
		langId: 12,
		// 原始字段保留（供详情面板展示"卡原文"）
		raw: { spec, specVersion, data: d },
	};
}

/* ───────────────────── 索引 ───────────────────── */

/**
 * 拼「可搜正文摘要」——决定搜索能不能搜到人设里的词。
 *
 * 实测（等距抽样 200 张，3 个中文关键词）各方案的召回与索引增量：
 *   仅卡名+路径         4/200  (2%)     —— 修复前
 *   人设类字段 2000 字   11/200 (5.5%)   —— 只加人设不够
 *   人设类字段 8000 字   18/200 (9%)
 *   **人设 + 世界书**    **40/200 (20%)** ← 世界书是召回大头（实测约 75% 的命中只在世界书里）
 *
 * 所以摘要必须**含世界书正文**，否则搜「学姐」这类词会漏掉大半。
 * 但世界书单卡可达 MB 级，全收录会把索引撑爆（13GB 量级），故按预算截断：
 *   人设类 2000 字 + 世界书 2500 字 = 每人约 4500 字。
 *   注：人设上限**不能压**——实测从 2000 压到 1500 会让「学姐」命中从 106 掉到 96，
 *   因为人设与开场白是另一大命中来源（实测前 12 条命中里人设占 10 条）。
 */
/**
 * 卡片预览 —— 给列表用的一句「这卡讲什么」。
 *
 * 为什么需要它：索引原先只有 `digest`（搜素用正文）与统计量（人设 N 字），
 * 卡片上没有任何**可读描述**。实测抽样 150 张：
 *   · `description` 可读  24 张（16%）—— 卡作者写的简介，最理想
 *   · `firstMessage` 可读 105 张（70%）—— 开场白，次选
 *   · 两者至少一个可读   110 张（73%）
 * 所以取「description 优先、firstMessage 兜底」，覆盖率 73%。
 *
 * 「可读」判据：长度够 + 开头不是 XML/标签式记号。
 * 实测 digest 里 128/200 张以 `<sfw_narrative_guidance_f>` 这类标签开头，
 * 直接当描述显示会很难看，所以这里必须过滤。
 */
function buildPreview(card) {
	const clean = (x) => String(x ?? "").replace(/\s+/g, " ").trim();
	// 开头若像标签/代码块，说明这是提示词而非给人读的描述
	// 工具署名/模板串不是描述。实测「Created with Nika Character Studio」占 0.4%、
	// 「Automatically created character…」这类也常见 —— 用户看到会以为是内容。
	const BOILERPLATE = /^(created|made|generated|built|automatically\s+created)\b/i;
	const readable = (x) =>
		x.length > 20 &&
		!/<[a-z_/]/i.test(x.slice(0, 80)) &&
		!/^[\[{]/.test(x) &&
		!BOILERPLATE.test(x);
	const d = clean(card.description);
	if (readable(d)) return d.slice(0, 90);
	const f = clean(card.firstMessage);
	if (readable(f)) return f.slice(0, 90);
	return "";
}

function buildDigest(card) {
	const persona = [
		card.personality,
		card.personaDerived,
		card.firstMessage,
		card.description,
		card.scenario,
	]
		.filter((x) => typeof x === "string" && x.length > 0)
		.join("\n")
		.slice(0, 2000);

	// 世界书：优先 constant（作者指定常驻的设定），其次按原序 —— 常驻条目更可能是世界观主体
	const entries = Array.isArray(card.lorebook?.entries) ? card.lorebook.entries : [];
	const sorted = [...entries].sort((a, b) => {
		const ca = a?.constant === true ? 0 : 1;
		const cb = b?.constant === true ? 0 : 1;
		if (ca !== cb) return ca - cb;
		return (a?.insertion_order ?? 100) - (b?.insertion_order ?? 100);
	});
	let book = "";
	for (const e of sorted) {
		if (book.length >= 2500) break;
		const body = String(e?.content ?? "").trim();
		if (body.length === 0) continue;
		book += ` ${body.slice(0, 2500 - book.length)}`;
	}

	return `${persona}${book}`
		.replace(/\s+/g, " ")
		.toLowerCase();
}

/**
 * 判断「这个分类名值不值得给用户看」。
 *
 * 实测 33 个分类里混了两类**目录/归档名**而非真分类，直接显示只会误导：
 *   · 「未分类」占 8212/11480（平铺目录的默认值）
 *   · 「2025年3月前」是月份归档名（1132 张），与「1-2月」这类同级
 * 所以把这两种都视作「没有分类」，让 UI 不渲染，而不是显示一个假分类。
 */
function realCategory(raw) {
	const c = String(raw ?? "").trim();
	if (c.length === 0 || c === "未分类") return "";
	if (/^\d{4}年\d{1,2}月前?$/.test(c)) return ""; // 2025年3月前 / 2025年3月
	if (/^\d{1,2}-\d{1,2}月$/.test(c)) return ""; // 1-2月
	return c;
}

/** 从相对路径推导分类/月份/是否已分类。 */
function metaFromPath(relPath) {
	const parts = relPath.split("/");
	// 形态：<月份>/已分类/<分类>/<file>.png 或 <月份>/未分类/<file>.png 或 <月份>/<file>.png
	const month = parts[0] ?? "";
	let category = null;
	let classified = false;
	if (parts.length >= 3 && parts[1] === "已分类") {
		category = parts[2];
		classified = true;
	} else if (parts.length >= 3 && parts[1] === "未分类") {
		category = "未分类";
		classified = false;
	} else if (parts.length >= 3) {
		category = parts[1];
		classified = true;
	} else {
		// 月份根目录下平铺的卡（如 `6-7月/xxx.png`）——实测 4400 张走这条，
		// 归为「未分类」而不是 null，否则面板分类下拉里会缺一大块。
		category = "未分类";
		classified = false;
	}
	return { month, category, classified };
}

/**
 * 从文件名抽标签。实测两种写法混用：
 *   `#同人#动物森友会埃及猫安卡#.png`        → 同人 / 动物森友会埃及猫安卡
 *   `铁与深 #蒸汽朋克 #猎魔人#仪式神秘学.png` → 蒸汽朋克 / 猎魔人 / 仪式神秘学
 *
 * 用 `(?=#)` 前瞻而不是 `#…#` 直接配对 —— 否则 `#A#B#` 里的 `B` 会因为
 * 前一次匹配把闭合 `#` 消费掉而整段丢掉（实测踩过）。结尾无闭合的 `#…` 另收。
 */
function extractFileTags(filename) {
	const base = String(filename ?? "").replace(/\.png$/i, "");
	const out = [];
	for (const m of base.matchAll(/#([^#]+)(?=#)/g)) {
		const t = m[1].trim();
		if (t.length > 0) out.push(t);
	}
	const tail = base.match(/#([^#]+)$/);
	if (tail !== null) {
		const t = tail[1].trim();
		if (t.length > 0) out.push(t);
	}
	return [...new Set(out)].filter((t) => t.length <= 30);
}

/** 递归收集所有 .png（不读内容，只列路径）。 */
function walkPngs(root, { skipDirs = ["世界书及其他", "预设"] } = {}) {
	const out = [];
	const stack = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		let names;
		try {
			names = readdirSync(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const e of names) {
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				if (skipDirs.includes(e.name)) continue;
				stack.push(full);
			} else if (e.isFile() && e.name.toLowerCase().endsWith(".png")) {
				out.push(full);
			}
		}
	}
	return out;
}

/**
 * 建索引：扫全部 PNG，读尾部拿卡名/规格/长度等元数据（**不缓存正文**，避免复制 13GB）。
 * 每批让出事件循环，避免卡住宿主。
 */
export async function buildLocalIndex(root, { onProgress, batch = 200 } = {}) {
	if (typeof root !== "string" || root.length === 0) throw new LocalError("缺少 root 目录");
	let rootStat;
	try {
		rootStat = statSync(root);
	} catch {
		throw new LocalError(`目录不存在或不可访问（外置盘未挂载？）：${root}`, { path: root });
	}
	if (!rootStat.isDirectory()) throw new LocalError(`不是目录：${root}`, { path: root });

	const files = walkPngs(root);
	const entries = [];
	const failed = [];
	let processed = 0;
	const t0 = Date.now();

	for (const file of files) {
		const rel = relative(root, file);
		const meta = metaFromPath(rel);
		meta.fileTags = extractFileTags(basename(file));
		let st = null;
		try {
			st = statSync(file);
		} catch {
			continue;
		}
		const fullPath = localRef(rel);
		try {
			const parsed = readLocalCardFile(file);
			const card = normalizeLocalCard(parsed, { ...meta, file, fullPath });
			entries.push({
				rel,
				name: card.name,
				month: meta.month,
				category: meta.category,
				classified: meta.classified,
				spec: card.spec,
				personaLen: card.personality.length,
				derivedLen: (card.personaDerived ?? "").length,
				firstMesLen: card.firstMessage.length,
				exampleLen: card.exampleDialogs.length,
				altGreetings: card.alternateGreetings.length,
				hasLorebook: card.lorebook !== null && card.lorebook !== undefined,
				// 世界书体量：实测 48.4% 的卡 personaLen=0，内容全在
				// 「开场白 + 内嵌世界书」里（5491 张有世界书）——只按 persona 筛会误杀这批卡
				bookEntries: Array.isArray(card.lorebook?.entries) ? card.lorebook.entries.length : 0,
				bookChars: Array.isArray(card.lorebook?.entries)
					? card.lorebook.entries.reduce((n, e) => n + String(e?.content ?? "").length, 0)
					: 0,
				// 可触发条目数 = 非 constant、有 keys、正文非空的条目。
				// 与运行期 /status 的 dynamicEntries 同一个口径（共用 dynamicSourceOf）——
				// 这才是「P2 用得上用不上」的信号：bookEntries 只说明有世界书，
				// 而实测约三分之一的卡其世界书全是 constant（走静态人设提炼，不吃 keys）。
				dynEntries: dynamicSourceOf(card)?.lorebook?.entries?.length ?? 0,
				// 内容总量（人设 + 开场白 + 世界书），作为「这张卡是否丰富」的综合指标
				contentLen:
					Math.max(card.personality.length, (card.personaDerived ?? "").length) +
					card.firstMessage.length +
					(Array.isArray(card.lorebook?.entries)
						? card.lorebook.entries.reduce((n, e) => n + String(e?.content ?? "").length, 0)
						: 0),
				fileTags: meta.fileTags ?? [],
				// 可搜正文摘要：**这是修「搜不到人设里的词」的关键**。
				// 实测搜「学姐」时，只搜卡名/路径命中 17 张，而正文实际含该词的约 421 张
				// （漏检 96%）。所以把可搜文本压进索引。
				// 只取人设+兜底+开场白+简介+场景，**不含世界书**（那是 MB 级大头）；
				// 每人截 2000 字 —— 实测该上限下索引约 20MB，加载与解析可接受。
				// 给列表显示的一句预览（description 优先、firstMessage 兜底，实测覆盖 73%）
				preview: buildPreview(card),
				digest: buildDigest(card).slice(0, 2000),
				mtimeMs: st.mtimeMs,
				sizeBytes: st.size,
			});
		} catch (error) {
			failed.push({ rel, why: String(error?.message ?? error).slice(0, 120) });
		}
		processed += 1;
		if (processed % batch === 0) {
			if (typeof onProgress === "function") {
				onProgress({ processed, total: files.length, entries: entries.length, failed: failed.length });
			}
			await new Promise((r) => setImmediate(r)); // 让出事件循环
		}
	}

	return {
		version: INDEX_VERSION,
		root,
		builtAt: new Date().toISOString(),
		elapsedMs: Date.now() - t0,
		total: files.length,
		entries,
		failed,
	};
}

export function saveLocalIndex(index) {
	mkdirSync(STATE_ROOT, { recursive: true });
	writeFileSync(INDEX_FILE, JSON.stringify(index));
	return INDEX_FILE;
}

export function loadLocalIndex() {
	try {
		const idx = JSON.parse(readFileSync(INDEX_FILE, "utf8"));
		if (idx?.version !== INDEX_VERSION) return null; // 结构变更 → 判失效
		if (!Array.isArray(idx.entries)) return null;
		return idx;
	} catch {
		return null;
	}
}

/* ───────────────────── 查询（多维度筛选） ───────────────────── */

/**
 * 在索引上做多维度筛选。所有条件**可选且可叠加**（AND 语义）。
 *
 * ⚠️ 能力边界：`keyword` **只匹配卡名与相对路径**（路径含目录名 → 可按分类/月份搜）。
 * 索引不缓存正文（避免复制 13GB），所以**搜不到人设正文里的词**。
 * 想按正文找卡：先用元数据筛出候选，再对候选逐个 card_read。
 *
 * 返回 { items, total, facets } —— facets 供面板渲染"每个分类有几张"。
 */
export function queryLocalIndex(index, filters = {}) {
	if (index === null || index === undefined) throw new LocalError("本地索引未建立（先构建索引）");
	const {
		keyword = "",
		categories = null,
		months = null,
		classified = null,
		hasLorebook = null,
		minPersona = null,
		maxPersona = null,
		// 内容总量（人设+开场白+世界书）：48.4% 的卡 personaLen=0 但内容在世界书里，
		// 所以「找内容丰富的卡」应该用 contentLen，不要只用 personaLen
		minContent = null,
		maxContent = null,
		minBookEntries = null,
		// 可触发条目数下限（键 ── 非 constant 且带 keys 的条目）。
		// 与 minBookEntries 是两个数：后者是「世界书多厚」，这个是「keys 触发能吃到几条」。
		minDynEntries = null,
		// 文件名标签（如「蒸汽朋克」「猎魔人」）—— 与目录分类互补的细粒度维度
		fileTags = null,
		spec = null,
		limit = 200,
		offset = 0,
		sort = "name",
	} = filters;

	const cats = categories === null ? null : (Array.isArray(categories) ? categories : [categories]).filter(Boolean);
	const mons = months === null ? null : (Array.isArray(months) ? months : [months]).filter(Boolean);
	const ftags = fileTags === null ? null : (Array.isArray(fileTags) ? fileTags : [fileTags]).filter(Boolean);
	const kw = String(keyword ?? "").trim().toLowerCase();

	const hit = index.entries.filter((e) => {
		if (cats !== null && !cats.includes(e.category)) return false;
		if (mons !== null && !mons.includes(e.month)) return false;
		if (classified !== null && e.classified !== classified) return false;
		if (hasLorebook !== null && e.hasLorebook !== hasLorebook) return false;
		if (minPersona !== null && e.personaLen < minPersona) return false;
		if (maxPersona !== null && e.personaLen > maxPersona) return false;
		if (minContent !== null && (e.contentLen ?? 0) < minContent) return false;
		if (maxContent !== null && (e.contentLen ?? 0) > maxContent) return false;
		if (minBookEntries !== null && (e.bookEntries ?? 0) < minBookEntries) return false;
		if (minDynEntries !== null && (e.dynEntries ?? 0) < minDynEntries) return false;
		if (ftags !== null && !ftags.some((t) => (e.fileTags ?? []).includes(t))) return false;
		if (spec !== null && e.spec !== spec) return false;
		if (kw.length > 0) {
			// 三个来源：卡名、路径（含分类/月份目录名）、正文摘要
			const hay = `${e.name}\n${e.rel}\n${e.digest ?? ""}`.toLowerCase();
			if (!hay.includes(kw)) return false;
		}
		return true;
	});

	const facets = {
		categories: {},
		months: {},
		classified: { true: 0, false: 0 },
		lorebook: { true: 0, false: 0 },
		specs: {},
		fileTags: {},
	};
	for (const e of hit) {
		if (e.category !== null) facets.categories[e.category] = (facets.categories[e.category] ?? 0) + 1;
		if (e.month !== null) facets.months[e.month] = (facets.months[e.month] ?? 0) + 1;
		facets.classified[e.classified ? "true" : "false"] += 1;
		facets.lorebook[e.hasLorebook ? "true" : "false"] += 1;
		facets.specs[e.spec] = (facets.specs[e.spec] ?? 0) + 1;
		for (const t of e.fileTags ?? []) facets.fileTags[t] = (facets.fileTags[t] ?? 0) + 1;
	}

	const sorted = [...hit];
	if (sort === "personaDesc") sorted.sort((a, b) => b.personaLen - a.personaLen);
	else if (sort === "personaAsc") sorted.sort((a, b) => a.personaLen - b.personaLen);
	else if (sort === "contentDesc") sorted.sort((a, b) => (b.contentLen ?? 0) - (a.contentLen ?? 0));
	else if (sort === "bookDesc") sorted.sort((a, b) => (b.bookEntries ?? 0) - (a.bookEntries ?? 0));
	else if (sort === "dynDesc") sorted.sort((a, b) => (b.dynEntries ?? 0) - (a.dynEntries ?? 0));
	else if (sort === "mtimeDesc") sorted.sort((a, b) => b.mtimeMs - a.mtimeMs);
	else sorted.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh"));

	const page = sorted.slice(offset, offset + limit);
	return {
		total: hit.length,
		facets,
		items: page.map((e) => ({
			fullPath: localRef(e.rel),
			source: "local",
			name: e.name,
			// tagline = 卡片副标题。
			//
			// 原先拼的是「未分类 · 人设 0 字 / 开场白 1448 字 / 世界书 21 条」——
			// 实测（`queryLocalIndex` 直接返回给列表的就是这个值）用户完全看不懂：
			// 那不是简介而是元数据堆砌，且「未分类」占 8212/11480 全是噪音。
			// 改为**只说对用户有意义的事**，没有就留空（让 UI 不渲染这一行）：
			//   · 有真分类 → 显示分类
			//   · 有**可触发**条目 → 显示条数（这才是「keys 能用上几条」）
			//   · 世界书全是 constant → 明说是常驻（那些走静态人设提炼，不吃 keys）
			//   都没有 → 空串，UI 直接不显示这行，不留空占位。
			tagline: (() => {
				const cat = realCategory(e.category);
				const bits = [];
				if (cat.length > 0) bits.push(cat);
				const dyn = e.dynEntries ?? 0;
				const book = e.bookEntries ?? 0;
				if (dyn > 0) bits.push(`可触发 ${dyn} 条`);
				else if (book > 0) bits.push(`世界书 ${book} 条（全常驻）`);
				return bits.join(" · ");
			})(),
			// tags 只保留有信息量的：优先「#文件标签#」（卡名里的真实分类），
			// 否则用真分类。**不再把月份与「未分类」塞进去** —— 那是目录/归档名。
			tags: (() => {
				const ft = (e.fileTags ?? []).map((x) => String(x ?? "").trim()).filter((x) => x.length > 0);
				if (ft.length > 0) return ft;
				const cat = realCategory(e.category);
				return cat.length > 0 ? [cat] : [];
			})(),
			// 卡片描述（description 优先、firstMessage 兜底；实测覆盖 74%）。
			// 空串时客户端不渲染这一行（用户要求「没有的字段就直接不显示」）。
			preview: e.preview ?? "",
			category: e.category,
			month: e.month,
			classified: e.classified,
			spec: e.spec,
			personaLen: e.personaLen,
			firstMesLen: e.firstMesLen,
			bookEntries: e.bookEntries ?? 0,
			dynEntries: e.dynEntries ?? 0,
			bookChars: e.bookChars ?? 0,
			contentLen: e.contentLen ?? 0,
			fileTags: e.fileTags ?? [],
			hasLorebook: e.hasLorebook,
			altGreetings: e.altGreetings,
			rating: null,
			nsfwImage: false,
			// 封面：走插件的 /local-image 路由（只回 PNG 头部，浏览器渐进显示）。
			// 直连 file:// 在 Web 环境不可用，必须由宿主服务出去。
			avatarUrl: `/dsh-card-summon/local-image?rel=${encodeURIComponent(e.rel)}`,
			langId: 12,
			stats: null,
		})),
	};
}

export {
	INDEX_FILE,
	INDEX_VERSION,
	extractCandidates,
	decodeChunkText,
	extractFileTags,
	metaFromPath,
	TAIL_START_BYTES,
	TAIL_MAX_BYTES,
};
