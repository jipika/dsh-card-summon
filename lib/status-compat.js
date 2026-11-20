/** Shared lexical adapter for Tavern status templates and assistant display; never executes card scripts. */
export function createStatusCompat() {
	const labels = {
		Status_Bar: "状态栏", Date_and_Time: "时间", Location: "地点", User_List: "人物",
		User: "角色", Name: "姓名", Action: "当前行动", Inner_Thoughts: "内心", Outfit: "穿着",
		Recent_Sexual_Activity: "最近性行为", Action_Options: "行动选项", Options: "选项",
	};
	const rootRe = /^(?:\*\*)?Status_Bar(?:\*\*)?\s*[:：]\s*$/i;
	const tagRe = /^\s*(?:`{3,}\s*)?<(StatusBar|Status_block)(?:\s[^<>]*)?>\s*$/i;
	const keyRe = /^(?:(-)[ \t]+)?(?:\*\*)?([\p{L}_][\p{L}\p{N}_ -]*?)(?:\*\*)?\s*[:：](?:[ \t]+(.*)|$)/u;
	const unquote = (value) => {
		const s = value.trim();
		return s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))
			? s.slice(1, -1) : s;
	};
	// Escape Markdown syntax in values: formatting must not turn a literal tag/link into active content.
	const literal = (value) => value.split(/(\{\{[^{}]*\}\})/g).map((part) => /^\{\{[^{}]*\}\}$/.test(part) ? part :
		part.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_[\]|])/g, "\\$1")).join("");
	const label = (key) => labels[key] ?? key;

	/** Convert the indentation vocabulary, not YAML values; duplicate keys and list entries stay intact. */
	function statusBodyToMarkdown(body) {
		const lines = String(body ?? "").replace(/\r\n?/g, "\n").split("\n");
		const out = [];
		const indents = [];
		let previousIndent = 0;
		for (const raw of lines) {
			// Text-style Tavern panels use details/summary as grouping wrappers.
			const summary = raw.match(/^\s*(?:<details[^>]*>\s*)?<summary[^>]*>(.*?)<\/summary>\s*$/i);
			if (summary) { out.push("", `**${literal(summary[1])}**`, ""); continue; }
			if (/^\s*<\/?details[^>]*>\s*$/i.test(raw)) continue;
			const clean = raw.replace(/^\s*> ?/, "").replace(/\t/g, "    ").replace(/\s+$/, "");
			const text = clean.trim();
			if (!text || /^`{3,}(?:yaml|yml)?\s*$/i.test(text)) continue;
			if (rootRe.test(text)) { out.push("**状态栏**", ""); continue; }
			const indent = clean.length - clean.trimStart().length;
			while (indents.length && indent < indents.at(-1)) indents.pop();
			if (!indents.length || indent > indents.at(-1)) indents.push(indent);
			const depth = indents.length - 1;
			const prefix = "  ".repeat(depth);
			const match = text.match(keyRe);
			if (match) {
				const [, , key, value = ""] = match;
				out.push(`${prefix}- **${literal(label(key))}**:${value ? ` ${literal(unquote(value))}` : ""}`);
			} else if (/^-\s+/.test(text)) {
				out.push(`${prefix}- ${literal(unquote(text.replace(/^-\s+/, "")))}`);
			} else {
				// Preserve prose and block-scalar continuations as text with explicit hard breaks.
				out.push(`${"  ".repeat(Math.max(1, previousIndent))}${literal(text)}  `);
			}
			previousIndent = depth + 1;
		}
		return out.join("\n").trim();
	}

	/** Recognize complete tagged blocks, legacy quotes, and fenced/bare Status_Bar YAML. */
	function normalizeStatusText(input, { streaming = false } = {}) {
		const source = String(input ?? "");
		if (!/Status[_ ]?Bar|Status_block/i.test(source)) return source;
		const lines = source.replace(/\r\n?/g, "\n").split("\n");
		const out = [];
		let changed = false;
		for (let i = 0; i < lines.length;) {
			const line = lines[i];
			const tagged = line.match(tagRe);
			if (tagged) {
				let end = i + 1;
				const close = new RegExp(`^\\s*</${tagged[1]}>\\s*(?:\x60{3,})?\\s*$`, "i");
				while (end < lines.length && !close.test(lines[end])) end++;
				if (end === lines.length) { out.push(...lines.slice(i)); break; }
				changed = true;
				if (out.length && /^\s*`{3,}(?:yaml|yml)?\s*$/i.test(out.at(-1))) out.pop();
				out.push("", statusBodyToMarkdown(lines.slice(i + 1, end).join("\n")), "");
				i = end + 1;
				if (/^\s*`{3,}\s*$/.test(lines[i] ?? "")) i++;
				continue;
			}
			const quoted = /^\s*>/.test(line);
			const plain = line.replace(/^\s*> ?/, "").trim();
			if (rootRe.test(plain)) {
				let end = i + 1;
				while (end < lines.length) {
					const candidate = lines[end];
					if (quoted ? !/^\s*>/.test(candidate) : !/^\s+\S/.test(candidate)) break;
					end++;
				}
				// A fenced status block must close before its YAML is consumed, including during streaming.
				const fenced = out.length && /^\s*`{3,}(?:yaml|yml)?\s*$/i.test(out.at(-1));
				if ((fenced && !/^\s*`{3,}\s*$/.test(lines[end] ?? "")) || (streaming && end === lines.length)) {
					out.push(...lines.slice(i)); break;
				}
				const body = lines.slice(i, end).map((s) => s.replace(/^\s*> ?/, "")).join("\n");
				if (!/\b(?:Location|Date_and_Time|User_List|Action_Options)\s*(?:\*\*)?\s*[:：]/.test(body)) {
					out.push(line); i++; continue;
				}
				changed = true;
				if (fenced) out.pop();
				out.push("", statusBodyToMarkdown(body), "");
				i = end;
				if (/^\s*`{3,}\s*$/.test(lines[i] ?? "")) i++;
				continue;
			}
			out.push(line); i++;
		}
		return changed ? out.join("\n") : source;
	}
	return { statusBodyToMarkdown, normalizeStatusText };
}

export const { statusBodyToMarkdown, normalizeStatusText } = createStatusCompat();
