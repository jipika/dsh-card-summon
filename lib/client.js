/*
 * dsh-card-summon — browser half
 *
 * 挂进 `conversation.input.right`（提交按钮前的紧凑控件区）：一个「角色卡」按钮 + portal 面板。
 * 面板里：搜索框 → 卡片网格（头像/卡名/作者/标签）→ 点头像召唤 / 解除。
 *
 * 要点（本机踩过的坑，照 dsh-workbuddy-summon 的结论走）：
 *   · factory id 必须等于包名，否则设置页按 {only: row.id} 过滤会落空白行；
 *   · slot 出口是 display:contents，容器 rect 全是 0 → 浮层必须 portal 到 body；
 *   · 官方 overlay 天花板 z-index 20，取 15；
 *   · 样式与监听都在 apply 里用 ctx.effect 注册并返回清理函数；
 *   · 不要加「window.__xxxRegistered 模块级幂等守卫」：宿主热替换（entries.ts replace）
 *     会先 invalidate 删掉 factory 再重新 eval 本文件，守卫会让 load() 被跳过，
 *     宿主报 "loaded without registering"；重复 entry 在 manifest 解析期已被宿主硬拒。
 *   · 只改本文件内容 → 刷新页面即可生效；新增/移除 client 半边 → 必须重启应用。
 *
 * 头像一律用 avatarUrl（webp 缩略图，实测 ~9 KB）；**不要**在列表里用 cardPngUrl，
 * 那是 12.9 MB 一张的完整卡 PNG，20 张就能把页面拖垮。
 *
 * 设计纪律：全部规则锚 .dcs-* 根类；官方 --dsw-* token；radius 四档；
 * 动效 120/160ms + ease；焦点环 focus-ring；reduced-motion 降级；不碰宿主 DOM。
 */
