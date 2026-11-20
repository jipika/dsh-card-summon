/**
 * 注入前转换层：把酒馆卡里的 HTML/自造标签与状态栏模板改写成 Markdown。
 *
 * 为什么在**注入前**做（而不是靠提示词约束模型）：
 *   · 卡里的 `<StatusBar>` 模板块、`</text>`、`<user>` 会被模型当成输出格式照抄；
 *   · DSH 的渲染管线不解析 HTML（防 XSS 的设计，raw HTML 原样显示），
 *     靠一句「不要输出标签」的提示词压不住卡内 PHI / 世界书里的强指令。
 *   所以直接把模型看到的卡文本改写成 Markdown：它没有可照抄的标签模板，
 *   显示端也用同一转换器处理旧回复；不依赖模型服从格式约束。
 *
 * 转换规则（只动格式，不动设定内容）：
 *   1. ```<StatusBar>…</StatusBar>``` 或裸 `<StatusBar>…</StatusBar>`
 *      → Markdown 嵌套列表，YAML 字段信息全部保留；
 *   2. 仅描述旧包装的 `<StatusBar>` 指令行删除，不添加输出格式指令；
 *   3. `<user>`/`<char>` → `{{user}}`/`{{char}}`（酒馆占位符，交给宏求值）；
 *   4. `<br>` → 换行、`<p>` → 空行、`<hr>` → `---`、`<b>/<strong>` → `**`、`<i>/<em>` → `*`；
 *   5. `<START>` 原样保留（示例分隔符）；其余未知标签（`</text>`、`<center>`、`<font>`、
 *      `<jing>`、`<maintext>`…）一律去掉，只留内部文本。
 */

import { statusBodyToMarkdown } from "./status-compat.js";
export { statusBodyToMarkdown } from "./status-compat.js";

/** 必须保留的标签（示例分隔符，插件自己消费）。 */
const KEEP = new Set(["START"]);

/**
 * 状态栏块按**行**识别，避免把行内示例（「必须用 <StatusBar></StatusBar> 包裹」）
 * 当成块替换掉、把整句指令改坏。
 *   · 行首单独的 `<StatusBar>` / `<Status_block …>`（可带 ``` 前缀）→ 嵌套列表；
 *   · 包装指令删除，其余行只去掉包装标签。
 */
function markdownizeStatusBlocks(text) {
	const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
	const out = [];
	const startRe = /^\s*(?:`{3,}\s*)?<StatusBar>\s*(?:`{3,})?\s*$/i;
	const endRe = /^\s*(?:`{3,}\s*)?<\/StatusBar>\s*(?:`{3,})?\s*$/i;
	const startBlockRe = /^\s*(?:`{3,}\s*)?<Status_block[^>]*>\s*(?:`{3,})?\s*$/i;
	const endBlockRe = /^\s*(?:`{3,}\s*)?<\/Status_block>\s*(?:`{3,})?\s*$/i;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const isStatus = startRe.test(line);
		const isBlock = startBlockRe.test(line);
		if (isStatus || isBlock) {
			const end = isStatus ? endRe : endBlockRe;
			const body = [];
			let j = i + 1;
			while (j < lines.length && !end.test(lines[j])) {
				body.push(lines[j]);
				j++;
			}
			// 模板块常被 ``` 围栏包着（模板示例）；围栏本身要一起吞掉，
			// 否则转换后会留下孤立的 ``` 行，DSH 会当成代码块开始。
			if (out.length > 0 && /^\s*`{3,}\s*$/.test(out[out.length - 1])) out.pop();
			out.push(statusBodyToMarkdown(body.join("\n")));
			let next = j < lines.length ? j + 1 : j;
			if (next < lines.length && /^\s*`{3,}\s*$/.test(lines[next])) next++;
			i = next;
			continue;
		}
		if (/<StatusBar>|<Status_block[^>]*>/i.test(line)) {
			// Obsolete wrapper-only directives carry no character facts. Do not replace them with new instructions.
			if (/外层|包裹|必须用|最终结构/.test(line)) { i++; continue; }
			out.push(line.replace(/<\/?(?:StatusBar|Status_block)(?:\s[^<>]*)?>/gi, ""));
			i++;
			continue;
		}
		out.push(line);
		i++;
	}
	return out.join("\n");
}

/**
 * 单段文本转换。
 * @param {string} text
 * @returns {string}
 */
export function markdownizeText(text) {
	let s = String(text ?? "");
	if (s.length === 0) return s;

	// Normalize placeholders before escaping literal values inside status templates.
	s = s.replace(/\{\{\s*<user>\s*\}\}/gi, "{{user}}")
		.replace(/\{\{\s*<char>\s*\}\}/gi, "{{char}}")
		.replace(/<\/?user>/gi, "{{user}}")
		.replace(/<\/?char>/gi, "{{char}}");
	// 1) 状态栏模板块 / 指令行（行扫描，见 markdownizeStatusBlocks）
	s = markdownizeStatusBlocks(s);

	// 4) 常见排版标签 → Markdown
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<\/?p[^>]*>/gi, "\n\n");
	s = s.replace(/<hr\s*\/?>/gi, "\n---\n");
	s = s.replace(/<\/?(?:b|strong)>/gi, "**");
	s = s.replace(/<\/?(?:i|em)>/gi, "*");

	// 5) 其余未知标签去掉（保留内部文本）；`<START>` 是示例分隔符，保留
	s = s.replace(/<\/?([A-Za-z][A-Za-z0-9_-]*)(?:\s[^<>]*)?\/?>/g, (m, name) =>
		KEEP.has(name.toUpperCase()) ? m : "",
	);

	// 收尾：连续 3 个以上空行压成 2 个
	s = s.replace(/\n{3,}/g, "\n\n");
	return s;
}

/** 需要转换的卡字段（都是会进注入段的文本）。 */
const TEXT_FIELDS = [
	"description",
	"personality",
	"personaDerived",
	"scenario",
	"firstMessage",
	"exampleDialogs",
	"systemPrompt",
	"postHistoryInstructions",
	"depthPrompt",
];

/**
 * 卡级转换：返回新对象，不改原卡（面板详情仍看作者原文；模型只拿得到转换后的注入段）。
 * 覆盖人设/开场白/示例/系统提示/PHI 与世界书条目的 content。
 */
export function markdownizeCard(card) {
	if (card === null || typeof card !== "object") return card;
	const out = { ...card };
	for (const key of TEXT_FIELDS) {
		if (typeof out[key] === "string") out[key] = markdownizeText(out[key]);
	}
	const book = out.lorebook;
	if (book !== null && typeof book === "object" && Array.isArray(book.entries)) {
		out.lorebook = {
			...book,
			entries: book.entries.map((entry) => {
				if (entry === null || typeof entry !== "object") return entry;
				if (typeof entry.content !== "string") return entry;
				return { ...entry, content: markdownizeText(entry.content) };
			}),
		};
	}
	// personaDerivedDropped 的正文也要转：这些条目没进首屏，但会经 card_inject_more 补注入 ——
	// 补进来的若是作者原文，模型照样能照抄 `<details><summary>…` 那套模板，等于绕开整个转换层。
	if (Array.isArray(out.personaDerivedDropped)) {
		out.personaDerivedDropped = out.personaDerivedDropped.map((item) =>
			item !== null && typeof item === "object" && typeof item.body === "string"
				? { ...item, body: markdownizeText(item.body) }
				: item,
		);
	}
	return out;
}
