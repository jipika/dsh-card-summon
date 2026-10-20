/**
 * 远程卡库客户端（GitHub 私有仓库）。
 *
 * 配合 lib/local.js 使用：本地有卡就用本地（快、离线可用），
 * 本地没有（换机器 / 外置盘未挂载）则回源到这里。
 *
 * ── 实测过的三个坑（都踩过，别照直觉写）──
 *
 * 1) **私有仓库的 `raw.githubusercontent.com` 必须带 token**，且无 token 时返回的是
 *    **404 而不是 403** —— 很容易误判成「文件不存在」。实测带 `Authorization: Bearer` 后：
 *    `main/index.json.gz` → 200 / 24008456 B；`images/1-2月/逆转.png` → 200 / 923251 B。
 *
 * 2) **`api.github.com/contents` 对 >1MB 的文件不返回 `content`**（只给 sha）。
 *    本仓库的 `index.json.gz` 是 24MB、卡正文最大也有几十 KB，所以**一律走 raw**，
 *    不要用 contents API 取内容。
 *
 * 3) **远端路径与本地路径不是一一对应的字符串替换**：
 *      · 正文：`main` 分支 `cards/<分类>/<id>.json` —— 用 **id**（六位序号），不是文件名
 *      · 封面：`images` 分支 `<月份>/<分类>/<文件名>.png`
 *    且远端的 `<分类>` 比本地多一层（本地平铺月份里没有「未分类」目录，远端做了归一）。
 *    所以必须用 `manifest.json` 做 `src ↔ card` 映射，不能靠路径拼接。
 */
import { gunzipSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { STATE_ROOT } from "./state.js";

export const REMOTE_DEFAULTS = {
	repo: "jipika/dsh-card-library",
	mainBranch: "main",
	imagesBranch: "images",
};

/** 缓存目录：索引与 manifest 是「拉一次用很久」的东西，落盘避免每次启动都拉 24MB。 */
const CACHE_DIR = join(STATE_ROOT, "remote-cache");
const INDEX_CACHE = join(CACHE_DIR, "index.json.gz");
const MANIFEST_CACHE = join(CACHE_DIR, "manifest.json");

export class RemoteError extends Error {
	constructor(message, { url, status } = {}) {
		super(message);
		this.name = "RemoteError";
		this.url = url;
		this.status = status;
	}
}

/** 取 token：优先插件配置，其次环境变量，最后 `gh auth token`（本机已登录）。 */
let tokenResolver = null;
export function setTokenResolver(fn) {
	tokenResolver = fn;
}

function currentToken(cfg) {
	const explicit = cfg?.token;
	if (typeof explicit === "string" && explicit.trim().length > 0) return explicit.trim();
	if (typeof process.env.GH_TOKEN === "string" && process.env.GH_TOKEN.length > 0) return process.env.GH_TOKEN;
	if (typeof process.env.GITHUB_TOKEN === "string" && process.env.GITHUB_TOKEN.length > 0) return process.env.GITHUB_TOKEN;
	if (typeof tokenResolver === "function") {
		try {
			const t = tokenResolver();
			if (typeof t === "string" && t.trim().length > 0) return t.trim();
		} catch {
			/* 取不到就走匿名（公开仓库仍可用） */
		}
	}
	return "";
}

async function request(url, { cfg, signal, binary = false, timeoutMs = 120_000 } = {}) {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(new Error("timeout")), timeoutMs);
	const onAbort = () => ac.abort(signal?.reason);
	if (signal !== undefined) {
		if (signal.aborted) ac.abort(signal.reason);
		else signal.addEventListener("abort", onAbort, { once: true });
	}
	const token = currentToken(cfg);
	try {
		const res = await fetch(url, {
			headers: {
				...(token.length > 0 ? { Authorization: `Bearer ${token}` } : {}),
				"User-Agent": "dsh-card-summon",
				Accept: binary ? "*/*" : "application/json",
			},
			signal: ac.signal,
		});
		if (!res.ok) {
			// 注意：私有仓库无 token 时 raw 返回 404（不是 403）——文案里点明，省得误判
			const hint =
				res.status === 404 && token.length === 0
					? "（私有仓库需要 token；无 token 时 GitHub 返回 404 而非 403）"
					: res.status === 404
						? "（路径不存在，或 token 无权访问该私有仓库）"
						: "";
			throw new RemoteError(`远端 ${res.status}${hint}`, { url, status: res.status });
		}
		return binary ? Buffer.from(await res.arrayBuffer()) : await res.json();
	} catch (error) {
		if (error instanceof RemoteError) throw error;
		if (error?.name === "AbortError") {
			throw new RemoteError(signal?.aborted ? "请求已取消" : `远端超时（${timeoutMs}ms）`, { url });
		}
		throw new RemoteError(`远端请求失败：${error?.message ?? error}`, { url });
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener?.("abort", onAbort);
	}
}

