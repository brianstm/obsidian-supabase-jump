import * as Y from "yjs";
import { Annotation, ChangeSpec, Range, Transaction } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { editorInfoField, setTooltip } from "obsidian";
import { commonDiff } from "../utils";
import { LiveSession, ORIGIN_REMOTE, RelCursor } from "./session";

export const remoteChange = Annotation.define<boolean>();

export interface BindingHost {
	register(binding: LiveBinding): void;
	unregister(binding: LiveBinding): void;
	attach(binding: LiveBinding): void;
	detach(binding: LiveBinding): void;
	readonly showCursors: boolean;
	readonly showPresence: boolean;
}

class CaretWidget extends WidgetType {
	constructor(
		private name: string,
		private color: string,
	) {
		super();
	}

	eq(other: CaretWidget): boolean {
		return other.name === this.name && other.color === this.color;
	}

	toDOM(): HTMLElement {
		const el = createSpan({ cls: "sbj-remote-caret" });
		el.setCssProps({ "--sbj-peer-color": this.color });
		el.createSpan({ cls: "sbj-remote-caret-label", text: this.name });
		return el;
	}

	ignoreEvent(): boolean {
		return true;
	}
}

export class LiveBinding {
	path: string | null = null;
	session: LiveSession | null = null;
	primary = false;
	decorations: DecorationSet = Decoration.none;

	private unobserve: (() => void) | null = null;
	private unlisten: (() => void) | null = null;
	private presenceEl: HTMLElement | null = null;
	private verifyTimer: number | null = null;
	private lastCursor = "";

	constructor(
		private host: BindingHost,
		readonly view: EditorView,
	) {
		this.path = this.currentPath();
		host.register(this);
		if (this.path) host.attach(this);
	}

	currentPath(): string | null {
		const info = this.view.state.field(editorInfoField, false);
		const file = info?.file;
		if (!file || file.extension !== "md") return null;
		return file.path;
	}

	get text(): string {
		return this.view.state.doc.toString();
	}

	bind(session: LiveSession, primary: boolean): void {
		this.unbind();
		this.session = session;
		this.primary = primary;
		this.unlisten = session.onEvent((kind) => {
			if (kind === "reset") {
				this.observe();
				this.reconcileFromDoc();
			}
			if (kind === "peers") this.renderPresence();
			this.refreshDecorations();
		});
		this.observe();
		this.renderPresence();
		this.refreshDecorations();
	}

	setPrimary(primary: boolean): void {
		this.primary = primary;
		this.observe();
		if (primary) this.reconcileFromDoc();
	}

	unbind(): void {
		this.unobserve?.();
		this.unobserve = null;
		this.unlisten?.();
		this.unlisten = null;
		if (this.session && this.primary) this.session.setCursor(null);
		this.session = null;
		this.primary = false;
		this.presenceEl?.remove();
		this.presenceEl = null;
		this.lastCursor = "";
		if (this.decorations.size > 0) {
			this.decorations = Decoration.none;
			this.redraw();
		}
	}

	private observe(): void {
		this.unobserve?.();
		this.unobserve = null;
		const session = this.session;
		if (!session || !this.primary) return;
		const ytext = session.text;
		const handler = (event: Y.YTextEvent, tr: Y.Transaction) => {
			if (tr.origin === this) return;
			const changes: ChangeSpec[] = [];
			let pos = 0;
			for (const d of event.delta) {
				if (d.retain !== undefined) {
					pos += d.retain;
				} else if (d.insert !== undefined) {
					changes.push({ from: pos, insert: typeof d.insert === "string" ? d.insert : "" });
				} else if (d.delete !== undefined) {
					changes.push({ from: pos, to: pos + d.delete });
					pos += d.delete;
				}
			}
			if (changes.length === 0) return;
			this.dispatchRemote(changes);
		};
		ytext.observe(handler);
		this.unobserve = () => ytext.unobserve(handler);
	}

	private dispatchRemote(changes: ChangeSpec | ChangeSpec[]): void {
		try {
			this.view.dispatch({
				changes,
				annotations: [remoteChange.of(true), Transaction.addToHistory.of(false)],
			});
		} catch (err) {
			console.warn("Supabase jump: could not apply a live change, resyncing this note", err);
			this.later(() => this.reconcileFromDoc());
		}
	}

	reconcileFromDoc(): void {
		const session = this.session;
		if (!session || !this.primary) return;
		const diff = commonDiff(this.text, session.text.toJSON());
		if (!diff) return;
		this.dispatchRemote({ from: diff.start, to: diff.start + diff.deleteCount, insert: diff.insert });
	}

	private pushDiffToDoc(): void {
		const session = this.session;
		if (!session) return;
		const ytext = session.text;
		const diff = commonDiff(ytext.toJSON(), this.text);
		if (!diff) return;
		session.doc.transact(() => {
			if (diff.deleteCount > 0) ytext.delete(diff.start, diff.deleteCount);
			if (diff.insert) ytext.insert(diff.start, diff.insert);
		}, this);
	}

	update(update: ViewUpdate): void {
		const path = this.currentPath();
		if (path !== this.path) {
			this.host.detach(this);
			this.path = path;
			if (path) this.host.attach(this);
			return;
		}

		const session = this.session;
		if (session && this.primary && update.docChanged) {
			for (const tr of update.transactions) {
				if (!tr.docChanged || tr.annotation(remoteChange)) continue;
				this.applyLocal(tr);
			}
			this.scheduleVerify();
		}

		if (session && this.primary && (update.selectionSet || update.focusChanged || update.docChanged)) {
			this.sendCursor();
		}

		if (update.docChanged && session && session.cursors.size > 0) {
			this.decorations = this.buildDecorations();
		}
	}

