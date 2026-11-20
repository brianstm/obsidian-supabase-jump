import { App, Notice, Platform, TFile, TFolder, normalizePath } from "obsidian";
import { REALTIME_SUBSCRIBE_STATES, SupabaseClient } from "@supabase/supabase-js";
import {
	SupaBaseJumpSettings,
	isBinary,
	isExcluded,
	isPlatformExcluded,
	isSystemFile,
} from "./settings";
import { parseFrontmatter } from "./frontmatter";
import { DB_TABLE, STORAGE_BUCKET } from "./schema";
import { FileEntry, SyncState } from "./sync-state";
import { Connection, isNetworkError } from "./supabase";
import {
	conflictPath,
	errorCode,
	errorMessage,
	hashString,
	runPool,
	stripNullBytes,
} from "./utils";

export interface VaultFileRow {
	id: string;
	user_id: string;
	vault_id: string;
	path: string;
	content?: string | null;
	is_binary: boolean;
	storage_path: string | null;
	frontmatter?: Record<string, unknown> | null;
	tags?: string[] | null;
	platform: string;
	mtime: number;
	ctime?: number;
	size: number;
	deleted: boolean;
	updated_at: string;
	device_id?: string | null;
	device_name?: string | null;
}

export type SyncActivity = "idle" | "syncing";

export interface LiveHooks {
	isLive(path: string): boolean;
	handleRemoteRow(path: string, row: VaultFileRow, canMerge: boolean): boolean;
	currentText(path: string): string | null;
}

export interface SyncHost {
	app: App;
	settings: SupaBaseJumpSettings;
	connection: Connection;
	saveSettings(): Promise<void>;
	onActivity(): void;
	pluginDir: string;
}

type Op = { type: "push" } | { type: "delete" } | { type: "rename"; from: string };

const META_COLUMNS = "id,path,is_binary,storage_path,platform,mtime,size,deleted,updated_at";
const DEVICE_COLUMNS = ",device_id,device_name";
const PAGE_SIZE = 1000;
const CONTENT_BATCH_BYTES = 1_500_000;
const FLUSH_DELAY_MS = 700;
const FLUSH_MAX_WAIT_MS = 4000;
const CONFIG_POLL_MS = 5000;
const FALLBACK_POLL_MS = 20000;
const CURSOR_SLACK_MS = 2 * 60 * 1000;
const CONCURRENCY = 4;

export function toRowId(vaultId: string, filePath: string): string {
	return `${vaultId}::${filePath.replace(/\//g, "__SLASH__")}`;
}

export function pathFromRowId(vaultId: string, id: string): string | null {
	const prefix = `${vaultId}::`;
	if (!id.startsWith(prefix)) return null;
	return id.slice(prefix.length).replace(/__SLASH__/g, "/");
}

function toStoragePath(userId: string, vaultId: string, filePath: string): string {
	const bytes = new TextEncoder().encode(filePath);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const b64url = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
	const dotIdx = filePath.lastIndexOf(".");
	const ext = dotIdx >= 0 ? filePath.slice(dotIdx).replace(/[^a-zA-Z0-9.]/g, "_") : "";
	return `${userId}/${vaultId}/${b64url}${ext}`;
}

export type Decision =
	| "none"
	| "push"
	| "pull"
	| "delete-local"
	| "delete-remote"
	| "conflict"
	| "compare"
	| "forget";

export function decide(input: {
	localExists: boolean;
	localChanged: boolean;
	localMtime: number;
	remoteExists: boolean;
	remoteDeleted: boolean;
	remoteChanged: boolean;
	remoteUpdatedAt: number;
	hasEntry: boolean;
}): Decision {
	const { localExists, localChanged, remoteExists, remoteDeleted, remoteChanged, hasEntry } = input;

	if (!localExists && (!remoteExists || remoteDeleted)) return "forget";
	if (localExists && !remoteExists) return "push";

	if (!localExists) {
		return hasEntry && !remoteChanged ? "delete-remote" : "pull";
	}

	if (remoteDeleted) {
		if (hasEntry) return localChanged ? "push" : "delete-local";
		return input.localMtime > input.remoteUpdatedAt ? "push" : "delete-local";
	}

	if (!hasEntry) return "compare";
	if (localChanged && remoteChanged) return "conflict";
	if (localChanged) return "push";
	if (remoteChanged) return "pull";
	return "none";
}

export class SyncEngine {
	readonly state: SyncState;
	live: LiveHooks | null = null;

	private queue = new Map<string, Op>();
	private flushTimer: number | null = null;
	private firstQueuedAt = 0;
	private flushing = false;
	private retryTimer: number | null = null;
	private retryDelay = 2000;

	private running = 0;
	private fullSyncPromise: Promise<void> | null = null;
	private fetchPromise: Promise<void> | null = null;

	private channel: ReturnType<SupabaseClient["channel"]> | null = null;
	private channelJoined = false;
	private fallbackPollId: number | null = null;
	private configPollId: number | null = null;
	private autoSyncId: number | null = null;
	private configMtimes = new Map<string, number>();

	private legacySchema = false;
	private schemaChecked = false;
	private warnedLegacy = false;
	private tooLargeWarned = new Set<string>();
	private errorNoticeAt = 0;
	private allowMassDelete = false;