/** raw 文件 URL（私有仓库必须带 token，见文件头注释）。 */
export function rawUrl(path, { cfg, branch } = {}) {
	const c = { ...REMOTE_DEFAULTS, ...(cfg ?? {}) };
	const b = branch ?? c.mainBranch;
	return `https://raw.githubusercontent.com/${c.repo}/${b}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

/**
 * 拉索引（`main/index.json.gz`，24MB gzip）。
 * 首次拉完落盘缓存；之后除非 maxAgeMs 过期，直接用缓存 —— 不做每次都拉 24MB 的蠢事。
 */
export async function fetchRemoteIndex({ cfg, signal, force = false, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
	mkdirSync(CACHE_DIR, { recursive: true });
	if (!force && existsSync(INDEX_CACHE)) {
		const age = Date.now() - statSync(INDEX_CACHE).mtimeMs;
		if (age < maxAgeMs) {
			try {
				const idx = JSON.parse(gunzipSync(readFileSync(INDEX_CACHE)).toString("utf8"));
				idx._fromCache = true;
				idx._ageMs = age;
				return idx;
			} catch {
				/* 缓存坏了就重新拉 */
			}
		}
	}
	const url = rawUrl("index.json.gz", { cfg });
	const buf = await request(url, { cfg, signal, binary: true });
	let idx;
	try {
		idx = JSON.parse(gunzipSync(buf).toString("utf8"));
	} catch (error) {
		throw new RemoteError(`索引解压/解析失败：${error?.message ?? error}（可能不是 gzip）`, { url });
	}
	try {
		writeFileSync(INDEX_CACHE, buf);
	} catch {
		/* 落盘失败不影响本次使用 */
	}
	idx._fromCache = false;
	return idx;
}

/** 拉 manifest（`main/manifest.json`，4.2MB）：`src ↔ card ↔ cover` 的映射表。 */
export async function fetchRemoteManifest({ cfg, signal, force = false, maxAgeMs = 6 * 60 * 60 * 1000 } = {}) {
	mkdirSync(CACHE_DIR, { recursive: true });
	if (!force && existsSync(MANIFEST_CACHE)) {
		const age = Date.now() - statSync(MANIFEST_CACHE).mtimeMs;
		if (age < maxAgeMs) {
			try {
				const m = JSON.parse(readFileSync(MANIFEST_CACHE, "utf8"));
				m._fromCache = true;
				return m;
			} catch {
				/* 重新拉 */
			}
		}
	}
	const url = rawUrl("manifest.json", { cfg });
	const m = await request(url, { cfg, signal });
	try {
		writeFileSync(MANIFEST_CACHE, JSON.stringify(m));
	} catch {
		/* 忽略 */
	}
	m._fromCache = false;
	return m;
}

/** 拉单张卡的正文 JSON（`main` 分支的 `cards/<分类>/<id>.json`）。 */
export async function fetchRemoteCard(cardPath, { cfg, signal } = {}) {
	const url = rawUrl(cardPath, { cfg });
	return await request(url, { cfg, signal });
}

/**
 * 拉封面 PNG（`images` 分支）。
 *
 * ⚠️ manifest 的 `cover` 字段**自带 `images/` 前缀**（如 `images/6-7月/xxx.png`），
 * 而 `images` 分支的根就是月份目录 —— 所以必须先剥掉这个前缀，否则会拼出
 * `images/images/...` 这种 404 路径（实测踩过）。
 */
export async function fetchRemoteImage(coverPath, { cfg, signal } = {}) {
	const rel = String(coverPath ?? "").replace(/^images\//, "");
	const url = rawUrl(rel, { cfg, branch: (cfg ?? {}).imagesBranch ?? REMOTE_DEFAULTS.imagesBranch });
	return await request(url, { cfg, signal, binary: true });
}

/**
 * 建立 `local://` 路径 → 远端路径的映射。
 * 关键：必须靠 manifest.map（src ↔ card），不能靠字符串替换 ——
 * 远端正文用六位 id、且分类目录层级与本地不同（见文件头注释第 3 条）。
 */
export function buildRemoteMap(manifest) {
	const bySrc = new Map();
	for (const c of manifest?.cards ?? []) {
		if (typeof c?.src === "string") bySrc.set(c.src, c);
	}
	return {
		size: bySrc.size,
		get(srcRel) {
			return bySrc.get(srcRel) ?? null;
		},
	};
}

export function cacheInfo() {
	return {
		dir: CACHE_DIR,
		index: existsSync(INDEX_CACHE) ? { bytes: statSync(INDEX_CACHE).size, mtime: statSync(INDEX_CACHE).mtime.toISOString() } : null,
		manifest: existsSync(MANIFEST_CACHE)
			? { bytes: statSync(MANIFEST_CACHE).size, mtime: statSync(MANIFEST_CACHE).mtime.toISOString() }
			: null,
	};
}

export { CACHE_DIR };
