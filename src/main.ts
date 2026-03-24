import {
	Notice,
	Plugin,
	requestUrl,
	TAbstractFile,
	TFile,
	Vault,
} from "obsidian";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS vault_files (
  id           text primary key,
  vault_id     text not null,
  path         text not null,
  content      text,
  storage_path text,
  is_binary    boolean default false,
  frontmatter  jsonb,
  tags         text[],
  mtime        bigint not null,
  ctime        bigint not null,
  size         bigint not null,
  deleted      boolean default false,
  updated_at   timestamptz default now(),
  user_id      uuid references auth.users(id),
  platform     text default 'all'
);
ALTER TABLE vault_files ADD COLUMN IF NOT EXISTS frontmatter jsonb;
ALTER TABLE vault_files ADD COLUMN IF NOT EXISTS tags text[];
ALTER TABLE vault_files ADD COLUMN IF NOT EXISTS platform text DEFAULT 'all';
CREATE INDEX IF NOT EXISTS vault_files_vault_path ON vault_files(vault_id, path);
CREATE INDEX IF NOT EXISTS vault_files_vault_mtime ON vault_files(vault_id, mtime);
CREATE INDEX IF NOT EXISTS vault_files_tags ON vault_files USING gin(tags);
ALTER TABLE vault_files ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='vault_files' AND policyname='Users manage own vault'
  ) THEN
    CREATE POLICY "Users manage own vault" ON vault_files FOR ALL
      USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname='supabase_realtime' AND tablename='vault_files'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE vault_files;
  END IF;
END $$;
`.trim();

const STORAGE_RLS_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='objects' AND schemaname='storage'
    AND policyname='Users manage own attachments'
  ) THEN
    CREATE POLICY "Users manage own attachments"
      ON storage.objects FOR ALL
      USING (auth.uid()::text = (storage.foldername(name))[1])
      WITH CHECK (auth.uid()::text = (storage.foldername(name))[1]);
  END IF;
END $$;
`.trim();

function extractErrorMessage(body: string, status: number): string {
	try {
		const parsed = JSON.parse(body) as Record<string, unknown>;
		if (typeof parsed.message === "string") return parsed.message;
		if (typeof parsed.error === "string") return parsed.error;
	} catch {
		// Ignore
	}
	return body.trim() || `HTTP ${status}`;
}
import { SupabaseClient } from "@supabase/supabase-js";
import {
	DEFAULT_SETTINGS,
	SupaBaseJumpSettings,
	SupaBaseJumpSettingTab,
} from "./settings";
import { SupabaseManager, SyncStatus } from "./supabase";
import { SyncEngine, VaultFileRow } from "./sync";
import { RealtimeCrdtManager } from "./realtime-crdt";

export default class SupaBaseJumpPlugin extends Plugin {
	settings: SupaBaseJumpSettings;
	statusBarItem: HTMLElement;

	private manager: SupabaseManager;
	private syncEngine: SyncEngine;
	private crdtManager: RealtimeCrdtManager;

	get supabase(): SupabaseClient | null {
		return this.manager.client;
	}

	get vault(): Vault {
		return this.app.vault;
	}

	async onload() {
		await this.loadSettings();

		this.statusBarItem = this.addStatusBarItem();
		this.manager = new SupabaseManager(this);
		this.manager.setStatus("offline");
		this.syncEngine = new SyncEngine(this);
		this.crdtManager = new RealtimeCrdtManager(this);

		this.addSettingTab(new SupaBaseJumpSettingTab(this.app, this));
		this.registerVaultEvents();
		this.registerCommands();

		if (this.settings.supabaseUrl && this.settings.email) {
			await this.initSupabase();
		}
	}

