import { Menu, Notice, Plugin, TAbstractFile, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import {
	ACCESS_TOKEN_SECRET_ID,
	DEFAULT_SETTINGS,
	PASSWORD_SECRET_ID,
	SupaBaseJumpSettings,
	defaultDeviceName,
	isBinary,
} from "./settings";
import { SupaBaseJumpSettingTab } from "./settings-tab";
import { Connection, ConnectionState } from "./supabase";
import { SyncEngine } from "./sync";
import { LiveManager } from "./live/manager";
import { liveExtension } from "./live/binding";
import { StatusBar, StatusInfo } from "./status";
import { DeletedFilesModal, HistoryModal } from "./history";
import { SETUP_SQL } from "./schema";
import { errorMessage, randomId } from "./utils";

export default class SupaBaseJumpPlugin extends Plugin {
	settings: SupaBaseJumpSettings = { ...DEFAULT_SETTINGS };
	connection!: Connection;
	sync!: SyncEngine;
	live!: LiveManager;

	private statusBar: StatusBar | null = null;
	private ribbonEl: HTMLElement | null = null;
	private statusTimer: number | null = null;
	private servicesRunning = false;
	private startedOnce = false;
	private settingTab: SupaBaseJumpSettingTab | null = null;

	get pluginDir(): string {
		return this.manifest.dir ?? normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
	}

	async onload(): Promise<void> {
		await this.loadSettings();

		this.connection = new Connection({
			settings: this.settings,
			getPassword: () => this.getPassword(),
		});
		this.sync = new SyncEngine({
			app: this.app,
			settings: this.settings,
			connection: this.connection,
			saveSettings: () => this.saveSettings(),
			onActivity: () => this.queueStatus(),
			pluginDir: this.pluginDir,
		});
		this.live = new LiveManager({
			app: this.app,
			settings: this.settings,
			connection: this.connection,
			sync: this.sync,
			onPeersChanged: () => this.queueStatus(),
		});
		this.sync.live = this.live;

		this.registerEditorExtension(liveExtension(this.live));

		const statusEl = this.addStatusBarItem();
		this.statusBar = new StatusBar(statusEl);
		this.registerDomEvent(statusEl, "click", (evt) => this.openMenu(evt));

		this.ribbonEl = this.addRibbonIcon("refresh-cw", "Supabase jump", (evt) => this.openMenu(evt));
		this.ribbonEl.toggle(this.settings.showRibbonIcon);

		this.settingTab = new SupaBaseJumpSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);
		this.registerCommands();
		this.registerFileMenu();

		this.register(this.connection.onChange((state) => this.onConnectionChange(state)));
		this.renderStatus();

		this.app.workspace.onLayoutReady(() => {
			this.registerVaultEvents();
			this.registerResumeEvents();
			this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.queueStatus()));
			void this.boot();
		});
	}

	onunload(): void {
		this.stopServices();
		this.connection.dispose();
		if (this.statusTimer !== null) window.clearTimeout(this.statusTimer);
	}

	private async boot(): Promise<void> {
		await this.sync.loadState();
		if (this.isConfigured()) await this.connection.connect();
	}

	isConfigured(): boolean {
		const s = this.settings;
		return Boolean(s.supabaseUrl && s.supabaseAnonKey && s.email && this.getPassword());
	}

	async loadSettings(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Partial<SupaBaseJumpSettings>;
		Object.assign(this.settings, DEFAULT_SETTINGS, raw);
		let changed = false;

		if (!this.settings.deviceId) {
			this.settings.deviceId = randomId(16);
			changed = true;
		}
		if (!this.settings.deviceName) {
			this.settings.deviceName = defaultDeviceName();
			changed = true;
		}

		const secrets = this.app.secretStorage;
		if (raw.password) {
			if (!this.settings.passwordSecret) {
				secrets.setSecret(PASSWORD_SECRET_ID, raw.password);
				this.settings.passwordSecret = PASSWORD_SECRET_ID;
			}
			delete this.settings.password;
			changed = true;
		}
		if (raw.personalAccessToken) {
			if (!this.settings.accessTokenSecret) {
				secrets.setSecret(ACCESS_TOKEN_SECRET_ID, raw.personalAccessToken);
				this.settings.accessTokenSecret = ACCESS_TOKEN_SECRET_ID;
			}
			delete this.settings.personalAccessToken;
			changed = true;
		}
		if (this.settings.platformExcludedPaths.includes("workspace.json")) {
			this.settings.platformExcludedPaths = this.settings.platformExcludedPaths.filter((p) => p !== "workspace.json");
			this.settings.syncWorkspace = true;
			changed = true;
		}

		if (changed) await this.saveSettings();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	getPassword(): string {
		const id = this.settings.passwordSecret;
		return id ? (this.app.secretStorage.getSecret(id) ?? "") : "";
	}

	getAccessToken(): string {
		const id = this.settings.accessTokenSecret;
		return id ? (this.app.secretStorage.getSecret(id) ?? "") : "";
	}

	async onSettingChanged(key: string): Promise<void> {
		switch (key) {
			case "vaultId":
				if (this.servicesRunning) {
					this.stopServices();
					await this.sync.loadState();
					this.startServices();
				} else {
					await this.sync.loadState();
				}
				break;
			case "syncIntervalMinutes":
				if (this.servicesRunning) this.sync.startAutoSync();
				break;
			case "syncConfigFolder":
				if (this.servicesRunning) this.sync.startConfigWatcher();
				break;
			case "liveEditing":
			case "deviceName":
				this.live.disable();
				if (this.servicesRunning) this.live.enable();
				break;
			case "showCursors":
			case "showPresence":
				this.live.refreshUi();
				break;
			case "showRibbonIcon":
				this.ribbonEl?.toggle(this.settings.showRibbonIcon);
				break;
		}
		this.queueStatus();
	}

	async connect(): Promise<void> {
		this.stopServices();
		await this.connection.signOut();
		await this.connection.connect(true);
	}

	async signOut(): Promise<void> {
		this.stopServices();
		await this.connection.signOut();
		new Notice("Supabase jump: signed out");
	}

	private onConnectionChange(state: ConnectionState): void {
		if (state === "online") this.startServices();
		else if (state === "signed-out") this.stopServices();
		this.queueStatus();
		this.settingTab?.refresh();
	}

	private startServices(): void {
		if (!this.connection.ready) return;
		if (!this.settings.vaultId) {
			new Notice("Supabase jump: connected. Set a vault ID in settings to start syncing.", 8000);
			return;
		}
		if (this.servicesRunning) {
			this.sync.startRealtime();
			this.live.resync();
			void this.sync.fetchChanges();
			this.sync.scheduleFlush(0);
			return;
		}
		this.servicesRunning = true;
		this.sync.startRealtime();
		this.sync.startConfigWatcher();
		this.sync.startAutoSync();
		this.live.enable();

		const first = !this.startedOnce;
		this.startedOnce = true;
		if (first && this.settings.syncOnStartup) void this.sync.fullSync({ silent: true });
		else void this.sync.fetchChanges();
		this.sync.scheduleFlush(0);
	}

	private stopServices(): void {
		if (!this.servicesRunning) return;
		this.servicesRunning = false;
		this.live.disable();
		this.sync.stop();
	}

	private registerResumeEvents(): void {
		const doc = activeDocument;
		this.registerDomEvent(doc, "visibilitychange", () => {
			if (doc.visibilityState === "visible") void this.onResume();
			else this.connection.pause();
		});
		this.registerDomEvent(window, "online", () => void this.onResume());
		this.registerDomEvent(window, "offline", () => this.connection.markOffline());
		this.registerDomEvent(window, "focus", () => void this.onResume());
	}

	private resumeAt = 0;

	private async onResume(): Promise<void> {
		const now = Date.now();
		if (now - this.resumeAt < 2000) return;
		this.resumeAt = now;
		if (!this.isConfigured()) return;
		await this.connection.resume();
		if (this.connection.ready && this.servicesRunning) {
			this.live.resync();
			await this.sync.resume();
		}
	}

	private registerVaultEvents(): void {
		const { vault } = this.app;
		this.registerEvent(
			vault.on("create", (file: TAbstractFile) => {
				if (file instanceof TFile) this.sync.onLocalCreateOrModify(file.path);
			}),
		);
		this.registerEvent(
			vault.on("modify", (file: TAbstractFile) => {
				if (file instanceof TFile) this.sync.onLocalCreateOrModify(file.path);
			}),
		);
		this.registerEvent(
			vault.on("delete", (file: TAbstractFile) => {
				this.sync.onLocalDelete(file.path, file instanceof TFolder);
			}),
		);
		this.registerEvent(
			vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (file instanceof TFile || file instanceof TFolder) this.sync.onLocalRename(file, oldPath);
			}),
		);
	}

	private queueStatus(): void {
		if (this.statusTimer !== null) return;
		this.statusTimer = window.setTimeout(() => {
			this.statusTimer = null;
			this.renderStatus();
		}, 150);
	}

	private statusInfo(): StatusInfo {
		const state = this.connection?.state ?? "signed-out";
		const active = this.app.workspace.getActiveFile();
		const peers = this.live?.peersFor(active?.path ?? null).map((p) => p.name) ?? [];
		let kind: StatusInfo["kind"];
		if (state === "online") kind = this.sync.busy ? "syncing" : "synced";
		else if (state === "connecting") kind = "connecting";
		else if (state === "offline") kind = "offline";
		else if (state === "error") kind = "error";
		else kind = "signed-out";
		return {
			kind,
			pending: this.sync?.pendingCount ?? 0,
			peers,
			lastSync: this.settings.lastSyncTime,
			realtime: this.sync?.realtimeUp ?? false,
			error: this.connection?.lastError ?? "",
		};
	}

	private renderStatus(): void {
		this.statusBar?.render(this.statusInfo());
	}

	statusText(): string {
		const info = this.statusInfo();
		const parts: string[] = [];
		switch (info.kind) {
			case "synced":
				parts.push("Everything is synced.");
				break;
			case "syncing":
				parts.push("Syncing right now.");
				break;
			case "offline":
				parts.push("You're offline. Changes will upload when you're back online.");
				break;
			case "connecting":
				parts.push("Connecting.");
				break;
			case "error":
				parts.push(`Something went wrong. ${info.error}`);
				break;
			default:
				parts.push("Not connected.");
		}
		if (info.pending > 0) parts.push(`${info.pending} change${info.pending > 1 ? "s" : ""} waiting to upload.`);
		if (info.peers.length > 0) parts.push(`Editing this note with ${info.peers.join(", ")}.`);
		return parts.join(" ");
	}

	private openMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const ready = this.connection.ready;
		menu.addItem((i) => i.setTitle(this.statusText()).setIcon("info").setDisabled(true));
		menu.addSeparator();
		if (ready) {
			menu.addItem((i) => i.setTitle("Sync now").setIcon("refresh-cw").onClick(() => void this.sync.fullSync()));
			menu.addItem((i) =>
				i.setTitle("Check for changes").setIcon("download").onClick(() => void this.sync.fetchChanges({ silent: false })),
			);
			const file = this.app.workspace.getActiveFile();
			if (file && !isBinary(file.path)) {
				menu.addItem((i) => i.setTitle("Version history").setIcon("history").onClick(() => this.openHistory(file)));
			}
			menu.addItem((i) => i.setTitle("Restore a deleted note").setIcon("archive-restore").onClick(() => void this.openDeleted()));
		}
		menu.addItem((i) =>
			i
				.setTitle(ready ? "Reconnect" : "Connect")
				.setIcon("plug")
				.onClick(() => void this.connect()),
		);
		menu.showAtMouseEvent(evt);
	}

	private registerCommands(): void {
		this.addCommand({
			id: "show-sync-status",
			name: "Show sync status",
			callback: () => new Notice(`Supabase jump: ${this.statusText()}`),
		});
		this.addCommand({
			id: "force-sync",
			name: "Sync now",
			callback: () => void this.sync.fullSync(),
		});
		this.addCommand({
			id: "fetch-now",
			name: "Check for changes",
			callback: () => void this.sync.fetchChanges({ silent: false }),
		});
		this.addCommand({
			id: "file-history",
			name: "Show version history of this note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || isBinary(file.path) || !this.connection.ready) return false;
				if (!checking) this.openHistory(file);
				return true;
			},
		});
		this.addCommand({
			id: "restore-deleted",
			name: "Restore a deleted note",
			checkCallback: (checking) => {
				if (!this.connection.ready) return false;
				if (!checking) void this.openDeleted();
				return true;
			},
		});
		this.addCommand({
			id: "reconnect",
			name: "Reconnect",
			callback: () => void this.connect(),
		});
		this.addCommand({
			id: "copy-setup-sql",
			name: "Copy database setup SQL",
			callback: () => void this.copySetupSql(),
		});
	}

	private registerFileMenu(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!(file instanceof TFile) || isBinary(file.path) || !this.connection.ready) return;
				menu.addItem((i) =>
					i
						.setTitle("Version history")
						.setIcon("history")
						.setSection("info")
						.onClick(() => this.openHistory(file)),
				);
			}),
		);
	}

	openHistory(file: TFile): void {
		new HistoryModal(this.app, this.sync, file).open();
	}

	async openDeleted(): Promise<void> {
		try {
			const rows = await this.sync.listDeleted();
			new DeletedFilesModal(this.app, this.sync, rows).open();
		} catch (err) {
			new Notice(`Supabase jump: could not load deleted notes. ${errorMessage(err)}`);
		}
	}

	async copySetupSql(): Promise<void> {
		await navigator.clipboard.writeText(SETUP_SQL);
		new Notice("Setup SQL copied. Paste it into the Supabase SQL editor and run it.");
	}

	async runSetup(): Promise<void> {
		const token = this.getAccessToken();
		const url = this.settings.supabaseUrl;
		if (!url) throw new Error("Add your project URL first.");
		if (!token) throw new Error("Add a personal access token first.");

		let host: string;
		try {
			host = new URL(url).hostname;
		} catch {
			throw new Error("The project URL doesn't look right.");
		}
		if (!host.endsWith(".supabase.co")) {
			throw new Error("One-click setup only works with projects on supabase.com. Copy the setup SQL and run it in your SQL editor instead.");
		}
		const ref = host.split(".")[0];

		const res = await requestUrl({
			url: `https://api.supabase.com/v1/projects/${ref}/database/query`,
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			body: JSON.stringify({ query: SETUP_SQL }),
			throw: false,
		});
		if (res.status < 200 || res.status >= 300) {
			let msg = res.text.trim() || `HTTP ${res.status}`;
			try {
				const parsed = JSON.parse(res.text) as { message?: unknown; error?: unknown };
				if (typeof parsed.message === "string") msg = parsed.message;
				else if (typeof parsed.error === "string") msg = parsed.error;
			} catch {
				// keep the raw text
			}
			throw new Error(msg);
		}
		this.sync.resetSchemaCheck();
	}
}
