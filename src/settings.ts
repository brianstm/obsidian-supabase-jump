import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TextComponent,
} from "obsidian";

export interface SupaBaseJumpSettings {
	supabaseUrl: string;
	supabaseAnonKey: string;
	personalAccessToken: string;
	email: string;
	password: string;
	vaultId: string;
	syncOnStartup: boolean;
	syncIntervalMinutes: number;
	excludedFolders: string[];
	lastSyncTime: number;
}

export const DEFAULT_SETTINGS: SupaBaseJumpSettings = {
	supabaseUrl: "",
	supabaseAnonKey: "",
	personalAccessToken: "",
	email: "",
	password: "",
	vaultId: "",
	syncOnStartup: false,
	syncIntervalMinutes: 5,
	excludedFolders: [],
	lastSyncTime: 0,
};

export const BINARY_EXTENSIONS = new Set([
	"png",
	"jpg",
	"jpeg",
	"gif",
	"webp",
	"svg",
	"bmp",
	"pdf",
	"mp3",
	"mp4",
	"wav",
	"ogg",
	"m4a",
	"zip",
	"docx",
	"xlsx",
	"pptx",
	"ttf",
	"otf",
	"woff",
	"woff2",
]);

export function isBinary(path: string): boolean {
	const ext = path.split(".").pop()?.toLowerCase() ?? "";
	return BINARY_EXTENSIONS.has(ext);
}

export function isExcluded(
	filePath: string,
	excludedFolders: string[],
): boolean {
	if (excludedFolders.length === 0) return false;
	return excludedFolders.some((folder) => {
		const prefix = folder.replace(/\/$/, ""); // strip trailing slash
		return filePath === prefix || filePath.startsWith(prefix + "/");
	});
}

const SETUP_SQL = `-- vault_files table
CREATE TABLE IF NOT EXISTS vault_files (
  id           text primary key,
  vault_id     text not null,
  path         text not null,
  content      text,
  storage_path text,
  is_binary    boolean default false,
  mtime        bigint not null,
  ctime        bigint not null,
  size         bigint not null,
  deleted      boolean default false,
  updated_at   timestamptz default now(),
  user_id      uuid references auth.users(id)
);
CREATE INDEX IF NOT EXISTS vault_files_vault_path
  ON vault_files(vault_id, path);
CREATE INDEX IF NOT EXISTS vault_files_vault_mtime
  ON vault_files(vault_id, mtime);
ALTER TABLE vault_files ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users manage own vault" ON vault_files FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
ALTER PUBLICATION supabase_realtime ADD TABLE vault_files;

-- storage bucket: create manually in Storage → New bucket
--   Name: vault-attachments   Public: OFF
-- Then add a policy on storage.objects:
--   USING  (auth.uid()::text = (storage.foldername(name))[1])
--   WITH CHECK (same)`;

export interface SettingsTabHost {
	settings: SupaBaseJumpSettings;
	saveSettings(): Promise<void>;
	initSupabase(): Promise<void>;
	signOut(): Promise<void>;
	fullSync(): Promise<void>;
	fetchNow(): Promise<void>;
	initializeSchema(onProgress: (step: number) => void): Promise<void>;
}

export class SupaBaseJumpSettingTab extends PluginSettingTab {
	private plugin: Plugin & SettingsTabHost;

