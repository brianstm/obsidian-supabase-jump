import { Notice, TFile, Vault } from "obsidian";
import { SupabaseClient } from "@supabase/supabase-js";
import { isBinary, isExcluded } from "./settings";
import { parseFrontmatter } from "./frontmatter";
import { SyncStatus } from "./supabase";

const STORAGE_BUCKET = "vault-attachments";
const DB_TABLE = "vault_files";
const DEBOUNCE_MS = 1000;
const PULL_IGNORE_TTL = 1500;
const CONFIG_WATCH_MS = 5000;
const REALTIME_RECONNECT_MS = 5000;

function toStoragePath(
	userId: string,
	vaultId: string,
	filePath: string,
): string {
	const bytes = new TextEncoder().encode(filePath);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	const b64url = btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=/g, "");

	const dotIdx = filePath.lastIndexOf(".");
	const ext =
		dotIdx >= 0
			? filePath.slice(dotIdx).replace(/[^a-zA-Z0-9.]/g, "_")
			: "";

	return `${userId}/${vaultId}/${b64url}${ext}`;
}

export interface VaultFileRow {
	id: string;
	user_id: string;
	vault_id: string;
	path: string;
	content: string | null;
	is_binary: boolean;
	storage_path: string | null;
	frontmatter: Record<string, unknown> | null;
	tags: string[] | null;
	mtime: number;
	ctime: number;
	size: number;
	deleted: boolean;
	updated_at: string;
}

export interface SyncHost {
	readonly vault: Vault;
	/** Settings object - properties are mutated in-place across saves. */
	readonly settings: {
		vaultId: string;
		syncOnStartup: boolean;
		syncConfigFolder: boolean;
		syncIntervalMinutes: number;
		excludedFolders: string[];
		lastSyncTime: number;
	};
	readonly supabase: SupabaseClient | null;
	saveSettings(): Promise<void>;
	setStatus(status: SyncStatus): void;
}

function toRowId(vaultId: string, filePath: string): string {
	return `${vaultId}::${filePath.replace(/\//g, "__SLASH__")}`;
}

export class SyncEngine {
	private host: SyncHost;
	private changeQueue = new Map<string, "push" | "delete">();
	private flushTimer: number | null = null;
	private syncIntervalId: number | null = null;
	private configWatcherId: number | null = null;
	private configFileCache = new Map<string, number>();
	private ignorePaths = new Set<string>();
	private realtimeReconnectTimer: number | null = null;

	constructor(host: SyncHost) {
		this.host = host;
	}

	private get client(): SupabaseClient {
		const { supabase } = this.host;
		if (!supabase) throw new Error("Supabase jump: Not Connected.");
		return supabase;
	}

	private async getUserId(): Promise<string> {
		const { data, error } = await this.client.auth.getUser();
		if (error || !data.user)
			throw new Error("Supabase jump: Not Authenticated.");
		return data.user.id;
	}

	private shouldSkip(filePath: string): boolean {
		if (
			!this.host.settings.syncConfigFolder &&
			(filePath === this.host.vault.configDir ||
				filePath.startsWith(this.host.vault.configDir + "/"))
		) {
			return true;
		}
		return isExcluded(filePath, this.host.settings.excludedFolders);
	}

	private async listAdapterFiles(folderPath: string): Promise<string[]> {
		const result: string[] = [];
		try {
			const listed = await this.host.vault.adapter.list(folderPath);
			result.push(...listed.files);
			for (const sub of listed.folders) {
				result.push(...(await this.listAdapterFiles(sub)));
			}
		} catch {
			// folder doesn't exist or not accessible
		}
		return result;
	}