	constructor(private host: SyncHost) {
		this.state = new SyncState(
			host.app.vault.adapter,
			normalizePath(`${host.pluginDir}/sync-state.json`),
		);
	}

	get busy(): boolean {
		return this.running > 0 || this.flushing;
	}

	get pendingCount(): number {
		return this.queue.size;
	}

	get realtimeUp(): boolean {
		return this.channelJoined;
	}

	private get settings(): SupaBaseJumpSettings {
		return this.host.settings;
	}

	private get vault() {
		return this.host.app.vault;
	}

	private get client(): SupabaseClient {
		const client = this.host.connection.client;
		if (!client) throw new Error("Not connected");
		return client;
	}

	private get userId(): string {
		const id = this.host.connection.userId;
		if (!id) throw new Error("Not signed in");
		return id;
	}

	private begin(): void {
		this.running++;
		this.host.onActivity();
	}

	private end(): void {
		this.running = Math.max(0, this.running - 1);
		this.host.onActivity();
	}

	async loadState(): Promise<void> {
		await this.state.load(this.settings.vaultId);
	}

	shouldSkip(path: string): boolean {
		if (isSystemFile(path)) return true;
		const configDir = this.vault.configDir;
		const inConfig = path === configDir || path.startsWith(configDir + "/");
		if (inConfig) {
			if (!this.settings.syncConfigFolder) return true;
			const ownDir = this.host.pluginDir;
			if (path === `${ownDir}/data.json` || path === `${ownDir}/sync-state.json`) return true;
			if (!this.settings.syncWorkspace && /\/workspace(-mobile)?\.json$/.test(path)) return true;
			if (path.startsWith(`${configDir}/.trash/`)) return true;
		}
		if (path.startsWith(".trash/")) return true;
		return isExcluded(path, this.settings.excludedFolders);
	}

	private platformFor(path: string): string {
		const specific = isPlatformExcluded(path, this.vault.configDir, this.settings.platformExcludedPaths);
		if (!specific) return "all";
		return Platform.isMobile ? "mobile" : "desktop";
	}

	private wantsRow(row: Pick<VaultFileRow, "platform">): boolean {
		if (!row.platform || row.platform === "all") return true;
		return row.platform === (Platform.isMobile ? "mobile" : "desktop");
	}

	private async checkSchema(): Promise<void> {
		if (this.schemaChecked) return;
		const { error } = await this.client.from(DB_TABLE).select("device_id").limit(1);
		if (error && (errorCode(error) === "42P01" || errorCode(error) === "PGRST205")) {
			throw new Error("the vault_files table doesn't exist yet. Run the setup from the plugin settings first.");
		}
		if (error && !isNetworkError(error)) {
			this.legacySchema = true;
			if (!this.warnedLegacy) {
				this.warnedLegacy = true;
				new Notice(
					"Supabase jump: your database is missing a few new columns. Open the plugin settings and run the setup again to turn on version history and smarter live editing.",
					12000,
				);
			}
		} else if (error) {
			throw error;
		}
		this.schemaChecked = true;
	}

	resetSchemaCheck(): void {
		this.schemaChecked = false;
		this.legacySchema = false;
		this.warnedLegacy = false;
	}

	get hasHistory(): boolean {
		return this.schemaChecked && !this.legacySchema;
	}

	private columns(): string {
		return this.legacySchema ? META_COLUMNS : META_COLUMNS + DEVICE_COLUMNS;
	}

	private async statLocal(path: string): Promise<{ mtime: number; size: number } | null> {
		const file = this.vault.getFileByPath(path);
		if (file) return { mtime: file.stat.mtime, size: file.stat.size };
		try {
			const stat = await this.vault.adapter.stat(path);
			if (!stat || stat.type !== "file") return null;
			return { mtime: stat.mtime, size: stat.size };
		} catch {
			return null;
		}
	}

	private async readText(path: string): Promise<string> {
		const file = this.vault.getFileByPath(path);
		const raw = file ? await this.vault.read(file) : await this.vault.adapter.read(path);
		return stripNullBytes(raw);
	}

	private async localChanged(path: string, entry: FileEntry | undefined, stat: { mtime: number; size: number }): Promise<boolean> {
		if (!entry) return true;
		if (stat.mtime === entry.lm && stat.size === entry.ls) return false;
		if (isBinary(path) || entry.h === undefined) return true;
		const live = this.live?.currentText(path);
		const text = live ?? (await this.readText(path));
		if (hashString(text) === entry.h) {
			this.state.set(path, { ...entry, lm: stat.mtime, ls: stat.size });
			return false;
		}
		return true;
	}