window.__ModuleLoader__.load({
		id: "dsh-card-summon",
		factory: (require) => {
			var module = { exports: {} };
			var exports = module.exports;
			Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

			const React = require("react");
			const ReactDOM = require("react-dom");
			const h = React.createElement;

			const BASE = "/dsh-card-summon";
			// 菜单行 → 面板宿主的跨条目信号：SummonRow（工具箱菜单里）点击后把锚点
			// 坐标发给 SummonHost（常驻 composer 的隐藏宿主），由它打开面板。
			const panelRequests = {
				listeners: new Set(),
				emit(payload) {
					for (const fn of [...this.listeners]) {
						try { fn(payload); } catch { /* 单个监听失败不影响其他 */ }
					}
				},
				on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
			};
			const STYLE_ID = "dsh-card-summon-style";
			const NS = "card-summon";

			/**
			 * 面板宽度 —— **单一来源**。
			 *
			 * 踩过的坑：面板原本按 420 写死，后来加宽到 520，但定位代码里的
			 * `window.innerWidth - 428`（428 = 420 + 8 边距）没跟着改，导致面板位置算错。
			 * 根因是「同一个尺寸散落在 CSS 与 JS 两处、靠人记住」。
			 * 所以只定义一次，CSS 的 width 与定位逻辑都从它派生 —— 不可能再漂。
			 *
			 * ⚠️ 必须在样式数组**之前**声明：下面的模板字面量会引用它，
			 * 放到后面会因 TDZ 抛错、整段样式挂掉。
			 */
			const PANEL_W = 520;
			const PANEL_EDGE = 8;

			const STRINGS = {
				zh: {
					title: "角色卡",
					searchPlaceholder: "搜卡名、分类或人设里的词…",
					search: "搜索",
					loading: "搜索中…",
					empty: "没有搜到卡。换个关键词，或留空看热门。",
					error: "出错了",
					summon: "召唤",
					summoning: "召唤中…",
					unsummon: "解除召唤",
					qrSettings: "快捷按钮设置",
					reqTimeout: "请求超时：后台没有响应。可以直接重试；若刚重启过，首次搜索要等索引载入（约几秒）。",
					summoned: "已召唤",
					none: "当前会话没有召唤角色。",
					hint: "点卡片召唤该角色；点「详情」看完整提示词。",
					confirmTitle: "请确认后再继续",
					confirmGo: "继续召唤",
					confirmCancel: "取消",
					more: "加载更多",
					allLoaded: "已全部加载",
					prevPage: "上一页",
					nextPage: "下一页",
					pageWord: "第",
					dupNote: "已去重 {n} 条重复",
					dupTip: "Chub 深页会回吐已出现过的卡，已自动去重",
					detail: "卡详情",
					detailBtn: "详情",
					viewDetail: "查看提示词",
					copy: "复制",
					copied: "已复制",
					empty_field: "（此字段为空）",
					hintDetail: "右键卡片也可查看详情",
					varsTab: "变量",
					varsLoading: "读取变量…",
					varsGlobalTitle: "全局变量",
					varsGlobalNote: "所有卡共用；改这里会影响每一张用到它的卡",
					varsCardTitle: "这张卡的变量",
					varsUserHint: "你的名字",
					varsCharHint: "角色名",
					varsFilled: "已填",
					varsMissing: "待填",
					varsSave: "保存",
					varsSaving: "保存中…",
					varsSaved: "已保存，注入段已重算",
					varsHint: "没填的变量会原样留在提示词里（如 {{好感度}}），模型只能自己猜。",
					varsNoMacro: "这张卡没用到自定义变量。",
					varsKnown: "另有 {n} 种酒馆标准宏（{{roll 1d6}} 这类）本插件不实现，原样保留。",
					varsBuiltinNote: "内置宏：{list}",
					varsFile: "变量表",
					qrTab: "按钮",
					qrScopeGlobal: "所有卡通用",
					qrScopeCard: "这张卡专用",
					qrAdd: "加",
					qrIntro: "快捷按钮 = 点一下就替你把一句现成的话发给角色，不用每次手打。「发送」是发出去，「×」是删除。",
					qrCardSub: "只在这张卡被召唤时可用。",
					qrGlobalSub: "任何卡被召唤时都能用。",
					qrAddHead: "加一个",
					qrAddCard: "加到这张卡",
					qrAddGlobal: "加到所有卡",
					qrNewText: "要发出去的内容",
					qrNewLabel: "按钮上显示的名字（可留空）",
					qrEmpty: "还没有。在下面加一个。",
					qrManage: "管理快捷按钮",
					qrSend: "发送",
					qrSent: "已发送",
					qrQueued: "已排队，等当前回合结束",
					qrSendFailed: "发送失败",
					qrDelete: "删除",
					qrLimit: "每类最多 20 个",
					qrNeedText: "按钮正文不能为空",
					summonThis: "召唤此卡",
					clearCardMemory: "清除卡片记忆",
					clearCardMemoryCast: "阵容会话没有单卡记忆",
					clearCardMemoryConfirm:
						"清除这张卡的卡片记忆？（~/.dsh/memory/cards/ 下该卡的分片会被删除，删除后不可恢复；删除前全文会记进审计日志）",
					clearCardMemoryDone: "已清除",
					clearCardMemoryFail: "清除失败",
					clearCardMemoryNone: "本卡还没有卡片记忆",
					sourceLabel: "数据源",
					srcAll: "全部",
					srcSichang: "中文站",
					srcChub: "Chub",
					srcLocal: "自定义",
					originLabel: "取数来源",
					originLocal: "本地磁盘",
					originRemote: "GitHub",
					viewInjected: "点这里看当前注入的内容",
					injectedTitle: "注入原文",
					notSummoned: "当前没有注入任何内容。",
					castTag: "阵容",
					truncatedTag: "有截断",
					filterLabel: "筛选",
					filterCategory: "分类",
					scanLocal: "扫描本地卡库",
					scanning: "扫描中…",
					scanDone: "已扫描",
					localEmpty: "本地卡库还没建索引。点「扫描本地卡库」开始（约 30 秒）。",
					langLabel: "语言",
					langAll: "不限",
					langChinese: "中文",
					zhTipTitle: "找中文卡？",
					zhTipBody: "Chub 没有中文分类（「中文」标签筛的是题材不是语言）。切到「中文站」看原生中文卡，或用中文关键词搜。",
					chars: "注入字符",
					chats: "{n} 次聊天",
					openInChub: "在 Chub 打开",
				},
				en: {
					title: "Character Card",
					searchPlaceholder: "Search name, category, or persona text…",
					search: "Search",
					loading: "Searching…",
					empty: "No cards found. Try another keyword, or leave blank for popular.",
					error: "Error",
					summon: "Summon",
					summoning: "Summoning…",
					unsummon: "Unsummon",
					qrSettings: "Quick button settings",
					reqTimeout: "Request timed out — the backend did not respond. You can retry; right after a restart the first search waits for the index to load.",
					summoned: "Summoned",
					none: "No character summoned in this session.",
					hint: "Click a card to summon it; use \"Detail\" for the full prompts.",
					confirmTitle: "Please confirm before continuing",
					confirmGo: "Summon anyway",
					confirmCancel: "Cancel",
					more: "Load more",
					allLoaded: "All loaded",
					prevPage: "Previous",
					nextPage: "Next",
					pageWord: "Page",
					dupNote: "{n} duplicates removed",
					dupTip: "Chub returns duplicate cards on deep pages; deduplicated automatically",
					detail: "Card detail",
					detailBtn: "Detail",
					viewDetail: "View prompt",
					copy: "Copy",
					copied: "Copied",
					empty_field: "(empty)",
					hintDetail: "Right-click a card to view details",
					varsTab: "Variables",
					varsLoading: "Loading variables…",
					varsGlobalTitle: "Global variables",
					varsGlobalNote: "Shared by every card; changing these affects all cards using them",
					varsCardTitle: "This card\u2019s variables",
					varsUserHint: "Your name",
					varsCharHint: "Character\u2019s name",
					varsFilled: "Set",
					varsMissing: "Empty",
					varsSave: "Save",
					varsSaving: "Saving…",
					varsSaved: "Saved — the injected block was rebuilt",
					varsHint: "Unset variables stay in the prompt verbatim (like {{affection}}) \u2014 the model has to guess.",
					varsNoMacro: "This card uses no custom variables.",
					varsKnown: "{n} kind(s) of SillyTavern standard macro (like {{roll 1d6}}) are not implemented and stay verbatim.",
					varsBuiltinNote: "Built-in macros: {list}",
					varsFile: "Variables file",
					qrTab: "Buttons",
					qrScopeGlobal: "All cards",
					qrScopeCard: "This card only",
					qrAdd: "Add",
					qrIntro: "A quick button sends a ready-made line as you, in one click — no typing. \"Send\" fires it, \"×\" deletes it.",
					qrCardSub: "Only while this card is summoned.",
					qrGlobalSub: "Whenever any card is summoned.",
					qrAddHead: "Add one",
					qrAddCard: "To this card",
					qrAddGlobal: "To all cards",
					qrNewText: "What gets sent",
					qrNewLabel: "Name on the button (optional)",
					qrEmpty: "None yet — add one below.",
					qrManage: "Manage quick buttons",
					qrSend: "Send",
					qrSent: "Sent",
					qrQueued: "Queued until the current turn ends",
					qrSendFailed: "Send failed",
					qrDelete: "Delete",
					qrLimit: "Up to 20 of each",
					qrNeedText: "Button text cannot be empty",
					summonThis: "Summon this card",
					clearCardMemory: "Clear card memory",
					clearCardMemoryCast: "Cast sessions have no per-card memory",
					clearCardMemoryConfirm:
						"Clear this card's card memory? The shard under ~/.dsh/memory/cards/ will be deleted and cannot be restored (its full text is appended to the audit log first).",
					clearCardMemoryDone: "Cleared",
					clearCardMemoryFail: "Clear failed",
					clearCardMemoryNone: "No card memory yet",
					sourceLabel: "Source",
					srcAll: "All",
					srcSichang: "Chinese",
					srcChub: "Chub",
					srcLocal: "Custom",
					originLabel: "Fetch from",
					originLocal: "Local disk",
					originRemote: "GitHub",
					viewInjected: "Click to view what is currently injected",
					injectedTitle: "Injected prompt",
					notSummoned: "Nothing is injected right now.",
					castTag: "Cast",
					truncatedTag: "Truncated",
					filterLabel: "Filter",
					filterCategory: "Category",
					scanLocal: "Scan local library",
					scanning: "Scanning…",
					scanDone: "Scanned",
					localEmpty: "No local index yet. Click \"Scan local library\" (about 30s).",
					langLabel: "Lang",
					langAll: "Any",
					langChinese: "Chinese",
					zhTipTitle: "Looking for Chinese cards?",
					zhTipBody: "Chub has no Chinese category (the Chinese tag is a theme, not a language). Switch to the Chinese source, or search with Chinese keywords.",
					chars: "injected chars",
					chats: "{n} chats",
					openInChub: "Open in Chub",
				},
			};

			/**
			 * 变量 Tab 的 key。双下划线前缀是**故意的**：卡字段 tab 的名字直接来自
			 * PROMPT_FIELDS，万一哪天卡模型多了个叫 `vars` 的字段，两者会串页。
			 */
			const VARS_TAB = "__vars";
			/**
			 * 快捷按钮 Tab 的 key。同 VARS_TAB 的双下划线前缀理由：tab 名不能与卡字段撞。
			 */
			const QR_TAB = "__qr";
			
			/** 详情里可查看的提示词字段（顺序即 tab 顺序）。 */
			const PROMPT_FIELDS = [
				["personality", "人设"],
				["description", "简介"],
				["scenario", "场景"],
				["firstMessage", "开场白"],
				["exampleDialogs", "对话示例"],
				["systemPrompt", "系统提示"],
				["postHistoryInstructions", "后续指令"],
				["alternateGreetings", "替代开场白"],
				["lorebook", "世界书"],
			];

			/**
			 * 取某字段的**原文**文本（`{{char}}` / `{{user}}` 等占位符原样保留 ——
			 * 用户要的就是「看到提示词」，这里不做任何转义或替换；
			 * 这条走 HTTP JSON，与宿主 systemPrompt 插值链路无关）。
			 */
			function promptFieldText(data, key) {
				if (data === null || data === undefined || !data.prompt) return "";
				const v = data.prompt[key];
				if (v === null || v === undefined) return "";
				if (typeof v === "string") return v;
				if (Array.isArray(v)) {
					return v.map((x, i) => `── #${i + 1} ──\n${typeof x === "string" ? x : JSON.stringify(x, null, 1)}`).join("\n\n");
				}
				return JSON.stringify(v, null, 1);
			}

			/**
			 * 生成页码序列（纯函数，便于离线回归）：当前页附近显示全，远处折叠成 …。
			 * 例：page=5 total=20 → [1,"…",4,5,6,"…",20]
			 */
			function pageNumbers(page, total, span = 1) {
				const cur = Math.max(1, Number(page) || 1);
				const tot = Math.max(1, Number(total) || 1);
				if (tot <= 7) return Array.from({ length: tot }, (_, i) => i + 1);
				const out = new Set([1, tot]);
				for (let d = -span; d <= span; d++) {
					const n = cur + d;
					if (n >= 1 && n <= tot) out.add(n);
				}
				const sorted = [...out].sort((a, b) => a - b);
				const res = [];
				let prev = 0;
				for (const n of sorted) {
					if (prev !== 0 && n - prev > 1) res.push("…");
					res.push(n);
					prev = n;
				}
				return res;
			}

			function installStyle() {
				if (document.getElementById(STYLE_ID)) return () => {};
				const el = document.createElement("style");
				el.id = STYLE_ID;
				// 统一走官方 token：radius/elevation/focus-ring/menu-surface/font/scrollbar 全部
				// --dsw-*；--dcs-* 只留动效时长（官方无对应 token）。Apple 质感 = 毛玻璃底
				// （menu-surface-fill + backdrop-filter）+ elevation-prominent + hairline 描边
				// + 段控件浮块 + card 只留描边、hover 才起底。
				el.textContent = [
					`.dcs-panel{--dcs-fast:120ms;--dcs-base:160ms}`,
					// ── 面板：毛玻璃卡片 ──
					`.dcs-panel{position:fixed;z-index:15;width:${PANEL_W}px;max-width:calc(100vw - 16px);display:flex;flex-direction:column;background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px));overflow:hidden;font:var(--dsw-font-xxs-12);transform-origin:bottom center;animation:dcs-in var(--dcs-base) cubic-bezier(.32,.72,.35,1)}`,
					`@keyframes dcs-in{from{opacity:0;transform:translateY(8px) scale(.97)}to{opacity:1;transform:none}}`,
					`.dcs-panel[data-closing="1"]{animation:dcs-out var(--dcs-fast) ease forwards}`,
					`@keyframes dcs-out{to{opacity:0;transform:translateY(4px) scale(.98)}}`,
					`@media (prefers-reduced-motion:reduce){.dcs-panel,.dcs-panel[data-closing="1"]{animation:none}.dcs-panel *{transition:none!important}}`,
					// 滚动条：细、半透明（macOS overlay 感）
					`.dcs-body::-webkit-scrollbar{width:6px}`,
					`.dcs-body::-webkit-scrollbar-thumb{border-radius:999px;background:var(--dsw-alias-scrollbar-bg-l2,var(--dsw-alias-border-l3))}`,
					`.dcs-body::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2,var(--dsw-alias-label-tertiary))}`,
					`.dcs-body::-webkit-scrollbar-track{background:transparent}`,
					`.dcs-body{scrollbar-width:thin;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2,var(--dsw-alias-border-l3)) transparent}`,
					// 工具箱菜单行的补充样式（基础行样式 .dtb-row 由 dsh-toolbox 注入）
					`.dcs-row .dcs-row-icon{font-size:15px;line-height:1}`,
					`.dcs-row .dcs-row-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
					`.dcs-row .dcs-row-state{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-tertiary);white-space:nowrap}`,
					// 通用小按钮
					`.dcs-btn{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:var(--dsw-radius-sm);border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;white-space:nowrap;transition:background var(--dcs-fast) ease,color var(--dcs-fast) ease}`,
					`@media(hover:hover){.dcs-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}`,
					`.dcs-btn:active{opacity:.65}`,
					`.dcs-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}`,
					`.dcs-btn[data-active="1"]{color:var(--dsw-alias-brand-primary)}`,
					`.dcs-dot{width:5px;height:5px;border-radius:999px;background:var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));flex:none}`,
					// ── 头 / 固定区 / 滚动区 / 固定底 ──
					`.dcs-head{display:flex;align-items:center;gap:8px;padding:9px 12px 9px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l2);flex:none}`,
					`.dcs-head-title{font:var(--dsw-font-xs-strong-13);flex:1}`,
					`.dcs-top{padding:10px 12px 0;flex:none}`,
					`.dcs-body{padding:6px 12px 6px;overflow-y:auto;overscroll-behavior:contain;flex:1;min-height:140px;scroll-padding-top:4px}`,
					`.dcs-row{display:flex;gap:6px}`,
					// 搜索框：macOS 浅填充底 + focus 光环
					`.dcs-input{flex:1;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xs-13);min-width:0;transition:box-shadow var(--dcs-fast) ease,border-color var(--dcs-fast) ease}`,
					`.dcs-input::placeholder{color:var(--dsw-alias-label-tertiary)}`,
					`.dcs-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 20%,transparent)}`,
					`.dcs-row-filters{margin-top:6px;align-items:center;gap:6px;flex-wrap:wrap}`,
					`.dcs-filters-label{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-tertiary);white-space:nowrap}`,
					// 分段控件：灰底槽 + 浮起白块 active（macOS segmented）
					`.dcs-seg{display:inline-flex;padding:2px;gap:2px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);flex:none;height:28px;box-sizing:border-box;align-items:center}`,
					`.dcs-seg-btn{height:22px;display:inline-flex;align-items:center;padding:0 12px;border-radius:6px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:background var(--dcs-fast) ease,color var(--dcs-fast) ease,box-shadow var(--dcs-fast) ease}`,
					`@media(hover:hover){.dcs-seg-btn:hover{color:var(--dsw-alias-label-primary)}}`,
					`.dcs-seg-btn[data-active="1"]{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08),0 0 0 0.5px var(--dsw-alias-border-l2)}`,
					`.dcs-select{height:28px;padding:0 8px;border-radius:var(--dsw-radius-xs);border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:var(--dsw-font-xxs-12);cursor:pointer}`,
					`.dcs-tip{margin-top:8px;padding:8px 10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);line-height:1.5}`,
					// 主按钮
					`.dcs-go{height:28px;padding:0 14px;border-radius:var(--dsw-radius-sm);border:0;background:var(--dsw-alias-brand-primary);color:#fff;cursor:pointer;font:var(--dsw-font-xs-13);font-weight:500;transition:filter var(--dcs-fast) ease,opacity var(--dcs-fast) ease}`,
					`@media(hover:hover){.dcs-go:hover{filter:brightness(1.08)}}`,
					`.dcs-go:active{filter:brightness(.94)}`,
					`.dcs-go:disabled{opacity:.45;cursor:default;filter:none}`,
					// ── 卡片网格 ──
					`.dcs-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}`,
`@media(max-width:640px){.dcs-grid{grid-template-columns:1fr}}`,
					// 长按看详情时不要让浏览器顺手选中卡名文字（移动端尤其明显）
					`.dcs-card{display:flex;flex-direction:row;align-items:flex-start;gap:8px;padding:8px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l2);background:transparent;cursor:pointer;text-align:left;color:inherit;font:inherit;min-width:0;transition:background var(--dcs-fast) ease,border-color var(--dcs-fast) ease;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none}`,
					`@media(hover:hover){.dcs-card:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}}`,
					`.dcs-card:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}`,
					`.dcs-card[data-busy="1"]{opacity:.55;pointer-events:none}`,
					`.dcs-av{width:64px;height:96px;border-radius:var(--dsw-radius-sm);object-fit:cover;object-position:center top;flex:none;background:var(--dsw-alias-interactive-bg-hover)}`,
					`.dcs-av-fb{width:64px;height:96px;border-radius:var(--dsw-radius-sm);flex:none;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xs-strong-13)}`,
					`.dcs-meta{min-width:0;flex:1;display:flex;flex-direction:column;gap:2px}`,
					`.dcs-name{display:flex;align-items:center;font-weight:600;overflow:hidden;min-width:0}`,
					// 卡名最多两行 —— 这是**免费**的：封面 96px 已定死卡片高度下限，
					// 文字用掉这部分竖向空间不会让卡片变高（实测 2 行名 + 副标 + 标签 ≈ 80px < 96px）。
					`.dcs-name-text{min-width:0;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;word-break:break-word;line-height:1.3}`,
					`.dcs-src{display:inline-flex;align-items:center;justify-content:center;min-width:16px;height:15px;padding:0 4px;border-radius:var(--dsw-radius-xs);font-size:9px;line-height:1;margin-right:5px;flex:none;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-weight:600}`,
					`.dcs-src[data-src="sichang"]{background:var(--dsw-alias-interactive-bg-hover-accent,var(--dsw-alias-interactive-bg-hover));color:var(--dsw-alias-brand-primary)}`,
					`.dcs-sub{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
					// 描述行：卡片上唯一说明「这卡讲什么」的文字。
					// 两行截断（文字列仅 156px）+ title 悬停看全；用 secondary 色（比 tagline 的
					// tertiary 更亮），因为它承载的是内容而非统计量。
					`.dcs-desc{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:1.4;word-break:break-word}`,
					`.dcs-sub2{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);line-height:1.4;word-break:break-word}`,
					`.dcs-left{display:flex;flex-direction:column;align-items:center;flex:none}`,
					`.dcs-card .dcs-card-act{width:44px;height:20px;padding:0;border-radius:var(--dsw-radius-xs);font-size:10px;line-height:1;justify-content:center;opacity:.85;white-space:nowrap}`,
					`.dcs-catrow{display:flex;gap:6px;overflow-x:auto;padding:0;margin-top:6px;scrollbar-width:thin;-webkit-overflow-scrolling:touch}`,
					`.dcs-chipcat{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:24px;padding:0 9px;box-sizing:border-box;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;line-height:1;cursor:pointer;white-space:nowrap;flex:none}`,
					`@media(hover:hover){.dcs-chipcat:hover{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}}`,
					`.dcs-chipcat[data-on="1"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-on-brand,#fff)}`,
					`.dcs-chipn{opacity:.6;font-size:9px}`,
					// 卡片上的「可触发 N」徽标。用品牌色描边而不是填充 —— 它是信息标注，
					// 不该比卡名更抢眼；小尺寸下只留数字也读得懂（title 里有完整解释）。
					`.dcs-dyn{display:inline-flex;align-items:center;flex:none;margin-left:5px;padding:0 5px;height:14px;border-radius:999px;border:0.5px solid var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);font-size:9px;line-height:1;white-space:nowrap;opacity:.9}`,
					`.dcs-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:2px}`,
					`.dcs-tag{padding:1px 6px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
					`.dcs-now{display:flex;align-items:center;gap:8px;padding:8px 10px;margin-bottom:8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover)}`,
					// ── 分页 / 底栏 ──
					`.dcs-pager{display:flex;align-items:center;justify-content:center;gap:2px;flex-wrap:wrap;padding-top:2px}`,
					`.dcs-page-btn{min-width:24px;height:24px;padding:0 7px;border-radius:var(--dsw-radius-xs);border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:background var(--dcs-fast) ease,color var(--dcs-fast) ease}`,
					`@media(hover:hover){.dcs-page-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}`,
					`.dcs-page-btn[data-active="1"]{background:var(--dsw-alias-brand-primary);color:#fff;font-weight:600}`,
					`.dcs-page-btn:disabled{opacity:.35;cursor:default}`,
					`.dcs-page-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}`,
					`.dcs-page-gap{color:var(--dsw-alias-label-tertiary);padding:0 2px}`,
					`.dcs-stat{display:flex;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-tertiary);font-size:10px}`,
					`.dcs-foot{padding:5px 12px 6px;border-top:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);display:flex;align-items:center;justify-content:center;flex:none}`,
					// 幽灵按钮：胶囊描边，hover 填充
					`.dcs-ghost{display:inline-flex;align-items:center;justify-content:center;height:24px;padding:0 10px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font:var(--dsw-font-xxs-12);transition:background var(--dcs-fast) ease,color var(--dcs-fast) ease,border-color var(--dcs-fast) ease}`,
					`@media(hover:hover){.dcs-ghost:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l4)}}`,
					`.dcs-ghost:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary))}`,
					`.dcs-ghost:disabled{opacity:.45;cursor:default}`,
`.dcs-page-btn,.dcs-ghost,.dcs-btn,.dcs-tab{position:relative}`,
`.dcs-page-btn::after,.dcs-ghost::after,.dcs-btn::after,.dcs-tab::after{content:"";position:absolute;left:0;right:0;top:50%;transform:translateY(-50%);height:44px;min-height:44px}`,
					`.dcs-err{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}`,
					`.dcs-confirm{margin-top:8px;padding:9px 10px;border-radius:var(--dsw-radius-sm);border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-interactive-bg-hover)}`,
					`.dcs-confirm p{margin:0 0 7px}`,
					`.dcs-status{display:flex;align-items:center;justify-content:center;min-height:120px;color:var(--dsw-alias-label-tertiary);font:var(--dsw-font-xxs-12)}`,
					`.dcs-spin{width:11px;height:11px;border-radius:999px;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-brand-primary);animation:dcs-sp .7s linear infinite;display:inline-block}`,
					`@keyframes dcs-sp{to{transform:rotate(360deg)}}`,
					// ── 详情浮层：同款毛玻璃 ──
					`.dcs-row-origin{margin-top:6px;align-items:center;gap:6px}`,
					`.dcs-seg-sm .dcs-seg-btn{padding:0 10px;font-size:12px}`,
					`.dcs-seg-btn:disabled{opacity:.4;cursor:not-allowed}`,
					`.dcs-sub-btn{padding:0;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;text-align:left;cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px}`,
					`@media(hover:hover){.dcs-sub-btn:hover{color:var(--dsw-alias-label-primary)}}`,
					`.dcs-sub-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}`,
					`.dcs-field-tall{max-height:340px}`,
					`.dcs-detail{position:fixed;z-index:16;width:min(520px,92vw);max-width:92vw;display:flex;flex-direction:column;background:var(--dsw-menu-surface-fill,var(--dsw-alias-bg-base));color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent);backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px));-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter,blur(20px));overflow:hidden;font:var(--dsw-font-xxs-12);animation:dcs-in var(--dcs-base) cubic-bezier(.32,.72,.35,1)}`,
					`.dcs-detail-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}`,
					// flex:1 + min-height:0 是「让滚动发生在容器内部」的必备两条：缺了子项按内容高度撑开，
// 浮层会被顶破（同一段文字露到框外、背景不覆盖）。主面板 .dcs-body 一直是这么写的。
`.dcs-detail-body{padding:10px 12px;overflow-y:auto;overscroll-behavior:contain;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0}`,
					`.dcs-field{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);overflow:hidden}`,
					`.dcs-field-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 8px;background:var(--dsw-alias-interactive-bg-hover);font-weight:600}`,
					`.dcs-field-body{margin:0;padding:8px;max-height:220px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:var(--dsw-font-xxs-12);line-height:1.5}`,
					`.dcs-field-empty{padding:8px;color:var(--dsw-alias-label-tertiary);font-style:italic}`,
					`.dcs-tabs{display:flex;gap:4px;flex-wrap:wrap;padding:8px 12px;border-bottom:0.5px solid var(--dsw-alias-border-l2)}`,
					`.dcs-vars{display:flex;flex-direction:column;gap:10px}`,
					`.dcs-vars-sec{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:8px 10px;display:flex;flex-direction:column;gap:7px}`,
					`.dcs-vars-sec-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-weight:600}`,
					`.dcs-vars-note{color:var(--dsw-alias-label-tertiary);font-weight:400;font-size:var(--dsw-font-xxxs-11-font-size);line-height:1.5}`,
					`.dcs-vars-item{display:flex;align-items:center;gap:8px}`,
					`.dcs-vars-name{flex:none;width:104px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xxs-12);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary)}`,
					`.dcs-vars-times{flex:none;color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxxs-11-font-size)}`,
					`.dcs-vars-badge{flex:none;padding:1px 7px;border-radius:999px;font-size:10px;line-height:16px;letter-spacing:.02em}`,
					`.dcs-vars-badge[data-state="filled"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary)) 16%,transparent);color:var(--dsw-alias-state-success-primary,var(--dsw-alias-brand-primary))}`,
					`.dcs-vars-badge[data-state="missing"]{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary)) 18%,transparent);color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}`,
					`.dcs-vars-foot{display:flex;align-items:center;justify-content:space-between;gap:8px}`,
					`.dcs-vars-status{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxxs-11-font-size);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}`,
					`.dcs-vars-empty{padding:6px 0;color:var(--dsw-alias-label-tertiary);font-style:italic}`,
					`.dcs-tab{height:22px;padding:0 9px;border-radius:var(--dsw-radius-sm);border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:var(--dsw-font-xxs-12);cursor:pointer;transition:background var(--dcs-fast) ease,color var(--dcs-fast) ease}`,
					`@media(hover:hover){.dcs-tab:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}}`,
					`.dcs-tab[data-active="1"]{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-border-l3));color:var(--dsw-alias-label-primary);font-weight:600}`,
					`.dcs-tab[data-empty="1"]{opacity:.4}`,
																																								`.dcs-qr-pane{display:flex;flex-direction:column;gap:10px}`,
					// 顶部那段「这是什么」：比正文小一号、浅一档，不抢眼但要读得到
					`.dcs-qr-intro{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-secondary);line-height:1.55;padding:8px 10px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-fill-tertiary,rgba(127,127,127,.08))}`,
					`.dcs-qr-sec-sub{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-tertiary);margin-top:-2px}`,
					`.dcs-qr-addhead{font:var(--dsw-font-xs-strong-13);color:var(--dsw-alias-label-primary)}`,
					`.dcs-qr-textarea{min-height:56px;resize:vertical;font:inherit;padding:6px 8px}`,
					`.dcs-qr-sec{display:flex;flex-direction:column;gap:4px}`,
					`.dcs-qr-sec-head{font:var(--dsw-font-xxs-12);color:var(--dsw-alias-label-tertiary)}`,
					`.dcs-qr-row{display:flex;align-items:center;gap:6px}`,
					`.dcs-qr-rowlabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--dsw-font-xs-13);color:var(--dsw-alias-label-primary)}`,
					`.dcs-qr-empty{padding:4px 0;color:var(--dsw-alias-label-tertiary);font-style:italic}`,
					`.dcs-qr-error{color:var(--dsw-alias-state-danger-primary,var(--dsw-alias-label-primary));font-size:var(--dsw-font-xxxs-11-font-size)}`,
					`.dcs-qr-add{display:flex;flex-direction:column;gap:6px}`,
					`.dcs-qr-addbtns{display:flex;gap:8px}`,
					`.dcs-qr-foot{font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-tertiary)}`,
					// ── H5（≤1023px，与 dsh-pocket 手机断点一致）：面板/详情浮层全屏 ──
					// 两个浮层都 portal 到 body 且带 inline 定位（panel 的 left/bottom/maxHeight、
					// detail 的 left/top/maxHeight）—— inline 是正常声明，!important 的 media
					// 规则压得过它（author-important > inline-normal）。窄屏不再锚到按钮旁：
					// 手机视口 492px 下放不下 520px 面板，右下角浮层一半在屏外。
					// z-index 提到 1300：对齐 h5-adapter 给 body 级浮层的口径（pocket 抽屉 1200）。
					// dvh 兜底 vh（iOS <16.4 不认 dvh 时退到 vh）。
					`@media(max-width:1023px){`,
					`.dcs-panel,.dcs-detail{left:0!important;right:0!important;top:0!important;bottom:0!important;width:100vw!important;max-width:none!important;height:100vh;height:100dvh!important;max-height:100dvh!important;border-radius:0!important;transform-origin:center;z-index:1300!important}`,
					`.dcs-panel{padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}`,
					`.dcs-now{flex-wrap:wrap;row-gap:4px}`,
					`.dcs-row-filters{flex-wrap:wrap;row-gap:4px}`,
					`.dcs-detail-head .dcs-sub{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
					`.dcs-detail-head .dcs-head-title{flex:none;max-width:38vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}`,
					`}`,
				].join("");
				document.head.appendChild(el);
				return () => {
					try {
						el.remove();
					} catch {
						/* 已被移除 */
					}
				};
			}

			/* ── 数据面 ── */
			/**
			 * 带超时的请求。
			 *
			 * **必须**有超时：doSearch 开头有个 inFlight 闸（防重复请求），闸门只在请求
			 * 结束（含异常）时才放开。没有超时的话，一次挂住的 fetch 会让这个闸永远关着，
			 * 之后每一次搜索都被直接 return 掉 —— 界面就永远停在「搜索中…」。
			 * 首次搜索可能撞上后台载入索引，所以给它更长的预算。
			 */
			const REQUEST_TIMEOUT_MS = 20000;
			const SEARCH_TIMEOUT_MS = 60000;
			async function apiFetch(path, init, timeoutMs) {
				const ctl = typeof AbortController === "function" ? new AbortController() : null;
				const timer = ctl === null ? null : setTimeout(() => ctl.abort(), timeoutMs ?? REQUEST_TIMEOUT_MS);
				try {
					const res = await fetch(`${BASE}${path}`, ctl === null ? init : { ...init, signal: ctl.signal });
					const json = await res.json().catch(() => ({}));
					if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
					if (json?.ok === false) throw new Error(json?.error ?? "request failed");
					return json;
				} catch (e) {
					// abort 的原生文案是 "The operation was aborted"，对用户没有意义
					if (e?.name === "AbortError") throw new Error(t("reqTimeout"));
					throw e;
				} finally {
					if (timer !== null) clearTimeout(timer);
				}
			}
			async function apiGet(path, timeoutMs) {
				return apiFetch(path, { headers: { Accept: "application/json" } }, timeoutMs);
			}
			async function apiPost(path, body, timeoutMs) {
				const json = await apiFetch(
					path,
					{
						method: "POST",
						headers: { "Content-Type": "application/json", Accept: "application/json" },
						body: JSON.stringify(body ?? {}),
					},
					timeoutMs,
				);
				return json;
			}
			/**
			 * dsh-memory 的卡片记忆删除路由（不走本插件的 BASE —— 这是跨插件路由）。
			 * 需要头 x-dsh-memory: 1（dsh-memory 的写操作 CSRF 防线，浏览器侧必须显式带）。
			 */
			async function apiMemoryDeleteCard(slug) {
				const res = await fetch("/dsh-memory/cards/delete", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "application/json",
						"x-dsh-memory": "1",
					},
					body: JSON.stringify({ slug }),
				});
				const json = await res.json().catch(() => ({}));
				if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
				if (json?.ok === false) throw new Error(json?.error ?? "request failed");
				return json;
			}

			/**
			 * 头像必须写成**组件**（大写开头），不能用普通函数返回元素 ——
			 * 普通函数里调 useState 违反 hooks 规则（在 map 里调用会直接崩）。
			 * 组件内自己有 broken 状态，挂掉就回退首字圆形，不留空洞。
			 */
			function CardAvatar(props) {
				const [broken, setBroken] = React.useState(false);
				const card = props.card;
				const src = card.avatarUrl;
				if (src && !broken) {
					return h("img", {
						className: "dcs-av",
						src,
						// alt 用卡名：图片挂掉时有无障碍替代文本，也便于排查
						alt: card.name || card.slug || "",
						title: card.name || "",
						loading: "lazy",
						onError: () => setBroken(true),
					});
				}
				const ch = String(card.name ?? "?").trim().slice(0, 1) || "?";
				return h("div", { className: "dcs-av-fb", title: card.name ?? "" }, ch);
			}

			// 常驻宿主（渲染 null）：持有面板/详情浮层的状态与 portal。入口按钮已迁到
			// 工具箱菜单行（SummonRow，注册在 dsh-toolbox.menu），经 panelRequests 信号打开面板。
			function SummonHost(props) {
				const sessionId = props.sessionId ?? props.session?.id;
				// phase: closed → open →（关闭时）closing → closed；closing 期间播退场动效
				const [phase, setPhase] = React.useState("closed");
				const [current, setCurrent] = React.useState(null);
				const [pos, setPos] = React.useState(null);
				const closeTimer = React.useRef(null);
				const t = typeof props.t === "function" ? props.t : (k) => k;

				const [query, setQuery] = React.useState("");
				const [items, setItems] = React.useState([]);
				const [busy, setBusy] = React.useState(false);
				const [summoning, setSummoning] = React.useState("");
				const [error, setError] = React.useState("");
				const [confirm, setConfirm] = React.useState(null);
				// 卡片记忆清除：busy 标志 + 一次性成功文案（两秒后自动消失）。
				const [clearing, setClearing] = React.useState(false);
				const [clearMsg, setClearMsg] = React.useState("");
				const [searched, setSearched] = React.useState(false);
				// 分页：host /search 返回 count / page / cursor / previousCursor / items
				// （**没有** hasMore —— 那是 card_search 工具里现算的，别照抄）。
				// 因此「还有下一页」只能靠：本页条数 < 请求条数（最后一页）或 items.length >= total。
				const [page, setPage] = React.useState(1);
				const [total, setTotal] = React.useState(null);
				const [totalPages, setTotalPages] = React.useState(1);
				// host 报的「还有下一页」—— 以服务端实际返回为准，不用条数推算
				const [apiHasMore, setApiHasMore] = React.useState(false);
				// Chub 深页回吐的重复条目数（去重后告知用户）
				const [duplicatesRemoved, setDuplicatesRemoved] = React.useState(0);
				// 详情浮层：{ card, data, loading, error, tab }
				const [detail, setDetail] = React.useState(null);
				// 本会话的召唤状态。面板打开时由 refresh() 维护；顶部的「解除召唤」/⚙ 与详情里的召唤判定都看它。
				// 快捷按钮的忙碌位 —— 表本身随详情一起拉（见 openQr），这里只管「正在发/正在存」的禁用态。
				const [qrBusy, setQrBusy] = React.useState("");
				// 数据源：sichang（中文原生）/ chub / all。默认 all —— 中文站 84 张太少，不宜独占默认。
				// 去掉「全部」后默认落在「自定义」：这是用户的主用法，
// 且分类筛选器只在自定义源下出现，默认它才一眼看到筛选入口。
const [source, setSource] = React.useState("local");
				// 语言过滤：仅对 Chub 生效（中文站本身就是中文）。"" = 不限。
				const [langId, setLangId] = React.useState("");
				const [localFacets, setLocalFacets] = React.useState(null);
				// 选中的分类（多选）。之前精简 UI 时连同筛选区一起删了 state，
				// 但分类筛选回来后又需要它 —— 缺了会直接 ReferenceError（实测踩到）。
				const [localCats, setLocalCats] = React.useState([]);
				// 取数来源偏好（本地磁盘 / GitHub）。null = 还没拉到（此时不渲染切换器）
				const [preferredOrigin, setPreferredOrigin] = React.useState("remote");
				const [originInfo, setOriginInfo] = React.useState(null);
				const [scanning, setScanning] = React.useState(false);
				// 上一次追加拿到空数组（到底了）—— 用于封住「满页但已无更多」的死循环
				const [exhausted, setExhausted] = React.useState(false);
				// 卡片长按的定时器可能在卸载（滚动出视口）时还挂着，别让它对已消失的卡开详情。
				React.useEffect(
					() => () => {
						if (longPressTimer.current !== null) clearTimeout(longPressTimer.current);
					},
					[],
				);

				// 在途守卫：按钮 disabled 挡不住 Enter 与点击同帧，入口必须自己幂等。
				const inFlight = React.useRef(false);
				// 移动端没有右键：卡片长按 = 看详情。这两个 ref 配合使用 ——
				// 长按真触发时置 suppressClick，由**紧随其后的 onClick 自己消费并清除**
				// （touchend 之后浏览器才补发 click，若在 touchend 里清就等于没拦）。
				const longPressTimer = React.useRef(null);
				const suppressClick = React.useRef(false);
				const lastLongPressAt = React.useRef(0);

				const PAGE_SIZE = 24;
				/** 移动端长按判定阈值（与浏览器原生 contextmenu 的观感一致）。 */
				const LONG_PRESS_MS = 500;
				/** 长按之后多久内补发的 click 一律当作误触吞掉。 */
				const LONG_PRESS_SUPPRESS_MS = 900;

				const refresh = React.useCallback(() => {
					apiGet(`/status?sessionId=${encodeURIComponent(sessionId ?? "")}`)
						.then((d) => setCurrent(d.summon ?? null))
						.catch(() => {
							/* host 未就绪时保持原状 */
						});
				}, [sessionId]);

				// 轮询只在面板打开时跑，关闭即停
				React.useEffect(() => {
					if (phase === "closed") return undefined;
					refresh();
					const timer = setInterval(refresh, 4000);
					return () => clearInterval(timer);
				}, [phase, refresh]);

				React.useEffect(() => () => clearTimeout(closeTimer.current), []);

				const openPanel = (at) => {
					clearTimeout(closeTimer.current);
					{
						const GAP = 8;
						const EDGE = 8;
						const left = at && Number.isFinite(at.left) ? at.left : window.innerWidth - (PANEL_W + PANEL_EDGE);
						const top = at && Number.isFinite(at.top) ? at.top : window.innerHeight - 120;
						setPos({
							// 面板左缘对齐菜单行左缘（工具箱菜单行传来的锚点），不再向左偏移面板宽
							left: Math.max(EDGE, Math.min(left, window.innerWidth - (PANEL_W + PANEL_EDGE))),
							bottom: Math.max(EDGE, window.innerHeight - top + GAP),
							maxHeight: Math.min(560, Math.max(200, top - GAP - EDGE)),
						});
					}
					setPhase("open");
					// 每次打开都同步一次来源偏好（可能被其它标签页/会话改过）
					void (async () => {
						try {
							const info = await apiGet("/origin");
							setOriginInfo(info);
							if (info?.origin === "local" || info?.origin === "remote") setPreferredOrigin(info.origin);
						} catch {
							/* 拉不到就不渲染切换器，不影响其它功能 */
						}
					})();
					// 首次打开自动拉一次热门，面板不至于是空的
					if (!searched) void doSearch("");
				};
				const closePanel = () => {
					if (phase !== "open") return;
					setPhase("closing");
					closeTimer.current = setTimeout(() => setPhase("closed"), 120);
				};
				// 工具箱菜单行请求打开面板：经 ref 转发到最新闭包（避免首帧闭包读到陈旧 searched）
				const openPanelRef = React.useRef(openPanel);
				React.useEffect(() => { openPanelRef.current = openPanel; });
				React.useEffect(() => panelRequests.on((at) => openPanelRef.current(at)), []);

				// Esc 关闭 + 点外关闭（只在打开期间挂监听）
				React.useEffect(() => {
					if (phase !== "open") return undefined;
					const onKey = (e) => {
						if (e.key === "Escape") closePanel();
					};
					window.addEventListener("keydown", onKey);
					return () => window.removeEventListener("keydown", onKey);
				});

				/**
				 * 取数。
				 *   mode="goto"     跳到指定页（**替换**列表）—— 数字分页用
				 *   mode="append"   把第 pageNo 页接到列表尾部 —— 「加载更多」用
				 * 入口自带在途幂等：同一时刻只允许一个请求（按钮 disabled 挡不住 Enter 与点击同帧）。
				 */
				async function doSearch(q, pageNo = 1, mode = "goto", opt = {}) {
					if (inFlight.current) return;
					inFlight.current = true;
					// 数据源/语言在 onChange 里 setState 后立刻调用本函数 —— state 还没落地，
					// 闭包里读到的仍是旧值，所以新值必须由调用方显式传入。
					const src = opt.source !== undefined ? opt.source : source;
					const lang = opt.langId !== undefined ? opt.langId : langId;
					// 来源偏好同理：onChange 里 setState 后立刻调用，闭包还是旧值，必须显式传入
					const org = opt.origin !== undefined ? opt.origin : preferredOrigin;
					// 分类筛选同理：setState 后立刻请求，闭包里还是旧值，必须显式传入
					const cats = opt.localCats !== undefined ? opt.localCats : localCats;
					const append = mode === "append";
					setBusy(true);
					if (!append) setError("");
					try {
						const langQ = lang === "" ? "" : `&langId=${encodeURIComponent(lang)}`;
						const d = await apiGet(
							`/search?q=${encodeURIComponent(q ?? "")}&pageSize=${PAGE_SIZE}&page=${pageNo}` +
								`&source=${encodeURIComponent(src)}${langQ}&origin=${encodeURIComponent(org)}` +
								(cats.length > 0 ? cats.map((c) => `&category=${encodeURIComponent(c)}`).join("") : ""),
							SEARCH_TIMEOUT_MS
						);
						// 本地源回传 facets：面板据此判断「有没有索引」并渲染分类多选
						if (d.localFacets !== undefined) setLocalFacets(d.localFacets);
						const next = Array.isArray(d.items) ? d.items : [];
						setItems((prev) => {
							if (!append) return next;
							// Chub 深页会回吐重复条目（实测 first=10 时 page=10~15 重复 4/2/1/0/2/1 条），
							// 所以追加必须按 fullPath 去重
							const seen = new Set(prev.map((x) => x.fullPath));
							return [...prev, ...next.filter((x) => !seen.has(x.fullPath))];
						});
						setTotal(Number.isFinite(Number(d.total)) ? Number(d.total) : null);
						setTotalPages(Number.isFinite(Number(d.totalPages)) ? Number(d.totalPages) : 1);
						setApiHasMore(d.hasMore === true);
						setDuplicatesRemoved(Number(d.duplicatesRemoved) || 0);
						setPage(pageNo);
						setSearched(true);
					} catch (e) {
						setError(String(e?.message ?? e));
						if (!append) {
							setItems([]);
							setTotal(null);
						}
					} finally {
						setBusy(false);
						inFlight.current = false;
					}
				}

				/** 新搜索：重置到第 1 页（替换列表）。 */
				function newSearch(q) {
					setPage(1);
					void doSearch(q, 1, "goto");
				}

				/** 跳到指定页（数字分页）。 */
				function gotoPage(n) {
					const target = Math.max(1, Math.min(Number(n) || 1, totalPages));
					if (target === page && items.length > 0) return;
					void doSearch(query, target, "goto");
				}

				/**
				 * 还能不能翻下一页。host /search **不返回 hasMore**（那是 card_search 工具里现算的），
				 * 只能靠下面三条判据，任一成立即到底：
				 *   1) exhausted —— 上一次追加拿到了空数组。**这条是必需的**：
				 *      Chub 超出总页数时返回空数组且 count 不变（实测 page=999 → 0 条 / count 仍 556），
				 *      若只靠「上一批满页」判断，点空页后按钮会一直显示、page 还会越点越远。
				 *   2) 上一批不足 PAGE_SIZE —— 已到最后一页。
				 *   3) 已加载 >= 总数 count（同源口径，实测 count=556 / first=24 → 24 页）。
				 */
				const lastBatchFull = items.length > 0 && items.length % PAGE_SIZE === 0;
				const canLoadMore =
					!busy &&
					!exhausted &&
					items.length > 0 &&
					lastBatchFull &&
					(total === null || items.length < total);

				async function doSummon(card, force) {
					setSummoning(card.fullPath);
					setError("");
					try {
						const d = await apiPost("/summon", { sessionId, fullPath: card.fullPath, confirm: force === true });
						if (d.needConfirm === true) {
							setConfirm({ card, why: d.why, hits: d.hits });
							setDetail(null); // 确认框画在面板里，先关掉详情浮层让它露出来
							return;
						}
						setConfirm(null);
						setDetail(null);
						setCurrent({ fullPath: card.fullPath, name: d.name ?? card.name, chars: d.injectedChars });
					} catch (e) {
						setError(String(e?.message ?? e));
					} finally {
						setSummoning("");
					}
				}

				/** 打开详情浮层：拉完整提示词原文（走 /detail，JSON 不经过宿主插值）。 */
				/**
				 * 打开「当前注入原文」浮层。
				 * 与 openDetail 的区别：detail 给的是卡的提示词字段，这条给的是
				 * **渲染后真正塞进系统提示的整段文本**（用户点「N 注入字符」想看的就是它）。
				 */
				async function openSection() {
					setDetail({ kind: "section", card: current, data: null, loading: true, error: "", tab: "section" });
					try {
						const d = await apiGet(`/section?sessionId=${encodeURIComponent(sessionId ?? "")}`);
						setDetail((prev) => (prev === null ? prev : { ...prev, data: d, loading: false }));
					} catch (e) {
						setDetail((prev) => (prev === null ? prev : { ...prev, loading: false, error: String(e?.message ?? e) }));
					}
				}

				async function openDetail(card) {
					setDetail({ kind: "card", card, data: null, loading: true, error: "", tab: "personality" });
					try {
						const d = await apiGet(`/detail?fullPath=${encodeURIComponent(card.fullPath)}`);
						setDetail((prev) => (prev === null ? prev : { ...prev, data: d, loading: false }));
					} catch (e) {
						setDetail((prev) => (prev === null ? prev : { ...prev, loading: false, error: String(e?.message ?? e) }));
					}
				}

				/**
				 * 这张卡此刻在本会话里被召唤了吗。
				 *
				 * /status?sessionId=… 带 sessionId 时返回的是**单条**召唤记录（getSummon），
				 * 阵容时 fullPath 是逗号拼的一串 —— 所以拆开比对，不做整串相等。
				 * 「按钮」页只在召唤了这张卡时才有意义：那条 chip 条同理。
				 */
				const summonedHere = React.useCallback(
					(card) => {
						const cur = current?.fullPath;
						if (typeof cur !== "string" || cur.length === 0) return false;
						const fp = String(card?.fullPath ?? "");
						return fp.length > 0 && cur.split(",").includes(fp);
					},
					[current],
				);

				/* ── 快捷按钮 Tab ─────────────────────────────────────────────
				* 数据来自 GET /qr，增删改走 POST /qr；投递走 POST /qr/send —— 那条路由在 host 侧
				* 经 agent.followup() 落成一条真正的用户消息，所以点一下按钮就真的能触发模型。
				* 卡级与全局分两个作用域列出，与 chip 条的可见范围一致。
				*/
				async function openQr(card) {
					// 与 openVars 的差别：这里**重开**整个详情（kind=card），因为它可能从 chip 条直接进来，
					// 那时 detail 里什么都没有。顺带把 /detail 也拉了 —— 用户切回字段 tab 时不该是空的。
					// 未召唤这张卡就没有「按钮」这一页 —— 回退到人设，而不是开一个空壳。
					const tab = summonedHere(card) ? QR_TAB : "人设";
					setDetail({ kind: "card", card, data: null, loading: true, error: "", tab });
					try {
						const [detailData, qrData] = await Promise.all([
							apiGet(`/detail?fullPath=${encodeURIComponent(card.fullPath)}`),
							apiGet(`/qr?fullPath=${encodeURIComponent(card.fullPath)}`),
						]);
						setDetail((prev) => (prev === null ? prev : { ...prev, data: detailData, qr: qrData, loading: false }));
					} catch (e) {
						setDetail((prev) => (prev === null ? prev : { ...prev, loading: false, error: String(e?.message ?? e) }));
					}
				}

				/** 增删改：一律写盘后重拉 —— 归一化（label 截取、id 补全）发生在服务端，回显必须以盘为准。 */
				async function qrMutate(card, payload) {
					setDetail((prev) => (prev === null ? prev : { ...prev, qrSaving: true, qrError: "" }));
					try {
						await apiPost("/qr", { fullPath: card.fullPath, ...payload });
						const d = await apiGet(`/qr?fullPath=${encodeURIComponent(card.fullPath)}`);
						setDetail((prev) => (prev === null ? prev : { ...prev, qr: d, qrSaving: false, qrDraftText: "", qrDraftLabel: "" }));
					} catch (e) {
						setDetail((prev) => (prev === null ? prev : { ...prev, qrSaving: false, qrError: String(e?.message ?? e) }));
					}
				}

				/** chip 条与管理面板共用的投递入口。 */
				async function sendQuickReply(item) {
					setQrBusy(String(item.id ?? ""));
									try {
						const d = await apiPost("/qr/send", { sessionId, text: item.text });
										} catch (e) {
										} finally {
						setQrBusy("");
					}
								}

				function renderQrPane(d) {
					const data = d.qr ?? {};
					const globalList = Array.isArray(data.global) ? data.global : [];
					const cardList = Array.isArray(data.card) ? data.card : [];
					const draftText = String(d.qrDraftText ?? "");
					const draftLabel = String(d.qrDraftLabel ?? "");
					const canAdd = draftText.trim().length > 0 && d.qrSaving !== true;
					const set = (patch) => setDetail((prev) => (prev === null ? prev : { ...prev, ...patch }));
					const row = (it, scope) =>
						h(
							"div",
							{ className: "dcs-qr-row", key: `${scope}:${it.id}` },
							h("span", { className: "dcs-qr-rowlabel", title: it.text }, it.label),
							h(
								"button",
								{ className: "dcs-ghost", disabled: qrBusy !== "", onClick: () => void sendQuickReply(it) },
								t("qrSend"),
							),
							h(
								"button",
								{ className: "dcs-ghost", title: t("qrDelete"), onClick: () => void qrMutate(d.card, { action: "remove", scope, id: it.id }) },
								"×",
							),
						);
					const section = (title, sub, list, scope) =>
						h(
							"div",
							{ className: "dcs-qr-sec" },
							h("div", { className: "dcs-qr-sec-head" }, `${title}（${list.length}）`),
							// 一句话说清这个区管什么 —— 用户没用过酒馆，不能只甩「全局」这种行话
							h("div", { className: "dcs-qr-sec-sub" }, sub),
							list.length === 0 ? h("div", { className: "dcs-qr-empty" }, t("qrEmpty")) : list.map((it) => row(it, scope)),
						);
					return h(
						"div",
						{ className: "dcs-qr-pane" },
						d.qrError ? h("div", { className: "dcs-qr-error" }, d.qrError) : null,
						// 第一次打开的人得先知道这是干什么的
						h("div", { className: "dcs-qr-intro" }, t("qrIntro")),
						section(t("qrScopeCard"), t("qrCardSub"), cardList, "card"),
						section(t("qrScopeGlobal"), t("qrGlobalSub"), globalList, "global"),
						h(
							"div",
							{ className: "dcs-qr-add" },
							h("div", { className: "dcs-qr-addhead" }, t("qrAddHead")),
							h("textarea", {
								className: "dcs-input dcs-qr-textarea",
								placeholder: t("qrNewText"),
								value: draftText,
								rows: 2,
								onChange: (e) => set({ qrDraftText: e.target.value }),
							}),
							h("input", {
								className: "dcs-input",
								placeholder: t("qrNewLabel"),
								value: draftLabel,
								onChange: (e) => set({ qrDraftLabel: e.target.value }),
							}),
							h(
								"div",
								{ className: "dcs-qr-addbtns" },
								h(
									"button",
									{ className: "dcs-btn", disabled: !canAdd, onClick: () => void qrMutate(d.card, { action: "add", scope: "card", text: draftText, label: draftLabel }) },
									t("qrAddCard"),
								),
								h(
									"button",
									{ className: "dcs-btn", disabled: !canAdd, onClick: () => void qrMutate(d.card, { action: "add", scope: "global", text: draftText, label: draftLabel }) },
									t("qrAddGlobal"),
								),
							),
							),
						h("div", { className: "dcs-qr-foot" }, t("qrLimit")),
					);
				}

				/* ── 变量 Tab ─────────────────────────────────────────────
				* 数据来自 GET /vars —— 它回的是**卡原文里的宏**，不是注入段。
				* 拿注入段当数据源只会得到空清单：那里的 {{user}} 早被换掉了。
				*/
				async function openVars(card) {
					setDetail((prev) => (prev === null ? prev : { ...prev, tab: VARS_TAB, varsLoading: true, varsError: "", varsSaved: "" }));
					try {
						const d = await apiGet(`/vars?fullPath=${encodeURIComponent(card.fullPath)}`);
						const custom = Array.isArray(d?.extracted?.custom) ? d.extracted.custom : [];
						setDetail((prev) =>
							prev === null
								? prev
								: {
										...prev,
										vars: d,
										varsLoading: false,
										varsDraft: {
											user: String(d?.global?.user ?? ""),
											char: String(d?.global?.char ?? ""),
											...Object.fromEntries(custom.map((c) => [c.name, String(c.value ?? "")])),
										},
									},
						);
					} catch (e) {
						setDetail((prev) => (prev === null ? prev : { ...prev, varsLoading: false, varsError: String(e?.message ?? e) }));
					}
				}

				/** 保存：全局与卡级分两次 POST —— 路由按 scope 分流，一次请求只能带一个 scope。 */
				async function saveVars(card) {
					const draft = detail?.varsDraft ?? {};
					const custom = Array.isArray(detail?.vars?.extracted?.custom) ? detail.vars.extracted.custom : [];
					setDetail((prev) => (prev === null ? prev : { ...prev, varsSaving: true, varsError: "", varsSaved: "" }));
					try {
						await apiPost("/vars", {
							scope: "global",
							entries: [
								{ name: "user", value: String(draft.user ?? "") },
								{ name: "char", value: String(draft.char ?? "") },
							],
						});
						if (custom.length > 0) {
							await apiPost("/vars", {
								scope: "card",
								fullPath: card.fullPath,
								entries: custom.map((c) => ({ name: c.name, value: String(draft[c.name] ?? "") })),
							});
						}
						// 存完重拉：空串在后端等于「删掉这个变量」，回显必须以盘上为准，别拿本地 draft 自欺。
						const d = await apiGet(`/vars?fullPath=${encodeURIComponent(card.fullPath)}`);
						setDetail((prev) => (prev === null ? prev : { ...prev, vars: d, varsSaving: false, varsSaved: t("varsSaved") }));
						refresh();
					} catch (e) {
						setDetail((prev) => (prev === null ? prev : { ...prev, varsSaving: false, varsError: String(e?.message ?? e) }));
					}
				}

				/**
				* 变量面板：上半全局，下半这张卡的自定义变量。
				* 每行标 ×N —— 用户决定填不填时，「出现 20 次」和「出现 1 次」是两件事。
				*/
				function renderVarsPane(d) {
					if (d.varsError) return h("div", { className: "dcs-err" }, d.varsError);
					if (d.varsLoading === true || d.vars === undefined) {
						return h("div", { className: "dcs-status" }, h("span", { className: "dcs-spin" }), " " + t("varsLoading"));
					}
					const ex = d.vars?.extracted ?? {};
					const draft = d.varsDraft ?? {};
					const custom = Array.isArray(ex.custom) ? ex.custom : [];
					const known = Array.isArray(ex.known) ? ex.known : [];
					const builtin = Array.isArray(ex.builtin) ? ex.builtin : [];
					const countOf = (n) => {
						const hit = builtin.find((b) => String(b.name ?? "").toLowerCase() === n);
						return hit ? Number(hit.count) || 0 : 0;
					};
					const setDraft = (name, value) =>
						setDetail((prev) => (prev === null ? prev : { ...prev, varsDraft: { ...(prev.varsDraft ?? {}), [name]: value }, varsSaved: "" }));
					const filled = (name) => String(draft[name] ?? "").trim().length > 0;
					const row = (name, label, hint, count) =>
						h(
							"div",
							{ className: "dcs-vars-item", key: name },
							h("span", { className: "dcs-vars-name", title: name }, label),
							h("input", {
								className: "dcs-input",
								type: "text",
								value: String(draft[name] ?? ""),
								placeholder: hint,
								"aria-label": name,
								onChange: (e) => setDraft(name, e.target.value),
							}),
							count > 1 ? h("span", { className: "dcs-vars-times" }, `×${count}`) : null,
							h(
								"span",
								{ className: "dcs-vars-badge", "data-state": filled(name) ? "filled" : "missing" },
								filled(name) ? t("varsFilled") : t("varsMissing"),
							),
						);
					const pending = custom.filter((c) => !filled(c.name)).length;
					return h(
						"div",
						{ className: "dcs-vars" },
						h(
							"div",
							{ className: "dcs-vars-sec" },
							h(
								"div",
								{ className: "dcs-vars-sec-head" },
								h("span", null, t("varsGlobalTitle")),
								h("span", { className: "dcs-vars-note" }, t("varsGlobalNote")),
							),
							row("user", "{{user}}", t("varsUserHint"), countOf("user")),
							row("char", "{{char}}", t("varsCharHint"), countOf("char")),
						),
						h(
							"div",
							{ className: "dcs-vars-sec" },
							h(
								"div",
								{ className: "dcs-vars-sec-head" },
								h("span", null, t("varsCardTitle")),
								custom.length > 0 ? h("span", { className: "dcs-vars-note" }, `${pending} / ${custom.length} ${t("varsMissing")}`) : null,
							),
							custom.length === 0
								? h("div", { className: "dcs-vars-empty" }, t("varsNoMacro"))
								: custom.map((c) => row(c.name, `{{${c.name}}}`, "", Number(c.count) || 0)),
						),
						known.length > 0 ? h("div", { className: "dcs-vars-note" }, t("varsKnown").replace("{n}", String(known.length))) : null,
						builtin.length > 0
							? h(
									"div",
									{ className: "dcs-vars-note" },
									t("varsBuiltinNote").replace("{list}", builtin.map((b) => `{{${b.name}}} ×${b.count}`).join("、")),
								)
							: null,
						h("div", { className: "dcs-tip" }, t("varsHint")),
						h(
							"div",
							{ className: "dcs-vars-foot" },
							h(
								"span",
								{ className: "dcs-vars-status", title: String(d.vars?.file ?? "") },
								d.varsSaved || `${t("varsFile")}：${String(d.vars?.file ?? "")}`,
							),
							h(
								"button",
								{ className: "dcs-go", disabled: d.varsSaving === true, onClick: () => void saveVars(d.card) },
								d.varsSaving === true ? t("varsSaving") : t("varsSave"),
							),
						),
					);
				}

				async function doUnsummon() {
					setError("");
					try {
						await apiPost("/unsummon", { sessionId });
						setCurrent(null);
						setConfirm(null);
					} catch (e) {
						setError(String(e?.message ?? e));
					}
				}

				/**
				 * 清除当前召唤卡的卡片记忆（~/.dsh/memory/cards/<slug>.md，dsh-memory 的路由）。
				 * 只对单卡召唤显示：阵容（fullPath 是逗号串）没有单卡记忆。
				 * slug 派生规则与 dsh-memory 端的 cardSlugOf 一致（两侧同构，改动要同步）。
				 */
				async function doClearCardMemory() {
					const fp = String(current?.fullPath ?? "");
					if (fp.length === 0 || fp.includes(",")) return;
					const slug = fp.replace(/[^A-Za-z0-9_-]/g, "_");
					if (!window.confirm?.(t("clearCardMemoryConfirm"))) return;
					setClearing(true);
					setError("");
					try {
						await apiMemoryDeleteCard(slug);
						setClearMsg(t("clearCardMemoryDone"));
						setTimeout(() => setClearMsg(""), 2500);
					} catch (e) {
						if (String(e?.message ?? e).includes("no such card memory")) {
							setClearMsg(t("clearCardMemoryNone"));
							setTimeout(() => setClearMsg(""), 2500);
						} else {
							setError(`${t("clearCardMemoryFail")}：${String(e?.message ?? e)}`);
						}
					} finally {
						setClearing(false);
					}
				}

				const panel =
					phase === "closed"
						? null
						: ReactDOM.createPortal(
								h(
									"div",
									{
										className: "dcs-panel",
										"data-closing": phase === "closing" ? "1" : "0",
										style: pos
											? { left: pos.left, bottom: pos.bottom, maxHeight: pos.maxHeight }
											: { right: 8, bottom: 8, maxHeight: 400 },
										role: "dialog",
										"aria-label": t("title"),
									},
									h(
										"div",
										{ className: "dcs-head" },
										h("span", { className: "dcs-head-title" }, t("title")),
										h("button", { className: "dcs-ghost", onClick: closePanel, "aria-label": "close" }, "✕"),
									),
									h(
										"div",
										{ className: "dcs-top" },
										// 当前召唤
										current
											? h(
													"div",
													{ className: "dcs-now" },
													h("span", { className: "dcs-dot" }),
													h(
														"span",
														{ className: "dcs-meta" },
														h("span", { className: "dcs-name" }, current.name ?? current.fullPath),
														// 点这行状态文字 = 看当前注入原文。
														// 刻意**不加新按钮** —— 面板宽度有限，且用户上一轮刚要求精简 UI，
														// 所以把入口挂在既有文字上（有 title 提示可点）。
														h(
															"button",
															{
																className: "dcs-sub dcs-sub-btn",
																title: t("viewInjected"),
																onClick: () => void openSection(),
															},
															`${t("summoned")}${current.chars ? ` · ${current.chars} ${t("chars")}` : ""}`,
														),
													),
													h("button", { className: "dcs-ghost", onClick: doUnsummon }, t("unsummon")),
												// 卡片记忆清除 —— 单卡召唤才有；阵容会话按钮禁用并说明原因。
												// slug 由 fullPath 派生，与 dsh-memory 端同名规则保持同构。
												(() => {
													const fp = String(current?.fullPath ?? "");
													const single = fp.length > 0 && !fp.includes(",");
													return h(
														"button",
														{
															className: "dcs-ghost",
															disabled: !single || clearing === true,
															title: single
																? t("clearCardMemoryConfirm")
																: t("clearCardMemoryCast"),
															onClick: () => void doClearCardMemory(),
														},
														clearing === true ? "…" : clearMsg !== "" ? clearMsg : t("clearCardMemory"),
													);
												})(),
													// 快捷按钮的管理入口 —— 只有召唤了卡才需要（要发给这张卡）。
													// 早先它在输入框右侧有一条 chip，用户明确要撤掉对话框里那块，
													// 于是挪到面板顶部、和「解除召唤」并排。
													h(
														"button",
														{
															className: "dcs-ghost",
															title: t("qrSettings"),
															"aria-label": t("qrSettings"),
															onClick: () => void openQr(current),
														},
														"⚙",
													),
												)
											: h("div", { className: "dcs-sub" }, t("none")),
										// 搜索行
										h(
											"div",
											{ className: "dcs-row" },
											h("input", {
												className: "dcs-input",
												placeholder: t("searchPlaceholder"),
												value: query,
												onChange: (e) => setQuery(e.target.value),
												onKeyDown: (e) => {
													if (e.key === "Enter") newSearch(query);
												},
											}),
											h("button", { className: "dcs-go", disabled: busy, onClick: () => newSearch(query) }, t("search")),
										),
										// 数据源（分段切换）/ 语言（改后立即重新搜索）
										h(
											"div",
											{ className: "dcs-row dcs-row-filters" },
											h("span", { className: "dcs-filters-label" }, t("sourceLabel")),
											h(
												"div",
												{ className: "dcs-seg", role: "group" },
												...[
													// 去掉「全部」：用户明确「不需要全部这个选项」。
													// 代价：「全部」原本是一次看多源；现在默认落在「中文站」，
													// 想要跨源就逐一切换。默认值也一并改（见 source 初值）。
													["sichang", t("srcSichang")],
													["chub", t("srcChub")],
													["local", t("srcLocal")],
												].map(([v, label]) =>
													h(
														"button",
														{
															key: v,
															className: "dcs-seg-btn",
															"data-active": source === v ? "1" : "0",
															onClick: () => {
																if (v === source) return;
																setSource(v);
																setPage(1);
																void doSearch(query, 1, "goto", { source: v });
															},
														},
														label,
													),
												),
											),
											h("span", { className: "dcs-filters-label", style: { marginLeft: "auto" } }, t("langLabel")),
											h(
												"select",
												{
													className: "dcs-select",
													value: langId,
													title: "仅对 Chub 生效（中文站本身就是中文）。实测精确率 93%、漏卡约 3%。",
													onChange: (e) => {
														setLangId(e.target.value);
														setPage(1);
														void doSearch(query, 1, "goto", { langId: e.target.value });
													},
												},
												h("option", { value: "" }, t("langAll")),
												h("option", { value: "12" }, t("langChinese")),
											),
										),
										// 「自定义」卡库的取数来源切换：本地磁盘 / GitHub。
										// 两侧是**同一批 11480 张卡**（实测 rel 集合完全相同：仅本地 0 /
										// 仅远端 0 / 交集 11480），只是取数路径不同 —— 所以文案写
										// 「取数来源」而不是「数据源」，免得被当成两批不同的卡。
										// 只在选中「自定义」时出现，不占常驻版面。
										// 分类筛选：**列出全部**分类（用户明确「分类的我要全部」）。
										// 单行横向滚动，不换行堆高；点选切换，可多选。
										localFacets !== null && (source === "local")
											? h(
													"div",
													{ className: "dcs-catrow" },
													...Object.entries(localFacets.categories ?? {})
														.sort((a, b) => b[1] - a[1])
														.map(([cat, n]) => {
															const on = localCats.includes(cat);
															return h(
																"button",
																{
																	key: cat,
																	className: "dcs-chipcat",
																	"data-on": on ? "1" : "0",
																	title: `${cat}（${n} 张）${on ? " · 点击取消" : " · 点击筛选"}`,
																	onClick: () => {
																		const next = on ? localCats.filter((c) => c !== cat) : [...localCats, cat];
																		setLocalCats(next);
																		setPage(1);
																		void doSearch(query, 1, "goto", { localCats: next });
																	},
																},
																h("span", null, cat),
																h("span", { className: "dcs-chipn" }, String(n)),
															);
														}),
												)
											: null,
										(source === "local") && originInfo !== null
											? h(
													"div",
													{ className: "dcs-row dcs-row-origin" },
													h("span", { className: "dcs-sub" }, t("originLabel")),
													h(
														"div",
														{ className: "dcs-seg dcs-seg-sm", role: "group" },
														...[
															["local", t("originLocal")],
															["remote", t("originRemote")],
														].map(([v, label]) =>
															h(
																"button",
																{
																	key: v,
																	className: "dcs-seg-btn",
																	"data-active": preferredOrigin === v ? "1" : "0",
																	disabled: v === "remote" && originInfo.remoteEnabled !== true,
																	title:
																		v === "remote" && originInfo.remoteEnabled !== true
																			? "未配置 remoteRepo，无法使用 GitHub 源"
																			: v === "remote"
																				? "从 GitHub 私有仓库取数。封面首次需拉原图，之后走本地缩略图缓存。"
																				: "直接读本地磁盘（快，封面走缩略图）。",
																	onClick: () => {
																		if (v === preferredOrigin) return;
																		setPreferredOrigin(v);
																		setPage(1);
																		void doSearch(query, 1, "goto", { origin: v });
																	},
																},
																label,
															),
														),
													),
													originInfo.thumbs && originInfo.thumbs.count > 0
														? h(
																"span",
																{ className: "dcs-sub", style: { marginLeft: "auto" }, title: "封面缩略图缓存" },
																`缓存 ${originInfo.thumbs.count}`,
															)
														: null,
												)
											: null,
										// 提示区（按需出现，不占常驻 UI）：
										//  ① 选了本地源但还没建索引 → 给一个扫描入口（否则用户只看到空结果）
										//  ② 搜过但没结果 → 原来的中文发现提示
										(source === "local") && localFacets === null
											? h(
													"div",
													{ className: "dcs-tip" },
													h("p", { style: { margin: "0 0 6px" } }, t("localEmpty")),
													h(
														"button",
														{
															className: "dcs-go",
															disabled: scanning,
															onClick: async () => {
																setScanning(true);
																setError("");
																try {
																	await apiPost("/local-scan", {});
																	await doSearch(query, 1, "goto");
																} catch (e) {
																	setError(String(e?.message ?? e));
																} finally {
																	setScanning(false);
																}
															},
														},
														scanning ? t("scanning") : t("scanLocal"),
													),
												)
											: searched && items.length === 0
												? h(
														"div",
														{ className: "dcs-tip" },
														h("p", { style: { fontWeight: 600, margin: "0 0 4px" } }, t("zhTipTitle")),
														h("p", { style: { margin: 0 } }, t("zhTipBody")),
													)
												: null,
										// 知情确认（不删改内容，只把话说明白）
										confirm
											? h(
													"div",
													{ className: "dcs-confirm" },
													h("p", { style: { fontWeight: 600 } }, t("confirmTitle")),
													h("p", null, confirm.why ?? ""),
													confirm.hits && confirm.hits.length > 0
														? h("p", { className: "dcs-sub" }, `命中：${confirm.hits.join("、")}`)
														: null,
													h(
														"div",
														{ className: "dcs-row" },
														h("button", { className: "dcs-go", onClick: () => void doSummon(confirm.card, true) }, t("confirmGo")),
														h("button", { className: "dcs-ghost", onClick: () => setConfirm(null) }, t("confirmCancel")),
													),
												)
											: null,
										error ? h("div", { className: "dcs-err", style: { marginTop: 8 } }, `${t("error")}: ${error}`) : null,
									),
									// 只有卡片列表滚动；上方搜索/筛选与下方分页/页脚都固定
									h(
										"div",
										{ className: "dcs-body" },
										// 结果网格
										busy
											? h(
													"div",
													{ className: "dcs-status" },
													h("span", { className: "dcs-spin", style: { marginRight: 6 } }),
													t("loading"),
												)
											: items.length === 0
												? searched
													? h("div", { className: "dcs-status" }, t("empty"))
													: null
												: h(
														"div",
														{ className: "dcs-grid" },
														...items.map((card) =>
															h(
																"div",
																{
																	key: card.fullPath,
																	className: "dcs-card",
																	role: "button",
																	tabIndex: 0,
																	"data-busy": summoning === card.fullPath ? "1" : "0",
																	onClick: () => {
																		// 长按刚开过详情 —— 这次 click 是浏览器补发的，吞掉。
																		// 时间窗兜底覆盖「长按后没产生 click」的场景（否则标记会一直挂着）。
																		if (suppressClick.current || Date.now() - lastLongPressAt.current < LONG_PRESS_SUPPRESS_MS) {
																			suppressClick.current = false;
																			return;
																		}
																		void doSummon(card, false);
																	},
																	// Enter/Space 也可召唤；事件来自详情按钮（stopPropagation 已拦）则跳过
																	onKeyDown: (e) => {
																		if (e.target !== e.currentTarget) return;
																		if (e.key === "Enter" || e.key === " ") {
																			e.preventDefault();
																			void doSummon(card, false);
																		}
																	},
																	// 右键 = 看详情（不召唤）。preventDefault 阻止浏览器右键菜单
																	onContextMenu: (e) => {
																		e.preventDefault();
																		void openDetail(card);
																	},
																	// 长按 = 看详情（移动端没有右键）。
																	// 多指（缩放）与滑动（滚列表）都不算长按。
																	onTouchStart: (e) => {
																		if ((e.touches?.length ?? 0) > 1) return;
																		longPressTimer.current = setTimeout(() => {
																			longPressTimer.current = null;
																			suppressClick.current = true;
																			lastLongPressAt.current = Date.now();
																			void openDetail(card);
																		}, LONG_PRESS_MS);
																	},
																	// 只管定时器；suppressClick 留给 onClick 消费
																	onTouchEnd: () => {
																		if (longPressTimer.current !== null) {
																			clearTimeout(longPressTimer.current);
																			longPressTimer.current = null;
																		}
																	},
																	onTouchMove: () => {
																		if (longPressTimer.current !== null) {
																			clearTimeout(longPressTimer.current);
																			longPressTimer.current = null;
																		}
																	},
																	// 悬停显示完整标题：卡名放最前（列表里名字会被 CSS 截断，
																	// 本地卡名尤其长），再补分类/路径便于辨认
																	title: [
																		card.name || card.slug,
																		card.tagline ?? "",
																		card.category ? `分类：${card.category}` : "",
																		card.fullPath,
																	].filter((x) => String(x ?? "").trim().length > 0).join("\n"),
																},
																// 左栏：**只有封面**，竖向占满。
																// 去掉「详情」按钮 —— 用户明确「不需要详情按钮，我知道右键可以看」，
																// 而右键（onContextMenu）与卡片点击召唤都还在。
																// 封面本身是 2:3 竖图（512x768），改成竖向矩形后不再被 44px 方框
																// 裁得看不清（这是用户反馈「图片大一些现在看不清」的原因）。
																h("span", { className: "dcs-left" }, h(CardAvatar, { key: "av", card })),
																h(
																	"span",
																	{ className: "dcs-meta" },
																	h(
																	"span",
																	{ className: "dcs-name" },
																	h(
																		"span",
																		{ className: "dcs-name-text", title: card.name || card.slug },
																		card.name || card.slug,
																	),
																		Number(card.dynEntries) > 0
																			? h(
																				"span",
																				{
																					className: "dcs-dyn",
																					title: `世界书里有 ${card.dynEntries} 条带 keys、且非 constant 的条目 —— 召唤后对话里提到它们的关键词才会注入` ,
																				},
																				`可触发 ${card.dynEntries}`,
																			)
																			: null,
																),
																	// 空字段一律不渲染（用户要求：「没有的字段就直接不显示，
																	// 不要空的留在那里」）。下面每个分支都是「有内容才出元素」，
																	// 不再输出空占位。
																	// 描述行：优先显示**卡的可读描述**（preview），没有才退回统计性
																	// 的 tagline（如「世界书 21 条」）。
																	//
																	// 两者**不同时显示**：文字列只有 156px、竖向也有限，而
																	// 「这卡讲什么」比「世界书几条」更该占这一行。
																	// 都没有 → 整行不渲染（符合「没有的字段就直接不显示」）。
																	(() => {
																		const pv = String(card.preview ?? "").trim();
																		if (pv.length > 0) return h("span", { className: "dcs-desc", title: pv }, pv);
																		const tg = String(card.tagline ?? "").trim();
																		return tg.length > 0 ? h("span", { className: "dcs-sub2", title: tg }, tg) : null;
																	})(),
																	(() => {
																		// 作者名：过滤掉**没有信息量**的三种形态 ——
																		//   · 内部 id（`user_797378`，思畅卡的 slug）
																		//   · 目录名（「未分类」等，本地卡把 category 塞进了 creator）
																		//   · 纯路径前缀（实测 `local://6-7月/x.png` 取首段会得到
																		//     字符串 `local:` —— 这是回退逻辑的 bug，曾显示在卡片上）
																		const raw = String(card.creator ?? "").trim();
																		const junk =
																			/^user[-_]\d+$/i.test(raw) ||
																			raw === "未分类" ||
																			raw === card.category ||
																			/^(local|chub|sichang):?$/i.test(raw);
																		if (raw.length > 0 && !junk) return h("span", { className: "dcs-sub" }, raw);
																		const chats = Number(card.chatCount ?? card.stats?.chats);
																		if (Number.isFinite(chats) && chats > 0) {
																			return h("span", { className: "dcs-sub" }, t("chats").replace("{n}", chats >= 10000 ? `${(chats / 10000).toFixed(1)}w` : String(chats)));
																		}
																		return null; // 没有可说的就不显示
																	})(),
																	Array.isArray(card.tags) && card.tags.length > 0
																		? h(
																				"span",
																				{ className: "dcs-tags" },
																				...card.tags.slice(0, 3).map((tag, i) =>
																					h("span", { className: "dcs-tag", key: `${tag}-${i}`, title: tag }, tag),
																				),
																			)
																		: null,
																),
															),
														),
													),
									),
									// 分页：数字页码条（跳页）+「加载更多」（增量）。
									// 两者并存的理由：Chub 深页会回吐重复条目，增量加载 + 去重是更稳的兜底；
									// 而数字分页适合快速跳转。页码按 host 给的 totalPages 渲染。
									h(
										"div",
										{ className: "dcs-foot" },
										items.length > 0
											? h(
													"div",
													{ className: "dcs-pager" },
													// ‹ 上一页
													h(
														"button",
														{
															className: "dcs-page-btn",
															disabled: busy || page <= 1,
															onClick: () => gotoPage(page - 1),
															title: t("prevPage"),
														},
														"‹",
													),
													// 页码（多页时折叠成 1 … n-1 n n+1 … N）
													...pageNumbers(page, totalPages).map((p) =>
														p === "…"
															? h("span", { key: `gap-${Math.random()}`, className: "dcs-page-gap" }, "…")
															: h(
																	"button",
																	{
																		key: `p-${p}`,
																		className: "dcs-page-btn",
																		"data-active": p === page ? "1" : "0",
																		disabled: busy,
																		onClick: () => gotoPage(p),
																	},
																	String(p),
																),
													),
													// › 下一页
													h(
														"button",
														{
															className: "dcs-page-btn",
															disabled: busy || page >= totalPages,
															onClick: () => gotoPage(page + 1),
															title: t("nextPage"),
														},
														"›",
													),
													// 加载更多（增量；深页去重后仍可继续）
													canLoadMore
														? h(
																"button",
																{
																	className: "dcs-ghost",
																	disabled: busy,
																	onClick: () => void doSearch(query, page + 1, "append"),
																},
																t("more"),
															)
														: null,
												)
											: null,
									),
								),
								document.body,
							);

				/* ── 详情浮层：分字段展示提示词原文（右键卡片打开）── */
				const detailOverlay =
					detail === null
						? null
						: ReactDOM.createPortal(
								h(
									"div",
									{
										className: "dcs-detail",
										style: {
											left: Math.max(8, Math.min(pos ? pos.left : 100, window.innerWidth - 536)),
											top: Math.max(8, window.innerHeight / 2 - 260),
											maxHeight: Math.min(560, window.innerHeight - 40),
										},
										role: "dialog",
										"aria-label": t("detail"),
									},
									h(
										"div",
										{ className: "dcs-detail-head" },
										h("span", { className: "dcs-head-title" }, detail.card.name || detail.card.slug),
										h("span", { className: "dcs-sub", style: { flex: 1, minWidth: 0 } }, String(detail.card.fullPath ?? "")),
										h(
											"button",
											{
												className: "dcs-ghost",
												disabled: summoning === detail.card.fullPath,
												onClick: () => void (summonedHere(detail.card) ? doUnsummon() : doSummon(detail.card, false)),
											},
											summoning === detail.card.fullPath
												? t("summoning")
												: summonedHere(detail.card)
												? t("unsummon")
												: t("summonThis"),
										),
										h(
											"button",
											{ className: "dcs-ghost", onClick: () => setDetail(null), "aria-label": "close" },
											"✕",
										),
									),
									detail.loading
										? h("div", { className: "dcs-detail-body" }, h("span", { className: "dcs-spin" }), " " + t("loading"))
										: detail.error
											? h("div", { className: "dcs-detail-body" }, h("div", { className: "dcs-err" }, detail.error))
											// 「当前注入原文」视图：与卡字段 tabs 是两种东西 ——
											// 这里显示的是**渲染后真正进系统提示的整段**（含标题/名单/截断标记）。
											: detail.kind === "section"
												? h(
														React.Fragment,
														null,
														h(
															"div",
															{ className: "dcs-detail-body" },
															(() => {
																const txt = detail.data?.text ?? "";
																if (txt.length === 0) {
																	return h(
																		"div",
																		{ className: "dcs-field-empty" },
																		detail.data?.summoned === false ? t("notSummoned") : t("empty_field"),
																	);
																}
																return h(
																	"div",
																	{ className: "dcs-field" },
																	h(
																		"div",
																		{ className: "dcs-field-head" },
																		h("span", null, `${t("injectedTitle")} · ${txt.length} 字符`),
																		h(
																			"button",
																			{
																				className: "dcs-ghost",
																				onClick: () => {
																					try {
																						void navigator.clipboard?.writeText(txt);
																					} catch {
																						/* 剪贴板不可用时忽略 */
																					}
																				},
																			},
																			t("copy"),
																		),
																	),
																	h("pre", { className: "dcs-field-body dcs-field-tall" }, txt),
																);
															})(),
														),
														h(
															"div",
															{ className: "dcs-stat" },
															detail.data?.name ? h("span", null, detail.data.name) : null,
															detail.data?.kind === "cast" ? h("span", null, t("castTag")) : null,
															Array.isArray(detail.data?.truncatedFields) && detail.data.truncatedFields.length > 0
																? h("span", null, `${t("truncatedTag")}：${detail.data.truncatedFields.join("、")}`)
																: null,
														),
													)
												: h(
														React.Fragment,
														null,
														// 字段切换 tab（只显示非空字段，空字段也列出但置灰）
														h(
														"div",
														{ className: "dcs-tabs" },
														...PROMPT_FIELDS.map(([key, label]) => {
															const text = promptFieldText(detail.data, key);
															return h(
																"button",
																{
																	key,
																	className: "dcs-tab",
																	"data-active": detail.tab === key ? "1" : "0",
																	"data-empty": text.length === 0 ? "1" : "0",
																	onClick: () => setDetail((prev) => (prev === null ? prev : { ...prev, tab: key })),
																},
																`${label}${text.length > 0 ? ` ${text.length}` : ""}`,
															);
														}),
														// 变量 tab 挨在字段后面：它编辑的正是这些字段里的宏。
														h(
															"button",
															{
																key: VARS_TAB,
																className: "dcs-tab",
																"data-active": detail.tab === VARS_TAB ? "1" : "0",
																"data-empty": Array.isArray(detail.vars?.extracted?.custom) && detail.vars.extracted.custom.length > 0 ? "0" : "1",
																onClick: () => void openVars(detail.card),
															},
															`${t("varsTab")}${
																Array.isArray(detail.vars?.extracted?.custom) && detail.vars.extracted.custom.length > 0
																	? ` ${detail.vars.extracted.custom.length}`
																	: ""
															}`,
														),
														// 按钮 tab 紧随变量 tab —— 但它**只在召唤了这张卡时**才出现：快捷按钮是「跟这个角色对话时一键发话」，没召唤就无从谈起。
														summonedHere(detail.card)
														? h(
															"button",
															{
																key: QR_TAB,
																className: "dcs-tab",
																"data-active": detail.tab === QR_TAB ? "1" : "0",
																"data-empty": (detail.qr?.card?.length ?? 0) + (detail.qr?.global?.length ?? 0) > 0 ? "0" : "1",
																onClick: () => void openQr(detail.card),
															},
															`${t("qrTab")}${
																(detail.qr?.card?.length ?? 0) + (detail.qr?.global?.length ?? 0) > 0
																	? ` ${(detail.qr?.card?.length ?? 0) + (detail.qr?.global?.length ?? 0)}`
																	: ""
															}`,
														)
														: null,
													),

													h(
														"div",
														{ className: "dcs-detail-body" },
														detail.tab === VARS_TAB
															? renderVarsPane(detail)
															: detail.tab === QR_TAB && summonedHere(detail.card)
															? renderQrPane(detail)
															: (() => {
															const text = promptFieldText(detail.data, detail.tab);
															return text.length === 0
																? h("div", { className: "dcs-field-empty" }, t("empty_field"))
																: h(
																		"div",
																		{ className: "dcs-field" },
																		h(
																			"div",
																			{ className: "dcs-field-head" },
																			h("span", null, `${detail.tab} · ${text.length} 字符`),
																			h(
																				"button",
																				{
																					className: "dcs-ghost",
																					onClick: () => {
																						try {
																							void navigator.clipboard?.writeText(text);
																						} catch {
																							/* 剪贴板不可用时忽略 */
																						}
																					},
																				},
																				t("copy"),
																			),
																		),
																		h("pre", { className: "dcs-field-body" }, text),
																	);
														})(),
													),
													h(
														"div",
														{ className: "dcs-stat" },
														h("span", null, t("hintDetail")),
														detail.data && detail.data.tags && detail.data.tags.length > 0
															? h("span", null, detail.data.tags.slice(0, 6).join(" · "))
															: null,
													),
												),
								),
								document.body,
							);

				// 宿主不渲染任何可见内容；面板与详情浮层经 portal 挂 body。
				return h(React.Fragment, null, panel, detailOverlay);
			}

			/* ── 工具箱菜单行：挂在 dsh-toolbox.menu，点击后通知宿主开面板 ── */
			function SummonRow(props) {
				const sessionId = props.sessionId ?? props.session?.id;
				const t = typeof props.t === "function" ? props.t : (k) => k;
				const [current, setCurrent] = React.useState(null);
				// 菜单行只在菜单打开期间挂载，mount 时查一次召唤状态即可
				React.useEffect(() => {
					let alive = true;
					apiGet(`/status?sessionId=${encodeURIComponent(sessionId ?? "")}`)
						.then((d) => { if (alive) setCurrent(d.summon ?? null); })
						.catch(() => { /* host 未就绪时保持原状 */ });
					return () => { alive = false; };
				}, [sessionId]);
				return h(
					"button",
					{
						className: "dtb-row dcs-row",
						onClick: (e) => {
							// 无事件/合成事件（如测试桩、键盘触发）时退回默认位置，openPanel 自己有兜底
							const r = e?.currentTarget?.getBoundingClientRect?.() ?? null;
							panelRequests.emit(r ? { left: r.left, top: r.top } : null);
							if (typeof props.close === "function") props.close();
						},
					},
					h("span", { className: "dcs-row-icon" }, "🎭"),
					h("span", { className: "dcs-row-label" }, current ? current.name ?? t("title") : t("title")),
					current ? h("span", { className: "dcs-row-state" }, t("summoned")) : null,
				);
			}

			function apply(ctx) {
				installStyle();
				ctx.effect(() => {
					const offZh = ctx.locale.register(NS, "zh", STRINGS.zh);
					const offEn = ctx.locale.register(NS, "en", STRINGS.en);
					return () => {
						if (typeof offZh === "function") offZh();
						if (typeof offEn === "function") offEn();
					};
				}, "dsh-card-summon: dictionaries");
				const t = ctx.locale.bind(NS);
				try {
					// 常驻宿主（渲染 null）：持有面板与详情浮层
					ctx.slots.inject("conversation.input.right", () =>
						ctx.slots.register(
							{
								name: "conversation.input.right",
								id: "dsh-card-summon",
								order: 41,
								label: () => t("title"),
								inject: () => ({ t }),
							},
							SummonHost,
						),
					);
					// 工具箱菜单行：dsh-toolbox 未挂载时该声明不存在，注入自动等待（声明 live 才执行）
					ctx.slots.inject("dsh-toolbox.menu", () =>
						ctx.slots.register(
							{
								name: "dsh-toolbox.menu",
								id: "dsh-card-summon",
								order: 10,
								label: () => t("title"),
								inject: () => ({ t }),
							},
							SummonRow,
						),
					);
					console.log("[dsh-card-summon] host on conversation.input.right + row on dsh-toolbox.menu");
				} catch (error) {
					console.error("[dsh-card-summon] slot inject failed", error);
				}
			}

			exports.name = "dsh-card-summon";
			exports.inject = ["slots", "locale"];
			exports.apply = apply;
			return module.exports;
		},
	});
