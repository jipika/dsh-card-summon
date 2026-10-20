/**
 * 注入前转换层：把酒馆卡里的 HTML/自造标签与状态栏模板改写成 Markdown。
 *
 * 为什么在**注入前**做（而不是靠提示词约束模型）：
 *   · 卡里的 `<StatusBar>` 模板块、`</text>`、`<user>` 会被模型当成输出格式照抄；
 *   · DSH 的渲染管线不解析 HTML（防 XSS 的设计，raw HTML 原样显示），
 *     靠一句「不要输出标签」的提示词压不住卡内 PHI / 世界书里的强指令。
 *   所以直接把模型看到的卡文本改写成 Markdown：它没有可照抄的标签模板，
 *   也就不会输出标签。转换层是唯一的格式治理手段，不另留格式提示词。
 *
 * 转换规则（只动格式，不动设定内容）：
 *   1. ```<StatusBar>…</StatusBar>``` 或裸 `<StatusBar>…</StatusBar>`
 *      → Markdown 引用块（每行 `> `，字段名加粗），YAML 字段信息全部保留；
 *   2. 含 `<StatusBar>` 的指令行（「外层必须用…包裹」）
 *      → 「用 Markdown 引用块输出」；
 *   3. `<user>`/`<char>` → `{{user}}`/`{{char}}`（酒馆占位符，交给宏求值）；
 *   4. `<br>` → 换行、`<p>` → 空行、`<hr>` → `---`、`<b>/<strong>` → `**`、`<i>/<em>` → `*`；
 *   5. `<START>` 原样保留（示例分隔符）；其余未知标签（`</text>`、`<center>`、`<font>`、
 *      `<jing>`、`<maintext>`…）一律去掉，只留内部文本。
 */

/** 必须保留的标签（示例分隔符，插件自己消费）。 */
const KEEP = new Set(["START"]);

/** 状态栏字段名加粗：`  Date_and_Time: "…"` → `  **Date_and_Time**: "…"`。 */
function boldKeys(line) {
	return line.replace(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(\s*:)/, "$1**$2**$3");
}

/** 把状态栏模板正文转成 Markdown 引用块。 */
export function statusBodyToMarkdown(body) {
	const lines = String(body ?? "")
		.replace(/\r\n?/g, "\n")
		.split("\n");
	// 去掉首尾空行
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	const out = [];
	for (const raw of lines) {
		const line = raw.replace(/\s+$/, "");
		if (line.trim() === "") {
			out.push(">");
			continue;
		}
		// 每行都保留原始缩进，只把「key:」的键名加粗，层级关系不丢。
		out.push(`> ${boldKeys(line)}`);
	}
	return out.join("\n");
}

/** 一行状态栏指令（含 <StatusBar> 标签、不在模板块内）→ Markdown 说明。 */
const STATUS_DIRECTIVE =
	"[状态栏数据]用 Markdown 引用块输出（每行以 > 开头，字段名加粗）；不要使用尖括号标签或代码块。";

/**
 * 状态栏块按**行**识别，避免把行内示例（「必须用 <StatusBar></StatusBar> 包裹」）
 * 当成块替换掉、把整句指令改坏。
 *   · 行首单独的 `<StatusBar>` / `<Status_block …>`（可带 ``` 前缀）→ 收集到闭合行，转引用块；
 *   · 其它含状态栏标签的行 → 整行改写成 Markdown 指令句。
 */
function markdownizeStatusBlocks(text) {
	const lines = String(text).split("\n");
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
			out.push(STATUS_DIRECTIVE);
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

	// 1) 状态栏模板块 / 指令行（行扫描，见 markdownizeStatusBlocks）
	s = markdownizeStatusBlocks(s);

	// 2) 酒馆占位符标签 → 宏（先处理 {{<user>}} 这种包裹形态，避免嵌套成 {{{{user}}}}）
	s = s.replace(/\{\{\s*<user>\s*\}\}/gi, "{{user}}");
	s = s.replace(/\{\{\s*<char>\s*\}\}/gi, "{{char}}");
	s = s.replace(/<\/?user>/gi, "{{user}}");
	s = s.replace(/<\/?char>/gi, "{{char}}");

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
 * 卡级转换：返回新对象，不改原卡（`card_read` 仍能读到作者原文）。
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
	return out;
}
