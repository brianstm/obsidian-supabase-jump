import * as Y from "yjs";
import { Plugin, TFile, WorkspaceLeaf, Editor, MarkdownView } from "obsidian";
import { SupabaseClient, RealtimeChannel } from "@supabase/supabase-js";

interface CRDTPayload {
	payload: {
		stateVector?: number[];
		update?: number[];
	};
}

export class RealtimeCrdtManager {
	private plugin: Plugin;
	private supabase: SupabaseClient | null = null;
	private vaultId: string | null = null;
	private activeChannel: RealtimeChannel | null = null;

	private ydoc: Y.Doc | null = null;
	private ytext: Y.Text | null = null;
	private activeFile: TFile | null = null;
	private activeEditor: Editor | null = null;
	private suppressNextEditorChange = 0;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
	}

	setSupabase(client: SupabaseClient | null, vaultId: string) {
		this.supabase = client;
		this.vaultId = vaultId;
	}

	/** Returns true while the given path is open in an active CRDT session. */
	isActiveFile(path: string): boolean {
		return this.activeFile?.path === path;
	}

	start() {
		this.plugin.registerEvent(
			this.plugin.app.workspace.on("active-leaf-change", (leaf) => {
				this.handleLeafChange(leaf).catch(console.error);
			}),
		);
		this.plugin.registerEvent(
			this.plugin.app.workspace.on(
				"editor-change",
				this.handleEditorChange.bind(this),
			),
		);
	}

	stop() {
		this.leaveCurrentChannel();
	}

	private async handleLeafChange(leaf: WorkspaceLeaf | null) {
		this.leaveCurrentChannel();

		if (!leaf || !this.supabase || !this.vaultId) return;

		const view = leaf.view;
		if (!(view instanceof MarkdownView)) return;

		const file = view.file;
		if (!file || file.extension !== "md") return;

		this.activeEditor = view.editor;
		if (!this.activeEditor) return;
		this.activeFile = file;

		this.ydoc = new Y.Doc();
		this.ytext = this.ydoc.getText("content");

		const content = await this.getFreshContent(file);
		this.ydoc.transact(() => {
			this.ytext!.insert(0, content);
		}, "init");

		this.ytext.observe((event) => {
			if (
				event.transaction.origin === "local" ||
				event.transaction.origin === "init"
			)
				return;
			this.patchEditorFromYjs();
		});

		this.ydoc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin !== "local") return;
			this.broadcastUpdate(update);
		});

		const channelId = `doc-${this.vaultId}-${btoa(encodeURIComponent(file.path)).replace(/=+$/, "")}`;
		this.activeChannel = this.supabase.channel(channelId);

		this.activeChannel.on(
			"broadcast",
			{ event: "yjs-update" },
			(payload: unknown) => {
				this.handleIncomingUpdate(payload as CRDTPayload);
			},
		);

		this.activeChannel.on(
			"broadcast",
			{ event: "sync-step-1" },
			(payload: unknown) => {
				if (!this.ydoc) return;
				const p = payload as CRDTPayload;
				if (!p.payload.stateVector) return;
				const sv = new Uint8Array(p.payload.stateVector);
				const update = Y.encodeStateAsUpdate(this.ydoc, sv);
				void this.activeChannel?.send({
					type: "broadcast",
					event: "sync-step-2",
					payload: { update: Array.from(update) },
				});
			},
		);

		this.activeChannel.on(
			"broadcast",
			{ event: "sync-step-2" },
			(payload: unknown) => {
				if (!this.ydoc) return;
				const p = payload as CRDTPayload;
				if (!p.payload.update) return;
				Y.applyUpdate(this.ydoc, new Uint8Array(p.payload.update), "remote");
			},
		);

		this.activeChannel.subscribe((status: string) => {
			if (status === "SUBSCRIBED" && this.ydoc) {
				const sv = Y.encodeStateVector(this.ydoc);
				void this.activeChannel?.send({
					type: "broadcast",
					event: "sync-step-1",
					payload: { stateVector: Array.from(sv) },
				});
			}
		});
	}

	// Fetch whichever is newer: local disk or DB row.
	// Avoids seeding Yjs from a stale file when the peer already synced to DB
	// but the local realtime pull hasn't fired yet.
	private async getFreshContent(file: TFile): Promise<string> {
		const diskContent = await this.plugin.app.vault.read(file);
		const diskMtime = file.stat.mtime;

		try {
			const rowId = `${this.vaultId!}::${file.path.replace(/\//g, "__SLASH__")}`;
			const { data } = await this.supabase!
				.from("vault_files")
				.select("content, mtime")
				.eq("id", rowId)
				.eq("deleted", false)
				.single<{ content: string | null; mtime: number }>();

			if (data && data.content !== null && data.mtime > diskMtime) {
				if (this.activeEditor) {
					this.suppressNextEditorChange++;
					this.activeEditor.setValue(data.content);
				}
				try {
					await this.plugin.app.vault.modify(file, data.content);
				} catch {
					// Non-fatal – editor already shows correct content
				}
				return data.content;
			}
		} catch {
			// Non-fatal – fall back to disk content
		}

		return diskContent;
	}

	private broadcastUpdate(update: Uint8Array) {
		if (!this.activeChannel) return;
		void this.activeChannel.send({
			type: "broadcast",
			event: "yjs-update",
			payload: { update: Array.from(update) },
		});
	}

	private handleIncomingUpdate(payload: CRDTPayload) {
		if (!this.ydoc || !payload.payload.update) return;
		Y.applyUpdate(this.ydoc, new Uint8Array(payload.payload.update), "remote");
	}

	private patchEditorFromYjs() {
		if (!this.ytext || !this.activeEditor) return;
		const newText = String(this.ytext.toJSON());
		const currentText = this.activeEditor.getValue();
		if (newText === currentText) return;

		let start = 0;
		while (
			start < currentText.length &&
			start < newText.length &&
			currentText[start] === newText[start]
		) {
			start++;
		}
		let endOld = currentText.length;
		let endNew = newText.length;
		while (
			endOld > start &&
			endNew > start &&
			currentText[endOld - 1] === newText[endNew - 1]
		) {
			endOld--;
			endNew--;
		}

		const fromPos = this.offsetToPos(currentText, start);
		const toPos = this.offsetToPos(currentText, endOld);
		const replacement = newText.slice(start, endNew);

		this.suppressNextEditorChange++;
		this.activeEditor.replaceRange(replacement, fromPos, toPos);
	}

	private handleEditorChange(editor: Editor) {
		if (this.suppressNextEditorChange > 0) {
			this.suppressNextEditorChange--;
			return;
		}
		if (!this.ydoc || !this.ytext || editor !== this.activeEditor) return;

		const currentText = editor.getValue();
		const yjsText = String(this.ytext.toJSON());
		if (currentText === yjsText) return;

		let start = 0;
		while (
			start < yjsText.length &&
			start < currentText.length &&
			yjsText[start] === currentText[start]
		) {
			start++;
		}
		let endY = yjsText.length;
		let endC = currentText.length;
		while (
			endY > start &&
			endC > start &&
			yjsText[endY - 1] === currentText[endC - 1]
		) {
			endY--;
			endC--;
		}

		const deleteLen = endY - start;
		const insertText = currentText.slice(start, endC);

		this.ydoc.transact(() => {
			if (deleteLen > 0) this.ytext!.delete(start, deleteLen);
			if (insertText.length > 0) this.ytext!.insert(start, insertText);
		}, "local");
	}

	private offsetToPos(
		text: string,
		offset: number,
	): { line: number; ch: number } {
		let line = 0;
		let ch = 0;
		for (let i = 0; i < offset; i++) {
			if (text[i] === "\n") {
				line++;
				ch = 0;
			} else {
				ch++;
			}
		}
		return { line, ch };
	}

	private leaveCurrentChannel() {
		// Persist the Yjs-merged state to disk before tearing down so that
		// mtime-based conflict resolution sees up-to-date content on next sync.
		if (this.activeFile && this.ytext) {
			void this.plugin.app.vault
				.modify(this.activeFile, this.ytext.toJSON())
				.catch(() => {});
		}

		if (this.activeChannel) {
			void this.activeChannel.unsubscribe();
			this.activeChannel = null;
		}
		this.ydoc?.destroy();
		this.ydoc = null;
		this.ytext = null;
		this.activeFile = null;
		this.activeEditor = null;
		this.suppressNextEditorChange = 0;
	}
}
