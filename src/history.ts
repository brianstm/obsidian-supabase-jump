import { App, ButtonComponent, FuzzySuggestModal, Modal, Notice, TFile } from "obsidian";
import { SyncEngine } from "./sync";
import { errorCode, errorMessage, formatBytes, timeAgo } from "./utils";

function missingTable(err: unknown): boolean {
	const code = errorCode(err);
	return code === "42P01" || code === "PGRST205" || /vault_file_versions/.test(errorMessage(err));
}

interface VersionRow {
	id: number;
	created_at: string;
	size: number | null;
	device_name: string | null;
}

export class HistoryModal extends Modal {
	private versions: VersionRow[] = [];
	private selected: VersionRow | null = null;
	private listEl!: HTMLElement;
	private previewEl!: HTMLElement;
	private actionsEl!: HTMLElement;
	private previewText = "";

	constructor(
		app: App,
		private sync: SyncEngine,
		private file: TFile,
	) {
		super(app);
	}

	onOpen(): void {
		this.modalEl.addClass("sbj-history-modal");
		this.setTitle(`History of ${this.file.basename}`);
		const body = this.contentEl.createDiv({ cls: "sbj-history" });
		this.listEl = body.createDiv({ cls: "sbj-history-list" });
		const right = body.createDiv({ cls: "sbj-history-detail" });
		this.previewEl = right.createEl("pre", { cls: "sbj-history-preview" });
		this.actionsEl = right.createDiv({ cls: "sbj-history-actions" });
		this.listEl.setText("Loading…");
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			this.versions = await this.sync.listVersions(this.file.path);
		} catch (err) {
			this.listEl.empty();
			this.listEl.createDiv({
				cls: "sbj-muted",
				text: missingTable(err)
					? "Version history isn't set up on your database yet. Open the plugin settings and run the setup again."
					: `Could not load history. ${errorMessage(err)}`,
			});
			return;
		}
		this.renderList();
	}

	private renderList(): void {
		this.listEl.empty();
		if (this.versions.length === 0) {
			this.listEl.createDiv({
				cls: "sbj-muted",
				text: "No older versions yet. A snapshot is saved when you start editing a note again after a 10 minute break.",
			});
			return;
		}
		for (const v of this.versions) {
			const item = this.listEl.createDiv({ cls: "sbj-history-item" });
			if (this.selected?.id === v.id) item.addClass("is-selected");
			item.createDiv({ cls: "sbj-history-when", text: timeAgo(v.created_at) });
			const meta = [new Date(v.created_at).toLocaleString()];
			if (v.device_name) meta.push(v.device_name);
			if (v.size !== null) meta.push(formatBytes(v.size));
			item.createDiv({ cls: "sbj-history-meta", text: meta.join(" · ") });
			item.addEventListener("click", () => void this.select(v));
		}
	}

	private async select(v: VersionRow): Promise<void> {
		this.selected = v;
		this.renderList();
		this.previewEl.setText("Loading…");
		this.actionsEl.empty();
		try {
			this.previewText = await this.sync.versionContent(v.id);
		} catch (err) {
			this.previewEl.setText(`Could not load this version. ${errorMessage(err)}`);
			return;
		}
		if (this.selected?.id !== v.id) return;
		this.previewEl.setText(this.previewText || "(empty)");

		new ButtonComponent(this.actionsEl)
			.setButtonText("Restore this version")
			.setCta()
			.onClick(() => void this.restore());
		new ButtonComponent(this.actionsEl)
			.setButtonText("Copy text")
			.onClick(() => {
				void navigator.clipboard.writeText(this.previewText).then(() => new Notice("Copied"));
			});
	}

	private async restore(): Promise<void> {
		try {
			const current = await this.app.vault.read(this.file);
			if (current !== this.previewText) {
				await this.sync.snapshot(this.file.path, current).catch((err) =>
					console.warn("Supabase jump: could not snapshot before restore", err),
				);
			}
			await this.app.vault.process(this.file, () => this.previewText);
			new Notice(`Restored ${this.file.basename}`);
			this.close();
		} catch (err) {
			new Notice(`Supabase jump: restore failed. ${errorMessage(err)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

interface DeletedRow {
	path: string;
	updated_at: string;
	device_name?: string | null;
}

export class DeletedFilesModal extends FuzzySuggestModal<DeletedRow> {
	constructor(
		app: App,
		private sync: SyncEngine,
		private rows: DeletedRow[],
	) {
		super(app);
		this.setPlaceholder("Pick a deleted note to bring back");
		this.emptyStateText = "Nothing to restore";
	}

	getItems(): DeletedRow[] {
		return this.rows;
	}

	getItemText(item: DeletedRow): string {
		return item.path;
	}

	renderSuggestion(match: { item: DeletedRow }, el: HTMLElement): void {
		el.createDiv({ text: match.item.path });
		const meta = [`Deleted ${timeAgo(match.item.updated_at)}`];
		if (match.item.device_name) meta.push(`on ${match.item.device_name}`);
		el.createEl("small", { cls: "sbj-muted", text: meta.join(" ") });
	}

	onChooseItem(item: DeletedRow): void {
		void this.sync
			.restoreDeleted(item.path)
			.then((target) => new Notice(`Restored "${target}"`))
			.catch((err) => new Notice(`Supabase jump: restore failed. ${errorMessage(err)}`));
	}
}
