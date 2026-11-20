import { App, ButtonComponent, Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import type SupaBaseJumpPlugin from "./main";
import { WELL_KNOWN_PLATFORM_PATHS, parseList } from "./settings";
import { errorMessage, randomId, timeAgo } from "./utils";

const PLATFORM_PREFIX = "platform:";

export class SupaBaseJumpSettingTab extends PluginSettingTab {
	private vaultIdTimer: number | null = null;

	constructor(
		app: App,
		private plugin: SupaBaseJumpPlugin,
	) {
		super(app, plugin);
		this.icon = "cloud";
	}

	refresh(): void {
		try {
			this.refreshDomState();
		} catch {
			// tab isn't open
		}
	}

	getControlValue(key: string): unknown {
		const s = this.plugin.settings;
		if (key === "excludedFolders") return s.excludedFolders.join("\n");
		if (key === "customPlatformPaths") {
			return s.platformExcludedPaths
				.filter((p) => !WELL_KNOWN_PLATFORM_PATHS.some((w) => w.path === p))
				.join("\n");
		}
		if (key.startsWith(PLATFORM_PREFIX)) {
			return s.platformExcludedPaths.includes(key.slice(PLATFORM_PREFIX.length));
		}
		return (s as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const s = this.plugin.settings;
		if (key === "excludedFolders") {
			s.excludedFolders = parseList(String(value));
		} else if (key === "customPlatformPaths") {
			const known = s.platformExcludedPaths.filter((p) => WELL_KNOWN_PLATFORM_PATHS.some((w) => w.path === p));
			s.platformExcludedPaths = [...known, ...parseList(String(value))];
		} else if (key.startsWith(PLATFORM_PREFIX)) {
			const path = key.slice(PLATFORM_PREFIX.length);
			const rest = s.platformExcludedPaths.filter((p) => p !== path);
			s.platformExcludedPaths = value === true ? [...rest, path] : rest;
		} else {
			const record = s as unknown as Record<string, unknown>;
			const trim = key === "supabaseUrl" || key === "supabaseAnonKey" || key === "email";
			record[key] = trim && typeof value === "string" ? value.trim() : value;
		}
		await this.plugin.saveSettings();
		await this.plugin.onSettingChanged(key);
		this.refresh();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const plugin = this.plugin;
		const s = plugin.settings;

		return [
			{
				type: "group",
				heading: "Connection",
				items: [
					{
						name: "Status",
						searchable: false,
						render: (setting) => this.renderStatus(setting),
					},
					{
						name: "Project URL",
						desc: "Looks like https://abcd.supabase.co. You can find it in your Supabase project settings under API.",
						control: { type: "text", key: "supabaseUrl", placeholder: "https://xxxx.supabase.co" },
					},
					{
						name: "Anon key",
						desc: "The public anon key from the same page. It is safe to use here because row level security keeps your notes private.",
						aliases: ["api key", "public key"],
						control: { type: "text", key: "supabaseAnonKey", placeholder: "eyJhbGciOi…" },
					},
					{
						name: "Email",
						desc: "The account your notes belong to. Use the same one on all your devices.",
						control: { type: "text", key: "email", placeholder: "you@example.com" },
					},
					{
						name: "Password",
						desc: "Kept in Obsidian's secret storage on this device, not in the plugin's data file.",
						control: { type: "secret", key: "passwordSecret" },
					},
					{
						name: "Connect",
						desc: "Sign in with the details above. If there is no account yet, one is created for you.",
						render: (setting) => {
							setting
								.addButton((btn) =>
									btn
										.setButtonText(plugin.connection.ready ? "Reconnect" : "Connect")
										.setCta()
										.onClick(async () => {
											btn.setButtonText("Connecting…").setDisabled(true);
											try {
												await plugin.connect();
											} finally {
												btn.setButtonText(plugin.connection.ready ? "Reconnect" : "Connect").setDisabled(false);
											}
										}),
								)
								.addButton((btn) =>
									btn.setButtonText("Sign out").onClick(async () => {
										await plugin.signOut();
									}),
								);
						},
					},
				],
			},
			{
				type: "group",
				heading: "Database setup",
				items: [
					{
						name: "Personal access token",
						desc: "Only needed for the one-click setup below. Create one at supabase.com/dashboard/account/tokens. You can delete it afterwards.",
						aliases: ["pat", "management token"],
						control: { type: "secret", key: "accessTokenSecret" },
					},
					{
						name: "One-click setup",
						desc: "Creates the table, the attachments bucket, version history and the security rules. Safe to run again after updating the plugin.",
						render: (setting) => {
							setting.addButton((btn) =>
								btn
									.setButtonText("Run setup")
									.setCta()
									.onClick(async () => {
										btn.setButtonText("Setting up…").setDisabled(true);
										try {
											await plugin.runSetup();
											new Notice("Supabase jump: database is ready");
										} catch (err) {
											new Notice(`Supabase jump: setup failed. ${errorMessage(err)}`, 12000);
										} finally {
											btn.setButtonText("Run setup").setDisabled(false);
										}
									}),
							);
						},
					},
					{
						name: "Set it up by hand",
						desc: "For self-hosted Supabase, or if you'd rather not create a token. Copy the SQL and run it in the SQL editor of your project.",
						aliases: ["sql", "self hosted"],
						render: (setting) => {
							setting.addButton((btn) =>
								btn.setButtonText("Copy SQL").onClick(() => void plugin.copySetupSql()),
							);
						},
					},
				],
			},
			{
				type: "group",
				heading: "This vault",
				items: [
					{
						name: "Vault ID",
						desc: "Use the same ID on every device that should share this vault. Each different vault needs its own ID.",
						render: (setting) => this.renderVaultId(setting),
					},
					{
						name: "Device name",
						desc: "Shown to your other devices when you edit the same note, and in version history.",
						control: { type: "text", key: "deviceName", placeholder: "My laptop" },
					},
				],
			},
			{
				type: "group",
				heading: "Syncing",
				items: [
					{
						name: "Sync when Obsidian opens",
						desc: "Do a full check of every file at startup. Changes made while Obsidian is open are always synced right away.",
						control: { type: "toggle", key: "syncOnStartup" },
					},
					{
						name: "Full check every",
						desc: "A background safety net that compares everything. Set to 0 to turn it off.",
						control: {
							type: "slider",
							key: "syncIntervalMinutes",
							min: 0,
							max: 60,
							step: 1,
							displayFormat: (v) => (v === 0 ? "Off" : `${v} min`),
						},
					},
					{
						name: "When a note changed on two devices",
						desc: "Keeping both is the safest. The other version is saved next to the note so nothing gets lost.",
						aliases: ["conflict"],
						control: {
							type: "dropdown",
							key: "conflictMode",
							options: { "keep-both": "Keep both versions", newest: "Keep the newest one" },
						},
					},
					{
						name: "Largest file to sync (MB)",
						desc: "Bigger files are skipped. The free Supabase plan allows up to 50 MB per file. Set to 0 for no limit.",
						control: { type: "number", key: "maxFileSizeMB", min: 0, placeholder: "50" },
					},
					{
						name: "Folders to skip",
						desc: "One folder per line, for example Templates or Archive/old.",
						aliases: ["exclude", "ignore"],
						control: { type: "textarea", key: "excludedFolders", placeholder: "Templates\nArchive/old", rows: 3 },
					},
				],
			},
			{
				type: "group",
				heading: "Live editing",
				items: [
					{
						name: "Live editing",
						desc: "When the same note is open on two devices, typing shows up on the other one right away, like Google Docs.",
						aliases: ["collaboration", "realtime", "crdt"],
						control: { type: "toggle", key: "liveEditing" },
					},
					{
						name: "Show other cursors",
						desc: "See where your other devices are typing.",
						visible: () => s.liveEditing,
						control: { type: "toggle", key: "showCursors" },
					},
					{
						name: "Show who is here",
						desc: "Small badges in the corner of a note for each device that has it open.",
						visible: () => s.liveEditing,
						control: { type: "toggle", key: "showPresence" },
					},
				],
			},
			{
				type: "group",
				heading: "Obsidian settings folder",
				items: [
					{
						name: "Sync settings, themes and plugins",
						desc: "Keeps your Obsidian setup the same on every device.",
						aliases: ["config", "obsidian folder"],
						control: { type: "toggle", key: "syncConfigFolder" },
					},
					{
						name: "Sync open tabs and layout",
						desc: "Usually best left off, otherwise your tabs jump around when you switch devices.",
						aliases: ["workspace"],
						visible: () => s.syncConfigFolder,
						control: { type: "toggle", key: "syncWorkspace" },
					},
					{
						type: "page",
						name: "Keep separate for phone and computer",
						desc: "Pick settings that should stay different on mobile and desktop.",
						displayValue: () => {
							const n = s.platformExcludedPaths.length;
							return n === 0 ? "None" : `${n} selected`;
						},
						items: [
							{
								type: "group",
								heading: "Separate on phone and computer",
								items: [
									...WELL_KNOWN_PLATFORM_PATHS.map((w) => ({
										name: w.label,
										desc: w.desc,
										control: { type: "toggle" as const, key: `${PLATFORM_PREFIX}${w.path}` },
									})),
									{
										name: "Other paths",
										desc: "One per line, relative to the settings folder, for example plugins/dataview/.",
										control: { type: "textarea", key: "customPlatformPaths", rows: 3 },
									},
								],
							},
						],
					},
				],
			},
			{
				type: "group",
				heading: "Tools",
				items: [
					{
						name: "Show sync button in the ribbon",
						desc: "Handy on mobile where there is no status bar.",
						control: { type: "toggle", key: "showRibbonIcon" },
					},
					{
						name: "Sync now",
						desc: "Compare every file with the cloud and fix anything that is out of date.",
						disabled: () => !plugin.connection.ready,
						action: () => void plugin.sync.fullSync(),
					},
					{
						name: "Restore a deleted note",
						desc: "Bring back notes that were deleted on any of your devices.",
						disabled: () => !plugin.connection.ready,
						action: () => void plugin.openDeleted(),
					},
				],
			},
		];
	}

	private renderStatus(setting: Setting): () => void {
		const update = () => {
			const conn = this.plugin.connection;
			let text: string;
			switch (conn.state) {
				case "online":
					text = `Connected as ${this.plugin.settings.email}.`;
					break;
				case "connecting":
					text = "Connecting…";
					break;
				case "offline":
					text = "Offline. It will reconnect by itself when the network is back.";
					break;
				case "error":
					text = `Not connected. ${conn.lastError}`;
					break;
				default:
					text = "Not connected yet.";
			}
			const last = this.plugin.settings.lastSyncTime;
			if (last > 0) text += ` Last full sync ${timeAgo(last)}.`;
			setting.setDesc(text);
		};
		update();
		return this.plugin.connection.onChange(update);
	}

	private renderVaultId(setting: Setting): void {
		const plugin = this.plugin;
		setting.addText((text) => {
			text.setPlaceholder("my-vault")
				.setValue(plugin.settings.vaultId)
				.onChange((value) => {
					if (this.vaultIdTimer !== null) window.clearTimeout(this.vaultIdTimer);
					this.vaultIdTimer = window.setTimeout(() => {
						this.vaultIdTimer = null;
						void this.setControlValue("vaultId", value);
					}, 1000);
				});
			let armed = false;
			setting.addButton((btn: ButtonComponent) =>
				btn
					.setButtonText("Generate")
					.setTooltip("Make a new random ID")
					.onClick(async () => {
						if (plugin.settings.vaultId && !armed) {
							armed = true;
							btn.setButtonText("Replace it?");
							window.setTimeout(() => {
								armed = false;
								btn.setButtonText("Generate");
							}, 4000);
							return;
						}
						armed = false;
						btn.setButtonText("Generate");
						const id = randomId(12);
						text.setValue(id);
						await this.setControlValue("vaultId", id);
						new Notice("Supabase jump: new vault ID created");
					}),
			);
			setting.addExtraButton((btn) =>
				btn
					.setIcon("copy")
					.setTooltip("Copy vault ID")
					.onClick(() => {
						void navigator.clipboard.writeText(plugin.settings.vaultId).then(() => new Notice("Vault ID copied"));
					}),
			);
		});
	}
}