	constructor(app: App, plugin: Plugin & SettingsTabHost) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl).setName("Initial setup").setHeading();

		new Setting(containerEl)
			.setName("Personal access token")
			.setDesc(
				"Generate at supabase.com/dashboard/account/tokens - only needed for this setup step, can be cleared after",
			)
			.addText((text) => {
				text.setPlaceholder("Sbp_...")
					.setValue(this.plugin.settings.personalAccessToken)
					.onChange(async (value) => {
						this.plugin.settings.personalAccessToken = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl)
			.setName("One-click project setup")
			.setDesc(
				"Creates the vault_files table, enables realtime, and creates the vault-attachments storage bucket; run once after creating your supabase project",
			)
			.addButton((btn) => {
				btn.setButtonText("Run full setup").setCta();
				btn.onClick(async () => {
					btn.setButtonText("Setting up… (step 1/3)").setDisabled(
						true,
					);
					try {
						await this.plugin.initializeSchema((step) => {
							btn.setButtonText(`Setting up… (step ${step}/3)`);
						});
					} finally {
						btn.setButtonText("Run full setup").setDisabled(false);
					}
				});
			});

		const guide = containerEl.createEl("details", {
			cls: "sbj-setup-guide",
		});
		guide.createEl("summary", { text: "Manual setup guide (fallback)" });

		const steps = guide.createEl("ol");
		[
			"Create a free project at supabase.com.",
			"Copy the Project URL and anon/public API key from Project Settings → API.",
			"Generate a Personal Access Token at supabase.com/dashboard/account/tokens.",
			"Enter the URL, keys, and token above, then click Run full setup.",
			"Alternatively, run the SQL below in the Supabase SQL editor and create the storage bucket manually.",
		].forEach((s) => steps.createEl("li", { text: s }));

		guide.createEl("pre", { text: SETUP_SQL, cls: "sbj-sql-block" });

		new Setting(containerEl).setName("Supabase credentials").setHeading();

		new Setting(containerEl)
			.setName("Project URL")
			.setDesc("https://<project-ref>.supabase.co")
			.addText((text) =>
				text
					.setPlaceholder("https://xxxx.supabase.co")
					.setValue(this.plugin.settings.supabaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.supabaseUrl = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Anon/public key")
			.setDesc("Found under project settings → api")
			.addText((text) => {
				text.setPlaceholder("EyJ...")
					.setValue(this.plugin.settings.supabaseAnonKey)
					.onChange(async (value) => {
						this.plugin.settings.supabaseAnonKey = value.trim();
						await this.plugin.saveSettings();
					});
				text.inputEl.type = "password";
			});

		new Setting(containerEl).setName("Account").setHeading();

		new Setting(containerEl)
			.setName("Email")
			.setDesc("Supabase auth email address")
			.addText((text) =>
				text
					.setPlaceholder("You@example.com")
					.setValue(this.plugin.settings.email)
					.onChange(async (value) => {
						this.plugin.settings.email = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Password").addText((text) => {
			text.setPlaceholder("••••••••")
				.setValue(this.plugin.settings.password)
				.onChange(async (value) => {
					this.plugin.settings.password = value;
					await this.plugin.saveSettings();
				});
			text.inputEl.type = "password";
		});

		new Setting(containerEl)
			.setName("Connect")
			.setDesc(
				"Sign in (or create an account) using the credentials above",
			)
			.addButton((btn) =>
				btn
					.setButtonText("Connect")
					.setCta()
					.onClick(async () => {
						btn.setButtonText("Connecting…").setDisabled(true);
						try {
							await this.plugin.initSupabase();
						} finally {
							btn.setButtonText("Connect").setDisabled(false);
						}
					}),
			)
			.addButton((btn) =>
				btn.setButtonText("Sign out").onClick(async () => {
					await this.plugin.signOut();
				}),
			);

		new Setting(containerEl).setName("Vault").setHeading();

		let vaultIdText: TextComponent;
		new Setting(containerEl)
			.setName("Vault ID")
			.setDesc(
				"Unique identifier for this vault; files are namespaced under this id in supabase storage; each vault syncing to the same supabase project needs a different id",
			)
			.addText((text) => {
				vaultIdText = text;
				text.setPlaceholder("My-Vault")
					.setValue(this.plugin.settings.vaultId)
					.onChange(async (value) => {
						this.plugin.settings.vaultId = value.trim();
						await this.plugin.saveSettings();
					});
			})
			.addButton((btn) =>
				btn
					.setButtonText("Generate")
					.setTooltip("Auto-generate a unique vault ID")
					.onClick(async () => {
						const id = window.crypto
							.randomUUID()
							.replace(/-/g, "")
							.slice(0, 12);
						vaultIdText.setValue(id);
						this.plugin.settings.vaultId = id;
						await this.plugin.saveSettings();
						new Notice("SupaBase Jump: vault id generated");
					}),
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc(
				"Comma-separated list of folder paths to exclude from sync (e.g. templates, archive/old)",
			)
			.addText((text) =>
				text
					.setPlaceholder("Templates, Archive/Old")
					.setValue(this.plugin.settings.excludedFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.excludedFolders = value
							.split(",")
							.map((s) => s.trim())
							.filter(Boolean);
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Sync behaviour").setHeading();

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Run a full sync automatically when obsidian opens")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.syncOnStartup)
					.onChange(async (value) => {
						this.plugin.settings.syncOnStartup = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Sync interval (minutes)")
			.setDesc(
				"How often to sync in the background; set to 0 to disable background sync",
			)
			.addSlider((slider) =>
				slider
					.setLimits(0, 60, 1)
					.setValue(this.plugin.settings.syncIntervalMinutes)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.syncIntervalMinutes = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl).setName("Actions").setHeading();

		new Setting(containerEl)
			.setName("Force sync")
			.setDesc(
				"Immediately compare and reconcile all local and remote files",
			)
			.addButton((btn) =>
				btn
					.setButtonText("Sync now")
					.setCta()
					.onClick(async () => {
						btn.setButtonText("Syncing…").setDisabled(true);
						try {
							await this.plugin.fullSync();
						} finally {
							btn.setButtonText("Sync now").setDisabled(false);
						}
					}),
			);

		new Setting(containerEl)
			.setName("Fetch from database")
			.setDesc(
				"Download all remote changes to this device without pushing local files",
			)
			.addButton((btn) =>
				btn.setButtonText("Fetch now").onClick(async () => {
					btn.setButtonText("Fetching…").setDisabled(true);
					try {
						await this.plugin.fetchNow();
					} finally {
						btn.setButtonText("Fetch now").setDisabled(false);
					}
				}),
			);

		if (this.plugin.settings.lastSyncTime > 0) {
			const ts = new Date(
				this.plugin.settings.lastSyncTime,
			).toLocaleString();
			containerEl.createEl("p", {
				text: `Last synced: ${ts}`,
				cls: "sbj-last-sync",
			});
		}
	}
}