	private applyLocal(tr: Transaction): void {
		const session = this.session;
		if (!session) return;
		const ytext = session.text;
		const startLen = tr.startState.doc.length;
		let wholeDoc = false;
		tr.changes.iterChangedRanges((fromA, toA) => {
			if (fromA === 0 && toA === startLen && startLen > 0) wholeDoc = true;
		});

		if (wholeDoc) {
			this.pushDiffToDoc();
			return;
		}

		session.doc.transact(() => {
			let shift = 0;
			tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
				const text = inserted.sliceString(0, inserted.length, "\n");
				const at = fromA + shift;
				if (toA > fromA) ytext.delete(at, toA - fromA);
				if (text.length > 0) ytext.insert(at, text);
				shift += text.length - (toA - fromA);
			});
		}, this);
	}

	private scheduleVerify(): void {
		if (this.verifyTimer !== null) window.clearTimeout(this.verifyTimer);
		this.verifyTimer = window.setTimeout(() => {
			this.verifyTimer = null;
			if (this.session && this.primary && this.session.text.toJSON() !== this.text) {
				this.pushDiffToDoc();
			}
		}, 1500);
	}

	private sendCursor(): void {
		const session = this.session;
		if (!session) return;
		if (!this.view.hasFocus) {
			if (this.lastCursor !== "none") {
				this.lastCursor = "none";
				session.setCursor(null);
			}
			return;
		}
		const sel = this.view.state.selection.main;
		const key = `${sel.anchor}:${sel.head}`;
		if (key === this.lastCursor) return;
		this.lastCursor = key;
		const ytext = session.text;
		const len = ytext.length;
		const cursor: RelCursor = {
			a: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, Math.min(sel.anchor, len))),
			h: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(ytext, Math.min(sel.head, len))),
		};
		session.setCursor(cursor);
	}

	private toIndex(json: unknown): number | null {
		const session = this.session;
		if (!session || !json) return null;
		try {
			const rel = Y.createRelativePositionFromJSON(json);
			const abs = Y.createAbsolutePositionFromRelativePosition(rel, session.doc);
			if (!abs || abs.type !== session.text) return null;
			return Math.min(abs.index, this.view.state.doc.length);
		} catch {
			return null;
		}
	}

	private buildDecorations(): DecorationSet {
		const session = this.session;
		if (!session || !this.host.showCursors || session.cursors.size === 0) return Decoration.none;
		const ranges: Range<Decoration>[] = [];
		for (const [key, cursor] of session.cursors) {
			const peer = session.peers.get(key);
			if (!peer) continue;
			const anchor = this.toIndex(cursor.a);
			const head = this.toIndex(cursor.h);
			if (anchor === null || head === null) continue;
			const from = Math.min(anchor, head);
			const to = Math.max(anchor, head);
			if (to > from) {
				ranges.push(
					Decoration.mark({
						class: "sbj-remote-selection",
						attributes: { style: `--sbj-peer-color: ${peer.color}` },
					}).range(from, to),
				);
			}
			ranges.push(
				Decoration.widget({ widget: new CaretWidget(peer.name, peer.color), side: 1 }).range(head),
			);
		}
		return Decoration.set(ranges, true);
	}

	refreshDecorations(): void {
		this.decorations = this.buildDecorations();
		this.redraw();
	}

	private redraw(): void {
		this.later(() => {
			try {
				this.view.dispatch({});
			} catch {
				// view was destroyed
			}
		});
	}

	renderPresence(): void {
		const session = this.session;
		const peers = session ? [...session.peers.values()] : [];
		if (!this.host.showPresence || peers.length === 0) {
			this.presenceEl?.remove();
			this.presenceEl = null;
			return;
		}
		if (!this.presenceEl) {
			this.presenceEl = this.view.dom.createDiv({ cls: "sbj-presence" });
		}
		const el = this.presenceEl;
		el.empty();
		const seen = new Set<string>();
		for (const peer of peers) {
			const id = peer.deviceId || peer.key;
			if (seen.has(id)) continue;
			seen.add(id);
			const dot = el.createDiv({ cls: "sbj-presence-avatar", text: (peer.name || "?").slice(0, 1).toUpperCase() });
			dot.setCssProps({ "--sbj-peer-color": peer.color });
			setTooltip(dot, `${peer.name} is here`, { placement: "bottom" });
		}
	}

	private later(fn: () => void): void {
		window.setTimeout(fn, 0);
	}

	destroy(): void {
		if (this.verifyTimer !== null) window.clearTimeout(this.verifyTimer);
		this.host.detach(this);
		this.host.unregister(this);
		this.unbind();
	}
}

export function liveExtension(host: BindingHost) {
	return ViewPlugin.fromClass(
		class {
			binding: LiveBinding;
			constructor(view: EditorView) {
				this.binding = new LiveBinding(host, view);
			}
			update(update: ViewUpdate) {
				this.binding.update(update);
			}
			destroy() {
				this.binding.destroy();
			}
		},
		{ decorations: (v) => v.binding.decorations },
	);
}

export { ORIGIN_REMOTE };
