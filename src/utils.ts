export function errorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (err && typeof err === "object" && "message" in err) {
		const msg = (err as { message: unknown }).message;
		if (typeof msg === "string") return msg;
	}
	return String(err);
}

export function errorCode(err: unknown): string {
	if (err && typeof err === "object" && "code" in err) {
		const code = (err as { code: unknown }).code;
		if (typeof code === "string") return code;
	}
	return "";
}

// cyrb53, a fast non-crypto hash. Good enough to tell if text changed.
export function hashString(str: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export function hash32(str: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return h >>> 0;
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let i = 0; i < bytes.length; i += chunk) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
	}
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export function stripNullBytes(s: string): string {
	return s.includes("\0") ? s.split("\0").join("") : s;
}

export function randomId(length = 12): string {
	return window.crypto.randomUUID().replace(/-/g, "").slice(0, length);
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	fallback: T,
): Promise<T> {
	let timer = 0;
	const timeout = new Promise<T>((resolve) => {
		timer = window.setTimeout(() => resolve(fallback), ms);
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		window.clearTimeout(timer);
	}
}

export async function runPool<T>(
	items: T[],
	limit: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const runners = Array.from(
		{ length: Math.min(limit, items.length) },
		async () => {
			while (next < items.length) {
				const item = items[next++] as T;
				await worker(item);
			}
		},
	);
	await Promise.all(runners);
}

export function commonDiff(
	from: string,
	to: string,
): { start: number; deleteCount: number; insert: string } | null {
	if (from === to) return null;
	let start = 0;
	const max = Math.min(from.length, to.length);
	while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) {
		start++;
	}
	let endFrom = from.length;
	let endTo = to.length;
	while (
		endFrom > start &&
		endTo > start &&
		from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)
	) {
		endFrom--;
		endTo--;
	}
	return {
		start,
		deleteCount: endFrom - start,
		insert: to.slice(start, endTo),
	};
}

export function conflictPath(path: string, deviceName: string): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = slash >= 0 ? path.slice(slash + 1) : path;
	const dot = name.lastIndexOf(".");
	const base = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	const d = new Date();
	const pad = (n: number) => String(n).padStart(2, "0");
	const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
	const device = deviceName.replace(/[\\/:*?"<>|#^[\]]/g, "").trim() || "other device";
	return `${dir}${base} (conflict ${device} ${stamp})${ext}`;
}

export function timeAgo(input: string | number): string {
	const t = typeof input === "number" ? input : Date.parse(input);
	if (!Number.isFinite(t)) return "";
	const diff = Math.max(0, Date.now() - t) / 1000;
	if (diff < 45) return "just now";
	if (diff < 90) return "a minute ago";
	if (diff < 3600) return `${Math.round(diff / 60)} minutes ago`;
	if (diff < 5400) return "an hour ago";
	if (diff < 86400) return `${Math.round(diff / 3600)} hours ago`;
	if (diff < 172800) return "yesterday";
	if (diff < 2592000) return `${Math.round(diff / 86400)} days ago`;
	return new Date(t).toLocaleDateString();
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