	private async pushAdapterFile(
		filePath: string,
		userId: string,
		vaultId: string,
	): Promise<void> {
		const stat = await this.host.vault.adapter.stat(filePath);
		if (!stat || stat.type !== "file") return;

		const rowId = toRowId(vaultId, filePath);

		if (isBinary(filePath)) {
			const data = await this.host.vault.adapter.readBinary(filePath);
			const storagePath = toStoragePath(userId, vaultId, filePath);

			const { error: uploadErr } = await this.client.storage
				.from(STORAGE_BUCKET)
				.upload(storagePath, data, { upsert: true });
			if (uploadErr)
				throw new Error(`Storage upload failed - ${uploadErr.message}`);

			const { error: dbErr } = await this.client.from(DB_TABLE).upsert({
				id: rowId,
				user_id: userId,
				vault_id: vaultId,
				path: filePath,
				is_binary: true,
				storage_path: storagePath,
				content: null,
				mtime: stat.mtime,
				ctime: stat.ctime ?? stat.mtime,
				size: stat.size ?? 0,
				deleted: false,
				updated_at: new Date().toISOString(),
			});
			if (dbErr)
				throw new Error(`Metadata upsert failed - ${dbErr.message}`);
		} else {
			const content = await this.host.vault.adapter.read(filePath);

			const isMarkdown = filePath.endsWith(".md");
			const { properties, tags } = isMarkdown
				? parseFrontmatter(content)
				: { properties: {}, tags: [] };

			const { error } = await this.client.from(DB_TABLE).upsert({
				id: rowId,
				user_id: userId,
				vault_id: vaultId,
				path: filePath,
				is_binary: false,
				storage_path: null,
				content,
				frontmatter:
					Object.keys(properties).length > 0 ? properties : null,
				tags: tags.length > 0 ? tags : null,
				mtime: stat.mtime,
				ctime: stat.ctime ?? stat.mtime,
				size: stat.size ?? 0,
				deleted: false,
				updated_at: new Date().toISOString(),
			});
			if (error) throw new Error(`Upsert failed - ${error.message}`);
		}
	}

	private markIgnore(path: string): void {
		this.ignorePaths.add(path);
		window.setTimeout(() => this.ignorePaths.delete(path), PULL_IGNORE_TTL);
	}

	async ensureFolder(filePath: string): Promise<void> {
		const segments = filePath.split("/");
		segments.pop();

		let current = "";
		for (const segment of segments) {
			current = current ? `${current}/${segment}` : segment;
			if (!this.host.vault.getAbstractFileByPath(current)) {
				try {
					await this.host.vault.createFolder(current);
				} catch {
					// Folder already exists
				}
			}
		}
	}