	async pushPath(path: string, opts: { force?: boolean } = {}): Promise<void> {
		const stat = await this.statLocal(path);
		if (!stat) return;

		const maxBytes = this.settings.maxFileSizeMB * 1024 * 1024;
		if (maxBytes > 0 && stat.size > maxBytes) {
			if (!this.tooLargeWarned.has(path)) {
				this.tooLargeWarned.add(path);
				new Notice(`Supabase jump: skipped "${path}" because it is bigger than ${this.settings.maxFileSizeMB} MB.`);
			}
			return;
		}

		const vaultId = this.settings.vaultId;
		const rowId = toRowId(vaultId, path);
		const entry = this.state.get(path);
		const base = {
			id: rowId,
			user_id: this.userId,
			vault_id: vaultId,
			path,
			platform: this.platformFor(path),
			mtime: stat.mtime,
			ctime: stat.mtime,
			size: stat.size,
			deleted: false,
			updated_at: new Date().toISOString(),
			...(this.legacySchema
				? {}
				: { device_id: this.settings.deviceId, device_name: this.settings.deviceName }),
		};

		if (isBinary(path)) {
			if (!opts.force && entry && entry.lm === stat.mtime && entry.ls === stat.size) return;
			const file = this.vault.getFileByPath(path);
			const data = file ? await this.vault.readBinary(file) : await this.vault.adapter.readBinary(path);
			const storagePath = toStoragePath(this.userId, vaultId, path);
			const { error: uploadErr } = await this.client.storage
				.from(STORAGE_BUCKET)
				.upload(storagePath, data, { upsert: true });
			if (uploadErr) throw new Error(`upload failed, ${uploadErr.message}`);
			const ru = await this.upsert({ ...base, is_binary: true, storage_path: storagePath, content: null });
			this.state.set(path, { lm: stat.mtime, ls: stat.size, ru });
			return;
		}

		const content = this.live?.currentText(path) ?? (await this.readText(path));
		const h = hashString(content);
		if (!opts.force && entry && entry.h === h) {
			if (entry.lm !== stat.mtime || entry.ls !== stat.size) {
				this.state.set(path, { ...entry, lm: stat.mtime, ls: stat.size });
			}
			return;
		}

		const { properties, tags } = path.endsWith(".md")
			? parseFrontmatter(content)
			: { properties: {}, tags: [] as string[] };

		const ru = await this.upsert({
			...base,
			is_binary: false,
			storage_path: null,
			content,
			frontmatter: Object.keys(properties).length > 0 ? properties : null,
			tags: tags.length > 0 ? tags : null,
		});
		this.state.set(path, { h, lm: stat.mtime, ls: stat.size, ru });
	}

	private async upsert(row: Record<string, unknown>): Promise<string> {
		const { data, error } = await this.client
			.from(DB_TABLE)
			.upsert(row)
			.select("updated_at")
			.single<{ updated_at: string }>();
		if (error) {
			if (!this.legacySchema && errorCode(error) === "PGRST204" && /device_/.test(error.message)) {
				this.legacySchema = true;
				const { device_id: _a, device_name: _b, ...rest } = row;
				return this.upsert(rest);
			}
			throw new Error(error.message);
		}
		return data.updated_at;
	}

	async deleteRemote(path: string): Promise<void> {
		const rowId = toRowId(this.settings.vaultId, path);
		const { data, error } = await this.client
			.from(DB_TABLE)
			.update({ deleted: true, updated_at: new Date().toISOString() })
			.eq("id", rowId)
			.select("is_binary,storage_path,updated_at");
		if (error) throw new Error(error.message);
		const row = (data as Pick<VaultFileRow, "is_binary" | "storage_path" | "updated_at">[] | null)?.[0];
		this.state.delete(path);
		if (row?.is_binary && row.storage_path) {
			const { error: storageErr } = await this.client.storage.from(STORAGE_BUCKET).remove([row.storage_path]);
			if (storageErr) console.warn("Supabase jump: could not remove attachment", storageErr.message);
		}
	}

	private async renameRemote(from: string, to: string): Promise<void> {
		const entry = this.state.get(from);
		if (entry && isBinary(to) && isBinary(from)) {
			const vaultId = this.settings.vaultId;
			const oldKey = toStoragePath(this.userId, vaultId, from);
			const newKey = toStoragePath(this.userId, vaultId, to);
			const stat = await this.statLocal(to);
			if (stat) {
				const { error: moveErr } = await this.client.storage.from(STORAGE_BUCKET).move(oldKey, newKey);
				if (!moveErr) {
					const ru = await this.upsert({
						id: toRowId(vaultId, to),
						user_id: this.userId,
						vault_id: vaultId,
						path: to,
						platform: this.platformFor(to),
						is_binary: true,
						storage_path: newKey,
						content: null,
						mtime: stat.mtime,
						ctime: stat.mtime,
						size: stat.size,
						deleted: false,
						updated_at: new Date().toISOString(),
						...(this.legacySchema
							? {}
							: { device_id: this.settings.deviceId, device_name: this.settings.deviceName }),
					});
					this.state.set(to, { lm: stat.mtime, ls: stat.size, ru });
					await this.client
						.from(DB_TABLE)
						.update({ deleted: true, updated_at: new Date().toISOString() })
						.eq("id", toRowId(vaultId, from));
					this.state.delete(from);
					return;
				}
			}
		}
		await this.pushPath(to, { force: true });
		if (this.state.get(from) || entry) await this.deleteRemote(from);
	}

	private async writeText(path: string, content: string): Promise<void> {
		await this.ensureFolder(path);
		const file = this.vault.getFileByPath(path);
		if (file) await this.vault.modify(file, content);
		else if (this.isConfigPath(path)) await this.vault.adapter.write(path, content);
		else await this.vault.create(path, content);
	}

