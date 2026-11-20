import { DataAdapter } from "obsidian";

// What we knew about a file the last time it synced: text hash, local mtime
// and size, and the remote updated_at.
export interface FileEntry {
	h?: string;
	lm: number;
	ls: number;
	ru: string;
}

interface StateFile {
	version: 1;
	vaultId: string;
	cursor: string;
	files: Record<string, FileEntry>;
}

const SAVE_DELAY_MS = 1500;

export class SyncState {
	private files = new Map<string, FileEntry>();
	private vaultId = "";
	cursor = "";
	private saveTimer: number | null = null;
	private dirty = false;

	constructor(
		private adapter: DataAdapter,
		private filePath: string,
	) {}

	async load(vaultId: string): Promise<void> {
		this.files.clear();
		this.cursor = "";
		this.vaultId = vaultId;
		try {
			if (!(await this.adapter.exists(this.filePath))) return;
			const parsed = JSON.parse(await this.adapter.read(this.filePath)) as Partial<StateFile>;
			if (parsed.version !== 1 || parsed.vaultId !== vaultId) return;
			this.cursor = parsed.cursor ?? "";
			for (const [path, entry] of Object.entries(parsed.files ?? {})) {
				this.files.set(path, entry);
			}
		} catch (err) {
			console.warn("Supabase jump: could not read sync state, starting fresh", err);
		}
	}

	get size(): number {
		return this.files.size;
	}

	get(path: string): FileEntry | undefined {
		return this.files.get(path);
	}

	set(path: string, entry: FileEntry): void {
		this.files.set(path, entry);
		this.touch();
	}

	delete(path: string): void {
		if (this.files.delete(path)) this.touch();
	}

	paths(): string[] {
		return [...this.files.keys()];
	}

	setCursor(cursor: string): void {
		if (cursor && cursor > this.cursor) {
			this.cursor = cursor;
			this.touch();
		}
	}

	reset(): void {
		this.files.clear();
		this.cursor = "";
		this.touch();
	}

	private touch(): void {
		this.dirty = true;
		if (this.saveTimer !== null) return;
		this.saveTimer = window.setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, SAVE_DELAY_MS);
	}

	async flush(): Promise<void> {
		if (this.saveTimer !== null) {
			window.clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		if (!this.dirty || !this.vaultId) return;
		this.dirty = false;
		const data: StateFile = {
			version: 1,
			vaultId: this.vaultId,
			cursor: this.cursor,
			files: Object.fromEntries(this.files),
		};
		try {
			await this.adapter.write(this.filePath, JSON.stringify(data));
		} catch (err) {
			this.dirty = true;
			console.warn("Supabase jump: could not save sync state", err);
		}
	}
}