	async pushFile(file: TFile): Promise<void> {
		const { vaultId } = this.host.settings;
		const userId = await this.getUserId();
		const rowId = toRowId(vaultId, file.path);

		try {
			if (isBinary(file.path)) {
				await this.pushBinaryFile(file, userId, vaultId, rowId);
			} else {
				await this.pushTextFile(file, userId, vaultId, rowId);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(
				`Supabase jump: pushFile failed for "${file.path}"`,
				err,
			);
		new Notice(
			`Supabase jump: Push failed for "${file.path}" - ${msg}`,
		);
			throw err; // re-throw so fullSync can count errors
		}
	}

	private async pushBinaryFile(
		file: TFile,
		userId: string,
		vaultId: string,
		rowId: string,
	): Promise<void> {
		let data: ArrayBuffer;
		try {
			data = await this.host.vault.readBinary(file);
		} catch (err) {
			throw new Error(
				`Could not read "${file.path}" - ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const storagePath = toStoragePath(userId, vaultId, file.path);

		const { error: uploadErr } = await this.client.storage
			.from(STORAGE_BUCKET)
			.upload(storagePath, data, { upsert: true });

		if (uploadErr)
			throw new Error(`Storage upload failed - ${uploadErr.message}`);

		const { error: dbErr } = await this.client.from(DB_TABLE).upsert({
			id: rowId,
			user_id: userId,
			vault_id: vaultId,
			path: file.path,
			is_binary: true,
			storage_path: storagePath,
			content: null,
			mtime: file.stat.mtime,
			ctime: file.stat.ctime ?? file.stat.mtime,
			size: file.stat.size ?? 0,
			deleted: false,
			updated_at: new Date().toISOString(),
		});

		if (dbErr) throw new Error(`Metadata upsert failed - ${dbErr.message}`);
	}

	private async pushTextFile(
		file: TFile,
		userId: string,
		vaultId: string,
		rowId: string,
	): Promise<void> {
		let content: string;
		try {
			content = await this.host.vault.read(file);
		} catch (err) {
			throw new Error(
				`could not read "${file.path}" - ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		const isMarkdown = file.path.endsWith(".md");
		const { properties, tags } = isMarkdown
			? parseFrontmatter(content)
			: { properties: {}, tags: [] };

		const { error } = await this.client.from(DB_TABLE).upsert({
			id: rowId,
			user_id: userId,
			vault_id: vaultId,
			path: file.path,
			is_binary: false,
			storage_path: null,
			content,
			frontmatter: Object.keys(properties).length > 0 ? properties : null,
			tags: tags.length > 0 ? tags : null,
			mtime: file.stat.mtime,
			ctime: file.stat.ctime ?? file.stat.mtime,
			size: file.stat.size ?? 0,
			deleted: false,
			updated_at: new Date().toISOString(),
		});

		if (error) throw new Error(`Upsert failed - ${error.message}`);
	}

	async pullFile(row: VaultFileRow): Promise<void> {
		try {
			await this.ensureFolder(row.path);

			if (row.is_binary) {
				await this.pullBinaryFile(row);
			} else {
				await this.pullTextFile(row);
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(
				`Supabase jump: pullFile failed for "${row.path}"`,
				err,
			);
			new Notice(`Supabase jump: Pull failed for "${row.path}" - ${msg}`);
			throw err; // re-throw so fullSync can count errors
		}
	}

	private async pullBinaryFile(row: VaultFileRow): Promise<void> {
		if (!row.storage_path) {
			throw new Error(`missing storage_path for "${row.path}"`);
		}

		const { data, error } = await this.client.storage
			.from(STORAGE_BUCKET)
			.download(row.storage_path);

		if (error || !data) {
			throw new Error(
				`storage download failed - ${error?.message ?? "no data returned"}`,
			);
		}

		const buffer = await data.arrayBuffer();
		this.markIgnore(row.path);

		const live = this.host.vault.getAbstractFileByPath(row.path);
		try {
			if (live instanceof TFile) {
				await this.host.vault.modifyBinary(live, buffer);
			} else {
				await this.host.vault.createBinary(row.path, buffer);
			}
		} catch {
			try {
				await this.host.vault.createBinary(row.path, buffer);
			} catch {
				// Final fallback for paths outside vault index (e.g., .obsidian/)
				await this.host.vault.adapter.writeBinary(row.path, buffer);
			}
		}
	}

	private async pullTextFile(row: VaultFileRow): Promise<void> {
		const content = row.content ?? "";
		this.markIgnore(row.path);

		const live = this.host.vault.getAbstractFileByPath(row.path);
		try {
			if (live instanceof TFile) {
				await this.host.vault.modify(live, content);
			} else {
				await this.host.vault.create(row.path, content);
			}
		} catch {
			try {
				await this.host.vault.create(row.path, content);
			} catch {
				// Final fallback for paths outside vault index (e.g., .obsidian/)
				await this.host.vault.adapter.write(row.path, content);
			}
		}
	}

	async deleteRemoteFile(path: string): Promise<void> {
		try {
			const { vaultId } = this.host.settings;
			const rowId = toRowId(vaultId, path);

			const { data, error: fetchErr } = await this.client
				.from(DB_TABLE)
				.select("is_binary, storage_path")
				.eq("id", rowId)
				.single<Pick<VaultFileRow, "is_binary" | "storage_path">>();

			if (fetchErr)
				throw new Error(
					`could not fetch row for "${path}" - ${fetchErr.message}`,
				);

			const { error: updateErr } = await this.client
				.from(DB_TABLE)
				.update({ deleted: true, updated_at: new Date().toISOString() })
				.eq("id", rowId);

			if (updateErr)
				throw new Error(`soft delete failed - ${updateErr.message}`);

			if (data?.is_binary && data.storage_path) {
				const { error: storageErr } = await this.client.storage
					.from(STORAGE_BUCKET)
					.remove([data.storage_path]);

				if (storageErr) {
					console.warn(
						`Supabase jump: Storage removal failed - ${storageErr.message}`,
					);
				}
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error(
				`Supabase jump: deleteRemoteFile failed for "${path}"`,
				err,
			);
			new Notice(`Supabase jump: Delete failed for "${path}" - ${msg}`);
			throw err;
		}
	}

	async fetchOnly(): Promise<void> {
		const { vaultId } = this.host.settings;

	if (!vaultId) {
		new Notice("Supabase jump: vault ID is not set - cannot fetch");
		return;
	}

		this.host.setStatus("syncing");
		const errors: string[] = [];

		try {
			const { data, error } = await this.client
				.from(DB_TABLE)
				.select("*")
				.eq("vault_id", vaultId)
				.eq("deleted", false);

			if (error)
				throw new Error(
					`failed to fetch remote files - ${error.message}`,
				);

			const remoteRows = (data as VaultFileRow[]) ?? [];
			const localMap = new Map<string, TFile>(
				this.host.vault
					.getFiles()
					.filter((f) => !this.shouldSkip(f.path))
					.map((f) => [f.path, f]),
			);

			for (const row of remoteRows) {
				if (this.shouldSkip(row.path)) continue;
				const local = localMap.get(row.path);
				if (!local || row.mtime > local.stat.mtime) {
					try {
						await this.pullFile(row);
					} catch {
						errors.push(row.path);
					}
				}
			}

			this.host.settings.lastSyncTime = Date.now();
			await this.host.saveSettings();
			this.host.setStatus("synced");

			const s = errors.length;
			const suffix =
				s > 0 ? ` (${s} error${s > 1 ? "s" : ""} - see console)` : "";
			new Notice(`Supabase jump: Fetch complete${suffix}`);
		} catch (err) {
			console.error("Supabase jump: fetchOnly failed", err);
			this.host.setStatus("error");
		new Notice(
			`Supabase jump: Fetch failed - ${err instanceof Error ? err.message : String(err)}`,
		);
		}
	}

	async fullSync(): Promise<void> {
		const { vaultId } = this.host.settings;

	if (!vaultId) {
		new Notice("Supabase jump: vault ID is not set - cannot sync");
		return;
	}

		this.host.setStatus("syncing");
		const errors: string[] = [];

		try {
			const { data, error } = await this.client
				.from(DB_TABLE)
				.select("*")
				.eq("vault_id", vaultId)
				.eq("deleted", false);

			if (error)
				throw new Error(
					`failed to fetch remote files - ${error.message}`,
				);

			const remoteRows = (data as VaultFileRow[]) ?? [];
			const remoteMap = new Map<string, VaultFileRow>(
				remoteRows.map((r) => [r.path, r]),
			);

			const localFiles = this.host.vault
				.getFiles()
				.filter((f) => !this.shouldSkip(f.path));
			const localMap = new Map<string, TFile>(
				localFiles.map((f) => [f.path, f]),
			);

			for (const file of localFiles) {
				const remote = remoteMap.get(file.path);
				if (!remote || file.stat.mtime > remote.mtime) {
					try {
						await this.pushFile(file);
					} catch {
						errors.push(file.path);
					}
				}
			}

			// Push config files that vault.getFiles() does not enumerate
			const configPaths = await this.listAdapterFiles(
				this.host.vault.configDir,
			);
			if (configPaths.length > 0) {
				const userId = await this.getUserId();
				for (const configPath of configPaths) {
					if (this.shouldSkip(configPath)) continue;
					const stat =
						await this.host.vault.adapter.stat(configPath);
					if (!stat || stat.type !== "file") continue;
					const remote = remoteMap.get(configPath);
					if (!remote || stat.mtime > remote.mtime) {
						try {
							await this.pushAdapterFile(
								configPath,
								userId,
								vaultId,
							);
						} catch {
							errors.push(configPath);
						}
					}
				}
			}

			for (const row of remoteRows) {
				if (this.shouldSkip(row.path)) continue;
				const local = localMap.get(row.path);
				if (!local || row.mtime > local.stat.mtime) {
					try {
						await this.pullFile(row);
					} catch {
						errors.push(row.path);
					}
				}
			}

			this.host.settings.lastSyncTime = Date.now();
			await this.host.saveSettings();

			this.host.setStatus("synced");

			const s = errors.length;
			const suffix =
				s > 0 ? ` (${s} error${s > 1 ? "s" : ""} - see console)` : "";
			new Notice(`Supabase jump: Sync complete${suffix}`);
		} catch (err) {
			console.error("Supabase jump: FullSync failed", err);
			this.host.setStatus("error");
		new Notice(
			`Supabase jump: Sync failed - ${err instanceof Error ? err.message : String(err)}`,
		);
		}
	}

	startRealtimeListener(): void {
		const { vaultId } = this.host.settings;
		if (!vaultId) return;

		this.client
			.channel(`vault-${vaultId}`)
			.on<VaultFileRow>(
				"postgres_changes",
				{
					event: "*",
					schema: "public",
					table: DB_TABLE,
					filter: `vault_id=eq.${vaultId}`,
				},
				(payload) => {
					this.handleRealtimeEvent(payload).catch((err) => {
						console.error(
							"Supabase jump: Realtime handler error",
							err,
						);
						new Notice(
							`Supabase jump: Realtime handler error - ${err instanceof Error ? err.message : String(err)}`,
						);
					});
				},
			)
			.subscribe((status: string) => {
				if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
					console.error(
						`Supabase jump: Realtime channel ${status.toLowerCase()} — reconnecting in ${REALTIME_RECONNECT_MS / 1000}s`,
					);
					this.host.setStatus("error");
					new Notice(
						`Supabase jump: Realtime disconnected - reconnecting in ${REALTIME_RECONNECT_MS / 1000}s…`,
					);
					if (this.realtimeReconnectTimer !== null) return;
					this.realtimeReconnectTimer = window.setTimeout(() => {
						this.realtimeReconnectTimer = null;
						if (!this.client) return;
						void this.client.removeAllChannels().then(() => {
							this.startRealtimeListener();
						});
					}, REALTIME_RECONNECT_MS);
				} else if (status === "SUBSCRIBED") {
					this.host.setStatus("synced");
				}
			});
	}

	private async handleRealtimeEvent(payload: {
		eventType: string;
		new: Partial<VaultFileRow>;
		old: Partial<VaultFileRow>;
	}): Promise<void> {
		const { eventType, new: newRow, old: oldRow } = payload;

		if (eventType === "DELETE") {
			const path = oldRow.path;
			if (path) await this.deleteLocalFile(path);
			return;
		}

		const row = newRow as VaultFileRow;
		if (!row?.path) return;

		if (row.deleted) {
			await this.deleteLocalFile(row.path);
			return;
		}

		const localFile = this.host.vault.getAbstractFileByPath(row.path);
		const localMtime =
			localFile instanceof TFile ? localFile.stat.mtime : 0;

		if (row.mtime > localMtime) {
			await this.pullFile(row);
		}
	}

	private async deleteLocalFile(path: string): Promise<void> {
		const file = this.host.vault.getAbstractFileByPath(path);
		const targetPath = file?.path ?? path;
		const exists =
			file !== null || (await this.host.vault.adapter.exists(path));
		if (!exists) return;
		this.markIgnore(path);
		try {
			await this.host.vault.adapter.trashLocal(targetPath);
		} catch (err) {
			console.warn(
				`Supabase jump: deleteLocalFile failed for "${path}"`,
				err,
			);
		}
	}

	startConfigWatcher(): void {
		if (this.configWatcherId !== null) return;

		// Warm the cache so we don't push everything on first tick
		this.warmConfigCache().catch(() => {});

		this.configWatcherId = window.setInterval(() => {
			this.pollConfigDir().catch((err) =>
				console.error("Supabase jump: Config watcher error", err),
			);
		}, CONFIG_WATCH_MS);
	}

	private async warmConfigCache(): Promise<void> {
		const paths = await this.listAdapterFiles(this.host.vault.configDir);
		for (const p of paths) {
			const stat = await this.host.vault.adapter.stat(p);
			if (stat?.type === "file") this.configFileCache.set(p, stat.mtime);
		}
	}

	private async pollConfigDir(): Promise<void> {
		const paths = await this.listAdapterFiles(this.host.vault.configDir);
		const seen = new Set<string>();

		for (const p of paths) {
			seen.add(p);
			if (this.ignorePaths.has(p) || this.shouldSkip(p)) continue;
			const stat = await this.host.vault.adapter.stat(p);
			if (!stat || stat.type !== "file") continue;
			const cached = this.configFileCache.get(p);
			if (cached === undefined || stat.mtime > cached) {
				this.configFileCache.set(p, stat.mtime);
				this.queueChange(p, "push");
			}
		}

		for (const [p] of this.configFileCache) {
			if (!seen.has(p)) {
				this.configFileCache.delete(p);
				this.queueChange(p, "delete");
			}
		}
	}

	startAutoSync(): void {
		const { syncIntervalMinutes } = this.host.settings;
		if (syncIntervalMinutes <= 0) return;

		this.syncIntervalId = window.setInterval(
			() => {
				void this.fullSync().catch((err) =>
					console.error("Supabase jump: Auto-sync error", err),
				);
			},
			syncIntervalMinutes * 60 * 1000,
		);
	}

	queueChange(path: string, type: "push" | "delete"): void {
		if (this.shouldSkip(path) || this.ignorePaths.has(path)) return;

		this.changeQueue.set(path, type);

		if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
		this.flushTimer = window.setTimeout(() => {
			this.flushQueue().catch((err) =>
				console.error("Supabase jump: Queue flush error", err),
			);
		}, DEBOUNCE_MS);
	}

	private async flushQueue(): Promise<void> {
		this.flushTimer = null;
		if (!this.host.supabase) return;

		const entries = [...this.changeQueue.entries()];
		this.changeQueue.clear();

		for (const [path, type] of entries) {
			try {
				if (type === "push") {
					const file = this.host.vault.getAbstractFileByPath(path);
					if (file instanceof TFile) {
						await this.pushFile(file);
					} else {
						const userId = await this.getUserId();
						await this.pushAdapterFile(
							path,
							userId,
							this.host.settings.vaultId,
						);
					}
				} else {
					await this.deleteRemoteFile(path);
				}
			} catch {
				// Error already logged
			}
		}
	}

	stopAll(): void {
		if (this.syncIntervalId !== null) {
			window.clearInterval(this.syncIntervalId);
			this.syncIntervalId = null;
		}
		if (this.configWatcherId !== null) {
			window.clearInterval(this.configWatcherId);
			this.configWatcherId = null;
		}
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		if (this.realtimeReconnectTimer !== null) {
			window.clearTimeout(this.realtimeReconnectTimer);
			this.realtimeReconnectTimer = null;
		}
		this.changeQueue.clear();
		this.configFileCache.clear();
		this.ignorePaths.clear();
	}
}