	private async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		await this.ensureFolder(path);
		const file = this.vault.getFileByPath(path);
		if (file) await this.vault.modifyBinary(file, data);
		else if (this.isConfigPath(path)) await this.vault.adapter.writeBinary(path, data);
		else await this.vault.createBinary(path, data);
	}

	private isConfigPath(path: string): boolean {
		const dir = this.vault.configDir;
		return path === dir || path.startsWith(dir + "/");
	}

	async ensureFolder(filePath: string): Promise<void> {
		const parts = filePath.split("/");
		parts.pop();
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			if (this.isConfigPath(current)) {
				if (!(await this.vault.adapter.exists(current))) await this.vault.adapter.mkdir(current);
				continue;
			}
			if (!this.vault.getAbstractFileByPath(current)) {
				try {
					await this.vault.createFolder(current);
				} catch {
					// it may have been created in the meantime
				}
			}
		}
	}

	private async pullRow(row: VaultFileRow, targetPath = row.path): Promise<void> {
		if (row.is_binary) {
			if (!row.storage_path) throw new Error("missing storage path");
			const { data, error } = await this.client.storage.from(STORAGE_BUCKET).download(row.storage_path);
			if (error || !data) throw new Error(`download failed, ${error?.message ?? "no data"}`);
			const buffer = await data.arrayBuffer();
			await this.writeBinary(targetPath, buffer);
			if (targetPath === row.path) {
				const stat = await this.statLocal(targetPath);
				this.state.set(row.path, { lm: stat?.mtime ?? 0, ls: stat?.size ?? 0, ru: row.updated_at });
			}
			return;
		}

		const content = row.content ?? (await this.fetchContent(row.id));
		await this.writeText(targetPath, content);
		if (targetPath === row.path) {
			const stat = await this.statLocal(targetPath);
			this.state.set(row.path, {
				h: hashString(content),
				lm: stat?.mtime ?? 0,
				ls: stat?.size ?? 0,
				ru: row.updated_at,
			});
		}
	}

	private async fetchContent(id: string): Promise<string> {
		const { data, error } = await this.client
			.from(DB_TABLE)
			.select("content")
			.eq("id", id)
			.single<{ content: string | null }>();
		if (error) throw new Error(error.message);
		return data.content ?? "";
	}

	private async fillContent(rows: VaultFileRow[]): Promise<void> {
		const need = rows.filter((r) => !r.is_binary && r.content === undefined);
		let batch: VaultFileRow[] = [];
		let bytes = 0;
		const run = async () => {
			if (batch.length === 0) return;
			const ids = batch.map((r) => r.id);
			const { data, error } = await this.client.from(DB_TABLE).select("id,content").in("id", ids);
			if (error) throw new Error(error.message);
			const map = new Map((data as { id: string; content: string | null }[]).map((d) => [d.id, d.content]));
			for (const r of batch) r.content = map.get(r.id) ?? "";
			batch = [];
			bytes = 0;
		};
		for (const row of need) {
			batch.push(row);
			bytes += row.size || 0;
			if (bytes >= CONTENT_BATCH_BYTES || batch.length >= 200) await run();
		}
		await run();
	}

	private async deleteLocal(path: string): Promise<void> {
		this.state.delete(path);
		const file = this.vault.getAbstractFileByPath(path);
		if (file) {
			await this.host.app.fileManager.trashFile(file);
			return;
		}
		if (await this.vault.adapter.exists(path)) {
			await this.vault.adapter.trashLocal(path);
		}
	}

	private async keepBoth(row: VaultFileRow): Promise<void> {
		const copy = conflictPath(row.path, row.device_name || "another device");
		await this.pullRow(row, copy);
		await this.pushPath(row.path, { force: true });
		new Notice(`Supabase jump: "${row.path}" changed on two devices. Kept both, the other version is in "${copy}".`, 10000);
	}

	private async applyRow(row: VaultFileRow, opts: { allowPush: boolean }): Promise<void> {
		const path = row.path;
		if (this.shouldSkip(path) || !this.wantsRow(row)) return;

		const entry = this.state.get(path);
		if (entry && entry.ru === row.updated_at) return;

		if (this.live?.isLive(path) && !row.deleted && !row.is_binary) {
			const text = this.live.currentText(path);
			const canMerge = text !== null && entry?.h !== undefined && hashString(text) === entry.h;
			if (row.content === undefined) await this.fillContent([row]);
			if (this.live.handleRemoteRow(path, row, canMerge)) {
				this.state.set(path, { h: hashString(row.content ?? ""), lm: -1, ls: -1, ru: row.updated_at });
				return;
			}
		}

		const stat = await this.statLocal(path);
		const localExists = stat !== null;
		const localChanged = localExists ? await this.localChanged(path, entry, stat) : false;
		const decision = decide({
			localExists,
			localChanged,
			localMtime: stat?.mtime ?? 0,
			remoteExists: true,
			remoteDeleted: row.deleted,
			remoteChanged: !entry || entry.ru !== row.updated_at,
			remoteUpdatedAt: Date.parse(row.updated_at) || 0,
			hasEntry: entry !== undefined,
		});

		await this.execute(decision, path, row, stat, opts);
	}

	private async execute(
		decision: Decision,
		path: string,
		row: VaultFileRow | undefined,
		stat: { mtime: number; size: number } | null,
		opts: { allowPush: boolean },
	): Promise<void> {
		switch (decision) {
			case "none":
				if (row) {
					const entry = this.state.get(path);
					if (entry) this.state.set(path, { ...entry, ru: row.updated_at });
				}
				return;
			case "forget":
				this.state.delete(path);
				return;
			case "push":
				if (opts.allowPush) await this.pushPath(path, { force: true });
				else this.enqueue(path, { type: "push" });
				return;
			case "delete-remote":
				await this.deleteRemote(path);
				return;
			case "delete-local":
				await this.deleteLocal(path);
				return;
			case "pull":
				if (row) await this.pullRow(row);
				return;
			case "conflict":
				if (!row) return;
				if (await this.sameContent(path, row, stat)) return;
				if (this.settings.conflictMode === "keep-both") {
					await this.keepBoth(row);
				} else if ((stat?.mtime ?? 0) > row.mtime) {
					await this.pushPath(path, { force: true });
				} else {
					await this.pullRow(row);
				}
				return;
			case "compare":
				if (!row) return;
				if (await this.sameContent(path, row, stat)) return;
				if ((stat?.mtime ?? 0) >= row.mtime) await this.pushPath(path, { force: true });
				else await this.pullRow(row);
				return;
		}
	}

	private async sameContent(path: string, row: VaultFileRow, stat: { mtime: number; size: number } | null): Promise<boolean> {
		if (!stat) return false;
		if (row.is_binary) {
			if (stat.size !== row.size) return false;
			this.state.set(path, { lm: stat.mtime, ls: stat.size, ru: row.updated_at });
			return true;
		}
		if (row.content === undefined) await this.fillContent([row]);
		const local = this.live?.currentText(path) ?? (await this.readText(path));
		const h = hashString(local);
		if (h !== hashString(row.content ?? "")) return false;
		this.state.set(path, { h, lm: stat.mtime, ls: stat.size, ru: row.updated_at });
		return true;
	}

	fullSync(opts: { silent?: boolean } = {}): Promise<void> {
		if (this.fullSyncPromise) return this.fullSyncPromise;
		this.fullSyncPromise = this.doFullSync(opts.silent ?? false).finally(() => {
			this.fullSyncPromise = null;
		});
		return this.fullSyncPromise;
	}

	private async listRemote(sinceIso?: string): Promise<VaultFileRow[]> {
		const rows: VaultFileRow[] = [];
		const cols = this.columns();
		for (let from = 0; ; from += PAGE_SIZE) {
			let q = this.client
				.from(DB_TABLE)
				.select(cols)
				.eq("vault_id", this.settings.vaultId);
			if (sinceIso) q = q.gte("updated_at", sinceIso);
			const { data, error } = await q.order("id").range(from, from + PAGE_SIZE - 1);
			if (error) throw new Error(error.message);
			const page = (data ?? []) as unknown as VaultFileRow[];
			rows.push(...page);
			if (page.length < PAGE_SIZE) break;
		}
		return rows;
	}

	private async listLocal(): Promise<string[]> {
		const paths = this.vault
			.getFiles()
			.map((f) => f.path)
			.filter((p) => !this.shouldSkip(p));
		if (this.settings.syncConfigFolder) {
			const config = await this.listAdapterFiles(this.vault.configDir);
			paths.push(...config.filter((p) => !this.shouldSkip(p)));
		}
		return paths;
	}

	private async listAdapterFiles(folder: string): Promise<string[]> {
		const out: string[] = [];
		try {
			const listed = await this.vault.adapter.list(folder);
			out.push(...listed.files);
			for (const sub of listed.folders) {
				if (this.shouldSkip(sub)) continue;
				out.push(...(await this.listAdapterFiles(sub)));
			}
		} catch {
			// folder is gone or unreadable
		}
		return out;
	}

	private async doFullSync(silent: boolean): Promise<void> {
		if (!this.settings.vaultId) {
			if (!silent) new Notice("Supabase jump: set a vault ID in settings first.");
			return;
		}
		if (!this.host.connection.ready) {
			if (!silent) new Notice("Supabase jump: not connected yet.");
			return;
		}

		this.begin();
		const errors: string[] = [];
		try {
			await this.checkSchema();
			await this.flushQueue();

			const rows = await this.listRemote();
			const remote = new Map(rows.map((r) => [r.path, r]));
			const local = new Set(await this.listLocal());
			const all = new Set<string>([...local, ...remote.keys(), ...this.state.paths()]);

			const plan: { path: string; decision: Decision; row?: VaultFileRow; stat: { mtime: number; size: number } | null }[] = [];
			let newest = "";

			for (const path of all) {
				const row = remote.get(path);
				if (row && row.updated_at > newest) newest = row.updated_at;
				if (this.shouldSkip(path)) continue;
				if (row && !this.wantsRow(row)) continue;
				if (row && this.live?.isLive(path) && !row.deleted) continue;

				const entry = this.state.get(path);
				const stat = local.has(path) ? await this.statLocal(path) : null;
				const localChanged = stat ? await this.localChanged(path, entry, stat) : false;
				const decision = decide({
					localExists: stat !== null,
					localChanged,
					localMtime: stat?.mtime ?? 0,
					remoteExists: row !== undefined,
					remoteDeleted: row?.deleted ?? false,
					remoteChanged: row ? !entry || entry.ru !== row.updated_at : false,
					remoteUpdatedAt: row ? Date.parse(row.updated_at) || 0 : 0,
					hasEntry: entry !== undefined,
				});
				if (decision !== "none") plan.push({ path, decision, row, stat });
			}

			const removals = plan.filter((p) => p.decision === "delete-remote" || p.decision === "delete-local").length;
			const approved = this.allowMassDelete && !silent;
			if (removals > 50 && removals > this.state.size * 0.3 && !approved) {
				new Notice(
					`Supabase jump: this sync wanted to delete ${removals} files, which looks wrong. Deletes were skipped this time. If you really removed that many files, run sync again from the command palette.`,
					15000,
				);
				for (let i = plan.length - 1; i >= 0; i--) {
					const d = plan[i]?.decision;
					if (d === "delete-remote" || d === "delete-local") plan.splice(i, 1);
				}
				this.allowMassDelete = true;
			} else {
				this.allowMassDelete = false;
			}

			const contentRows = plan
				.filter((p) => p.row && !p.row.is_binary && ["pull", "conflict", "compare"].includes(p.decision))
				.map((p) => p.row as VaultFileRow);
			await this.fillContent(contentRows);

			await runPool(plan, CONCURRENCY, async (item) => {
				try {
					await this.execute(item.decision, item.path, item.row, item.stat, { allowPush: true });
				} catch (err) {
					if (isNetworkError(err)) throw err;
					errors.push(item.path);
					console.error(`Supabase jump: could not sync "${item.path}"`, err);
				}
			});

			this.state.setCursor(newest);
			await this.state.flush();
			this.settings.lastSyncTime = Date.now();
			await this.host.saveSettings();

			if (!silent) {
				const n = errors.length;
				new Notice(n > 0 ? `Supabase jump: sync done, ${n} file${n > 1 ? "s" : ""} had problems (see console)` : "Supabase jump: everything is in sync");
			}
		} catch (err) {
			this.handleError("Sync", err, silent);
		} finally {
			this.end();
		}
	}

	fetchChanges(opts: { silent?: boolean } = {}): Promise<void> {
		if (this.fetchPromise) return this.fetchPromise;
		this.fetchPromise = this.doFetchChanges(opts.silent ?? true).finally(() => {
			this.fetchPromise = null;
		});
		return this.fetchPromise;
	}

	private async doFetchChanges(silent: boolean): Promise<void> {
		if (!this.settings.vaultId || !this.host.connection.ready) return;
		if (this.fullSyncPromise) {
			await this.fullSyncPromise;
			return;
		}
		if (!this.state.cursor || this.state.size === 0) {
			await this.fullSync({ silent });
			return;
		}
		this.begin();
		try {
			await this.checkSchema();
			const since = new Date(Date.parse(this.state.cursor) - CURSOR_SLACK_MS).toISOString();
			const rows = await this.listRemote(since);
			let newest = this.state.cursor;
			const relevant = rows.filter((r) => {
				if (r.updated_at > newest) newest = r.updated_at;
				return this.state.get(r.path)?.ru !== r.updated_at;
			});
			await this.fillContent(relevant.filter((r) => !r.is_binary && !r.deleted));
			for (const row of relevant) {
				try {
					await this.applyRow(row, { allowPush: true });
				} catch (err) {
					if (isNetworkError(err)) throw err;
					console.error(`Supabase jump: could not apply "${row.path}"`, err);
				}
			}
			this.state.setCursor(newest);
			this.settings.lastSyncTime = Date.now();
			await this.host.saveSettings();
			if (!silent) new Notice("Supabase jump: up to date");
		} catch (err) {
			this.handleError("Fetch", err, silent);
		} finally {
			this.end();
		}
	}

	private handleError(what: string, err: unknown, silent: boolean): void {
		if (isNetworkError(err)) {
			this.host.connection.markOffline();
			return;
		}
		console.error(`Supabase jump: ${what} failed`, err);
		const now = Date.now();
		if (!silent || now - this.errorNoticeAt > 60000) {
			this.errorNoticeAt = now;
			new Notice(`Supabase jump: ${what.toLowerCase()} failed. ${errorMessage(err)}`, 8000);
		}
	}

	startRealtime(): void {
		this.stopRealtime();
		const client = this.host.connection.client;
		const vaultId = this.settings.vaultId;
		if (!client || !vaultId) return;

		const channel = client.channel(`vault-${vaultId}`);
		this.channel = channel;
		channel
			.on<VaultFileRow>(
				"postgres_changes",
				{ event: "*", schema: "public", table: DB_TABLE, filter: `vault_id=eq.${vaultId}` },
				(payload) => {
					if (this.channel !== channel) return;
					const row = payload.eventType === "DELETE" ? null : (payload.new);
					if (!row) {
						const oldId = (payload.old as Partial<VaultFileRow>).id;
						const path = oldId ? pathFromRowId(vaultId, oldId) : null;
						if (path && this.state.get(path)) {
							void this.applyRow(
								{ id: oldId ?? "", path, deleted: true, updated_at: new Date().toISOString(), is_binary: isBinary(path), storage_path: null, platform: "all", mtime: 0, size: 0, user_id: "", vault_id: vaultId },
								{ allowPush: false },
							).catch((err) => console.error("Supabase jump: realtime delete failed", err));
						}
						return;
					}
					if (row.updated_at > this.state.cursor) this.state.setCursor(row.updated_at);
					if (row.device_id && row.device_id === this.settings.deviceId) return;
					this.begin();
					this.applyRow(row, { allowPush: false })
						.catch((err) => {
							if (isNetworkError(err)) this.host.connection.markOffline();
							else console.error(`Supabase jump: could not apply change to "${row.path}"`, err);
						})
						.finally(() => this.end());
				},
			)
			.subscribe((status) => {
				if (this.channel !== channel) return;
				if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
					const wasDown = !this.channelJoined;
					this.channelJoined = true;
					this.stopFallbackPoll();
					this.host.onActivity();
					if (wasDown) void this.fetchChanges();
				} else {
					this.channelJoined = false;
					this.startFallbackPoll();
					this.host.onActivity();
				}
			});
	}

	stopRealtime(): void {
		const channel = this.channel;
		this.channel = null;
		this.channelJoined = false;
		this.stopFallbackPoll();
		if (channel) void this.host.connection.client?.removeChannel(channel);
	}

	async resume(): Promise<void> {
		if (!this.host.connection.ready) return;
		const ch = this.channel;
		const state = String(ch?.state ?? "closed");
		if (!ch || state === "errored" || state === "closed") {
			this.startRealtime();
		}
		await this.fetchChanges();
		this.scheduleFlush(0);
	}

	private startFallbackPoll(): void {
		if (this.fallbackPollId !== null) return;
		this.fallbackPollId = window.setInterval(() => {
			if (activeDocument.visibilityState !== "visible") return;
			void this.fetchChanges();
		}, FALLBACK_POLL_MS);
	}

	private stopFallbackPoll(): void {
		if (this.fallbackPollId !== null) {
			window.clearInterval(this.fallbackPollId);
			this.fallbackPollId = null;
		}
	}

	// Obsidian has no vault events for the config folder, so poll it.

	startConfigWatcher(): void {
		this.stopConfigWatcher();
		if (!this.settings.syncConfigFolder) return;
		void this.scanConfig(true);
		this.configPollId = window.setInterval(() => {
			if (activeDocument.visibilityState !== "visible") return;
			void this.scanConfig(false).catch((err) => console.warn("Supabase jump: config scan failed", err));
		}, CONFIG_POLL_MS);
	}

	stopConfigWatcher(): void {
		if (this.configPollId !== null) {
			window.clearInterval(this.configPollId);
			this.configPollId = null;
		}
	}

	private async scanConfig(warm: boolean): Promise<void> {
		const paths = (await this.listAdapterFiles(this.vault.configDir)).filter((p) => !this.shouldSkip(p));
		const seen = new Set<string>();
		for (const p of paths) {
			seen.add(p);
			const stat = await this.statLocal(p);
			if (!stat) continue;
			const prev = this.configMtimes.get(p);
			this.configMtimes.set(p, stat.mtime);
			if (warm) continue;
			if (prev === undefined || stat.mtime !== prev) {
				const entry = this.state.get(p);
				if (!entry || entry.lm !== stat.mtime || entry.ls !== stat.size) this.enqueue(p, { type: "push" });
			}
		}
		if (warm) return;
		for (const p of [...this.configMtimes.keys()]) {
			if (!seen.has(p)) {
				this.configMtimes.delete(p);
				if (this.state.get(p)) this.enqueue(p, { type: "delete" });
			}
		}
	}

	startAutoSync(): void {
		this.stopAutoSync();
		const minutes = this.settings.syncIntervalMinutes;
		if (minutes <= 0) return;
		this.autoSyncId = window.setInterval(() => {
			if (activeDocument.visibilityState !== "visible") return;
			void this.fullSync({ silent: true });
		}, minutes * 60 * 1000);
	}

	stopAutoSync(): void {
		if (this.autoSyncId !== null) {
			window.clearInterval(this.autoSyncId);
			this.autoSyncId = null;
		}
	}

	onLocalCreateOrModify(path: string): void {
		this.enqueue(path, { type: "push" });
	}

	onLocalDelete(path: string, wasFolder: boolean): void {
		if (wasFolder) {
			const prefix = path + "/";
			for (const p of this.state.paths()) {
				if (p.startsWith(prefix)) this.enqueue(p, { type: "delete" });
			}
			return;
		}
		this.enqueue(path, { type: "delete" });
	}

	onLocalRename(file: TFile | TFolder, oldPath: string): void {
		if (file instanceof TFolder) {
			const oldPrefix = oldPath + "/";
			for (const p of this.state.paths()) {
				if (p.startsWith(oldPrefix)) {
					this.enqueue(file.path + "/" + p.slice(oldPrefix.length), { type: "rename", from: p });
				}
			}
			return;
		}
		this.enqueue(file.path, { type: "rename", from: oldPath });
	}

	private enqueue(path: string, op: Op): void {
		if (op.type === "rename") {
			if (this.shouldSkip(path)) {
				if (!this.shouldSkip(op.from)) this.enqueue(op.from, { type: "delete" });
				return;
			}
			if (this.shouldSkip(op.from)) {
				this.enqueue(path, { type: "push" });
				return;
			}
			const pendingFrom = this.queue.get(op.from);
			this.queue.delete(op.from);
			if (pendingFrom?.type === "rename") op = { type: "rename", from: pendingFrom.from };
			else if (pendingFrom?.type === "push" && !this.state.get(op.from)) op = { type: "push" };
		} else {
			if (this.shouldSkip(path)) return;
			const existing = this.queue.get(path);
			if (op.type === "push" && existing?.type === "rename") return;
			if (op.type === "delete" && existing?.type === "rename") {
				this.queue.set(existing.from, { type: "delete" });
			}
		}

		if (this.queue.size === 0) this.firstQueuedAt = Date.now();
		this.queue.set(path, op);
		this.host.onActivity();
		this.scheduleFlush(FLUSH_DELAY_MS);
	}

	scheduleFlush(delay: number): void {
		if (this.queue.size === 0) return;
		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		const waited = Date.now() - this.firstQueuedAt;
		const wait = waited >= FLUSH_MAX_WAIT_MS ? 0 : delay;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			void this.flushQueue();
		}, wait);
	}

	async flushQueue(): Promise<void> {
		if (this.flushing || this.queue.size === 0) return;
		if (!this.host.connection.ready || !this.settings.vaultId) return;

		this.flushing = true;
		this.host.onActivity();
		const items = [...this.queue.entries()];
		this.queue.clear();
		let offline = false;

		try {
			await this.checkSchema();
			await runPool(items, CONCURRENCY, async ([path, op]) => {
				if (offline) {
					this.requeue(path, op);
					return;
				}
				try {
					if (op.type === "push") await this.pushPath(path);
					else if (op.type === "delete") {
						if (this.state.get(path)) await this.deleteRemote(path);
					} else await this.renameRemote(op.from, path);
				} catch (err) {
					if (isNetworkError(err)) {
						offline = true;
						this.requeue(path, op);
						return;
					}
					this.handleError(`Upload of "${path}"`, err, true);
				}
			});
		} catch (err) {
			if (isNetworkError(err)) {
				offline = true;
				for (const [path, op] of items) this.requeue(path, op);
			} else {
				this.handleError("Upload", err, true);
			}
		} finally {
			this.flushing = false;
			this.host.onActivity();
		}

		if (offline) {
			this.host.connection.markOffline();
			this.scheduleRetry();
		} else {
			this.retryDelay = 2000;
			if (this.queue.size > 0) this.scheduleFlush(FLUSH_DELAY_MS);
		}
	}

	private requeue(path: string, op: Op): void {
		if (!this.queue.has(path)) this.queue.set(path, op);
	}

	private scheduleRetry(): void {
		if (this.retryTimer !== null) return;
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			if (this.host.connection.ready) void this.flushQueue();
		}, this.retryDelay);
		this.retryDelay = Math.min(this.retryDelay * 2, 60000);
	}

	async listVersions(path: string): Promise<{ id: number; created_at: string; size: number | null; device_name: string | null }[]> {
		const { data, error } = await this.client
			.from("vault_file_versions")
			.select("id,created_at,size,device_name")
			.eq("file_id", toRowId(this.settings.vaultId, path))
			.order("created_at", { ascending: false })
			.limit(50);
		if (error) throw error;
		return (data ?? []) as { id: number; created_at: string; size: number | null; device_name: string | null }[];
	}

	async versionContent(id: number): Promise<string> {
		const { data, error } = await this.client
			.from("vault_file_versions")
			.select("content")
			.eq("id", id)
			.single<{ content: string | null }>();
		if (error) throw error;
		return data.content ?? "";
	}

	async snapshot(path: string, content: string): Promise<void> {
		const { error } = await this.client.from("vault_file_versions").insert({
			file_id: toRowId(this.settings.vaultId, path),
			vault_id: this.settings.vaultId,
			path,
			content,
			size: content.length,
			device_name: this.settings.deviceName,
			user_id: this.userId,
		});
		if (error) throw error;
	}

	async listDeleted(): Promise<{ path: string; updated_at: string; device_name?: string | null }[]> {
		const cols = this.legacySchema ? "path,updated_at" : "path,updated_at,device_name";
		const { data, error } = await this.client
			.from(DB_TABLE)
			.select(cols)
			.eq("vault_id", this.settings.vaultId)
			.eq("deleted", true)
			.eq("is_binary", false)
			.order("updated_at", { ascending: false })
			.limit(300);
		if (error) throw error;
		return ((data ?? []) as unknown as { path: string; updated_at: string; device_name?: string | null }[]).filter(
			(r) => !this.shouldSkip(r.path) && !this.vault.getAbstractFileByPath(r.path),
		);
	}

	async restoreDeleted(path: string): Promise<string> {
		const content = await this.fetchContent(toRowId(this.settings.vaultId, path));
		let target = path;
		if (this.vault.getAbstractFileByPath(target)) target = conflictPath(path, "restored");
		await this.writeText(target, content);
		return target;
	}

	stop(): void {
		this.stopRealtime();
		this.stopConfigWatcher();
		this.stopAutoSync();
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
		this.schemaChecked = false;
		void this.state.flush();
	}
}