	onunload() {
		this.cleanup();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<SupaBaseJumpSettings>,
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	setStatus(status: SyncStatus): void {
		this.manager.setStatus(status);
	}

	async initSupabase(): Promise<void> {
		this.syncEngine.stopAll();
		this.crdtManager.stop();

		await this.manager.init();

		if (!this.supabase) return; // connection failed - manager already reported error

		this.crdtManager.setSupabase(this.supabase, this.settings.vaultId);
		this.crdtManager.start();

		this.syncEngine.crdtIsActive = (path) =>
			this.crdtManager.isActiveFile(path);

		this.syncEngine.startRealtimeListener();
		this.syncEngine.startConfigWatcher();

		if (this.settings.syncIntervalMinutes > 0) {
			this.syncEngine.startAutoSync();
		}

		if (this.settings.syncOnStartup) {
			this.syncEngine
				.fullSync()
				.catch((err) =>
					console.error("Supabase jump: Startup sync error", err),
				);
		}
	}

	async signIn(): Promise<void> {
		await this.manager.signIn();
	}

	async signOut(): Promise<void> {
		this.syncEngine.stopAll();
		this.crdtManager.stop();
		await this.manager.signOut();
	}

	cleanup(): void {
		this.syncEngine.stopAll();
		this.crdtManager.stop();
		this.manager.cleanup();
	}

	private registerCommands(): void {
		this.addCommand({
			id: "show-sync-status",
			name: "Show sync status",
			callback: () => {
				const label = this.statusBarItem.getText();
				new Notice(`Supabase jump: ${label || "status unavailable"}`);
			},
		});

		this.addCommand({
			id: "force-sync",
			name: "Force sync now",
			callback: () => {
				this.syncEngine
					.fullSync()
					.catch((err) =>
						console.error("Supabase jump: Force sync error", err),
					);
			},
		});

		this.addCommand({
			id: "fetch-now",
			name: "Fetch from database",
			callback: () => {
				this.syncEngine
					.fetchOnly()
					.catch((err) =>
						console.error("Supabase jump: Fetch error", err),
					);
			},
		});
	}

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile) {
					this.syncEngine.queueChange(file.path, "push");
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile) {
					this.syncEngine.queueChange(file.path, "push");
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (file instanceof TFile) {
					this.syncEngine.queueChange(file.path, "delete");
				}
			}),
		);

		this.registerEvent(
			this.app.vault.on(
				"rename",
				(file: TAbstractFile, oldPath: string) => {
					if (file instanceof TFile) {
						this.syncEngine.queueChange(oldPath, "delete");
						this.syncEngine.queueChange(file.path, "push");
					}
				},
			),
		);
	}

	async pushFile(file: TFile): Promise<void> {
		await this.syncEngine.pushFile(file);
	}

	async pullFile(row: VaultFileRow): Promise<void> {
		await this.syncEngine.pullFile(row);
	}

	async deleteRemoteFile(path: string): Promise<void> {
		await this.syncEngine.deleteRemoteFile(path);
	}

	async ensureFolder(filePath: string): Promise<void> {
		await this.syncEngine.ensureFolder(filePath);
	}

	async fullSync(): Promise<void> {
		await this.syncEngine.fullSync();
	}

	async fetchNow(): Promise<void> {
		await this.syncEngine.fetchOnly();
	}

	async initializeSchema(onProgress: (step: number) => void): Promise<void> {
		const { supabaseUrl, personalAccessToken } = this.settings;

		if (!supabaseUrl) throw new Error("Project URL is required.");
		if (!personalAccessToken)
			throw new Error("Personal Access Token is required.");

		const ref = new URL(supabaseUrl).hostname.split(".")[0];

		const headers: Record<string, string> = {
			Authorization: `Bearer ${personalAccessToken}`,
			"Content-Type": "application/json",
		};

		const dbQueryUrl = `https://api.supabase.com/v1/projects/${ref}/database/query`;
		const bucketsUrl = `https://api.supabase.com/v1/projects/${ref}/storage/buckets`;

		const runSQL = async (query: string): Promise<void> => {
			const res = await requestUrl({
				url: dbQueryUrl,
				method: "POST",
				headers,
				body: JSON.stringify({ query }),
				throw: false,
			});
			if (res.status < 200 || res.status >= 300) {
				throw new Error(extractErrorMessage(res.text, res.status));
			}
		};

		onProgress(1);
		try {
			await runSQL(SCHEMA_SQL);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("Supabase jump: Setup step 1 failed", err);
			new Notice(`Setup failed at step 1: ${msg}`, 10000);
			throw err;
		}

		onProgress(2);
		{
			let bucketOk = false;
			try {
				const res = await requestUrl({
					url: bucketsUrl,
					method: "POST",
					headers,
					body: JSON.stringify({
						id: "vault-attachments",
						name: "vault-attachments",
						public: false,
					}),
					throw: false,
				});
				bucketOk =
					res.status === 409 ||
					(res.status >= 200 && res.status < 300);
				if (!bucketOk) {
					const msg = extractErrorMessage(res.text, res.status);
					console.warn(
						"Supabase jump: bucket creation via API failed -",
						msg,
					);
				}
			} catch (err) {
				console.warn(
					"Supabase jump: Bucket creation request failed -",
					err,
				);
			}

			if (!bucketOk) {
				new Notice(
					"Supabase jump: Could not auto-create Storage bucket.\n\n" +
					"Create it manually: Supabase \u2192 Storage \u2192 New bucket\n" +
					"  Name: vault-attachments\n" +
					"  Public: OFF\n\n" +
					"Then continue - The RLS policy was applied in step 3.",
					14000,
				);
			}
		}

		onProgress(3);
		try {
			await runSQL(STORAGE_RLS_SQL);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			console.error("Supabase jump: Setup Step 3 failed", err);
			new Notice(`Setup failed at step 3: ${msg}`, 10000);
			throw err;
		}

		new Notice(
			"Supabase jump: all set - table, bucket, and realtime enabled ✓",
		);
	}
}
