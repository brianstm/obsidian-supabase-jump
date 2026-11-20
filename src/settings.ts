import { Platform } from "obsidian";

export type ConflictMode = "keep-both" | "newest";

export interface SupaBaseJumpSettings {
	supabaseUrl: string;
	supabaseAnonKey: string;
	email: string;
	passwordSecret: string;
	accessTokenSecret: string;
	vaultId: string;
	deviceId: string;
	deviceName: string;
	syncOnStartup: boolean;
	syncConfigFolder: boolean;
	syncWorkspace: boolean;
	syncIntervalMinutes: number;
	maxFileSizeMB: number;
	excludedFolders: string[];
	platformExcludedPaths: string[];
	conflictMode: ConflictMode;
	liveEditing: boolean;
	showCursors: boolean;
	showPresence: boolean;
	showRibbonIcon: boolean;
	lastSyncTime: number;
	password?: string;
	personalAccessToken?: string;
}

export const DEFAULT_SETTINGS: SupaBaseJumpSettings = {
	supabaseUrl: "",
	supabaseAnonKey: "",
	email: "",
	passwordSecret: "",
	accessTokenSecret: "",
	vaultId: "",
	deviceId: "",
	deviceName: "",
	syncOnStartup: true,
	syncConfigFolder: true,
	syncWorkspace: false,
	syncIntervalMinutes: 5,
	maxFileSizeMB: 50,
	excludedFolders: [],
	platformExcludedPaths: [],
	conflictMode: "keep-both",
	liveEditing: true,
	showCursors: true,
	showPresence: true,
	showRibbonIcon: true,
	lastSyncTime: 0,
};

export const PASSWORD_SECRET_ID = "supabase-jump-password";
export const ACCESS_TOKEN_SECRET_ID = "supabase-jump-access-token";

export function defaultDeviceName(): string {
	if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return Platform.isTablet ? "Android tablet" : "Android";
	if (Platform.isMacOS) return "Mac";
	if (Platform.isWin) return "Windows";
	if (Platform.isLinux) return "Linux";
	return "This device";
}

const OS_SYSTEM_FILES = new Set([
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",
	".localized",
	".Spotlight-V100",
	".Trashes",
	".fseventsd",
	".TemporaryItems",
	"ehthumbs.db",
	"ehthumbs_vista.db",
]);

export function isSystemFile(path: string): boolean {
	const name = path.split("/").pop() ?? "";
	return OS_SYSTEM_FILES.has(name) || name.startsWith("._");
}

export const BINARY_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tiff", "tif",
	"heic", "heif", "avif",
	"mp3", "mp4", "wav", "ogg", "m4a", "flac", "aac", "avi", "mov", "mkv",
	"webm", "3gp", "opus",
	"pdf", "zip", "tar", "gz", "bz2", "xz", "7z", "rar",
	"docx", "xlsx", "pptx", "doc", "xls", "ppt", "odt", "ods", "odp", "epub",
	"ttf", "otf", "woff", "woff2", "eot",
	"exe", "dll", "dylib", "so", "dmg", "pkg", "deb", "rpm", "apk", "ipa",
	"class", "jar", "wasm",
	"sig", "key", "p12", "pfx", "cer", "crt", "der", "p7b",
	"db", "sqlite", "sqlite3", "bin", "dat", "raw",
]);

export function isBinary(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return BINARY_EXTENSIONS.has(ext);
}

function matchesPrefix(filePath: string, folder: string): boolean {
	const prefix = folder.trim().replace(/^\/+|\/+$/g, "");
	if (!prefix) return false;
	return filePath === prefix || filePath.startsWith(prefix + "/");
}

export function isExcluded(filePath: string, excludedFolders: string[]): boolean {
	return excludedFolders.some((folder) => matchesPrefix(filePath, folder));
}

export function isPlatformExcluded(
	filePath: string,
	configDir: string,
	platformExcludedPaths: string[],
): boolean {
	return platformExcludedPaths.some((p) => {
		const full = p.startsWith(configDir + "/") ? p : `${configDir}/${p}`;
		return matchesPrefix(filePath, full) || matchesPrefix(filePath, p);
	});
}

export function parseList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map((s) => s.trim())
		.filter(Boolean);
}

export const WELL_KNOWN_PLATFORM_PATHS = [
	{ path: "appearance.json", label: "Appearance", desc: "Theme, fonts and colors" },
	{ path: "themes/", label: "Themes folder", desc: "Installed themes" },
	{ path: "snippets/", label: "CSS snippets", desc: "Your snippets folder" },
	{ path: "plugins/", label: "Plugins folder", desc: "Plugin code and plugin settings" },
	{ path: "community-plugins.json", label: "Enabled plugins list", desc: "Which community plugins are turned on" },
	{ path: "hotkeys.json", label: "Hotkeys", desc: "Custom keyboard shortcuts" },
];
