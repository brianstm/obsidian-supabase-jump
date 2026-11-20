import { App, Notice } from "obsidian";
import { Connection } from "../supabase";
import { SupaBaseJumpSettings, defaultDeviceName } from "../settings";
import { LiveHooks, SyncEngine, VaultFileRow } from "../sync";
import { commonDiff, conflictPath, hash32, hashString, randomId } from "../utils";
import { BindingHost, LiveBinding } from "./binding";
import { LiveSession, ORIGIN_EXTERNAL, PeerInfo, SessionHost } from "./session";

const PEER_COLORS = [
	"#e5484d", "#f76b15", "#ffb224", "#30a46c", "#12a594",
	"#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#978365",
];

const MAX_LIVE_CHARS = 1_500_000;
const ATTACH_DELAY_MS = 120;
const CLOSE_GRACE_MS = 4000;

interface Entry {
	session: LiveSession;
	bindings: LiveBinding[];
	closeTimer: number | null;
}

export interface LiveManagerHost {
	app: App;
	settings: SupaBaseJumpSettings;
	connection: Connection;
	sync: SyncEngine;
	onPeersChanged(): void;
}

export class LiveManager implements BindingHost, LiveHooks {
	private bindings = new Set<LiveBinding>();
	private entries = new Map<string, Entry>();
	private pending = new Map<LiveBinding, number>();
	private enabled = false;
	private privateChannels = true;
	private me: PeerInfo | null = null;

	constructor(private host: LiveManagerHost) {}

	get showCursors(): boolean {
		return this.host.settings.showCursors;
	}

	get showPresence(): boolean {
		return this.host.settings.showPresence;
	}

	register(binding: LiveBinding): void {
		this.bindings.add(binding);
	}

	unregister(binding: LiveBinding): void {
		this.bindings.delete(binding);
	}

	enable(): void {
		const { connection, settings } = this.host;
		if (!connection.ready || !settings.liveEditing || !settings.vaultId) return;
		this.enabled = true;
		const deviceId = settings.deviceId;
		this.me = {
			key: `${deviceId}-${randomId(4)}`,
			deviceId,
			name: settings.deviceName.trim() || defaultDeviceName(),
			color: PEER_COLORS[hash32(deviceId) % PEER_COLORS.length] ?? "#0090ff",
		};
		for (const b of this.bindings) this.attach(b);
	}

	disable(): void {
		this.enabled = false;
		for (const timer of this.pending.values()) window.clearTimeout(timer);
		this.pending.clear();
		for (const entry of this.entries.values()) {
			if (entry.closeTimer !== null) window.clearTimeout(entry.closeTimer);
			for (const b of entry.bindings) b.unbind();
			entry.session.dispose();
		}
		this.entries.clear();
		this.host.onPeersChanged();
	}

	resync(): void {
		for (const entry of this.entries.values()) entry.session.resync();
	}

	refreshUi(): void {
		for (const b of this.bindings) {
			b.renderPresence();
			b.refreshDecorations();
		}
	}

	peersFor(path: string | null): PeerInfo[] {
		if (!path) return [];
		const entry = this.entries.get(path);
		if (!entry) return [];
		const byDevice = new Map<string, PeerInfo>();
		for (const p of entry.session.peers.values()) byDevice.set(p.deviceId || p.key, p);
		return [...byDevice.values()];
	}

	attach(binding: LiveBinding): void {
		if (!this.enabled || !binding.path) return;
		const existing = this.pending.get(binding);
		if (existing !== undefined) window.clearTimeout(existing);
		const path = binding.path;
		// Wait a moment so the editor has loaded the file before we seed from it.
		const timer = window.setTimeout(() => {
			this.pending.delete(binding);
			if (binding.path === path && this.enabled && this.bindings.has(binding)) this.doAttach(binding, path);
		}, ATTACH_DELAY_MS);
		this.pending.set(binding, timer);
	}

	private doAttach(binding: LiveBinding, path: string): void {
		const text = binding.text;
		if (text.length > MAX_LIVE_CHARS) return;

		let entry = this.entries.get(path);
		let reused = true;
		if (entry && entry.bindings.length === 0 && entry.session.peers.size === 0) {
			if (entry.closeTimer !== null) window.clearTimeout(entry.closeTimer);
			entry.session.dispose();
			this.entries.delete(path);
			entry = undefined;
		}
		if (!entry) {
			const session = this.createSession(path, text);
			if (!session) return;
			entry = { session, bindings: [], closeTimer: null };
			this.entries.set(path, entry);
			session.onEvent((kind) => {
				if (kind === "peers") this.host.onPeersChanged();
			});
			session.start();
			reused = false;
		}
		if (entry.closeTimer !== null) {
			window.clearTimeout(entry.closeTimer);
			entry.closeTimer = null;
		}
		if (entry.bindings.includes(binding)) return;
		entry.bindings.push(binding);
		const primary = entry.bindings.length === 1;
		binding.bind(entry.session, primary);
		if (primary && reused) binding.reconcileFromDoc();
	}

	private createSession(path: string, text: string): LiveSession | null {
		const { connection, settings } = this.host;
		const client = connection.client;
		const userId = connection.userId;
		const me = this.me;
		if (!client || !userId || !me) return null;
		const sessionHost: SessionHost = {
			client,
			userId,
			vaultId: settings.vaultId,
			me,
			privateChannels: this.privateChannels,
			onPrivateRejected: () => {
				if (this.privateChannels) {
					this.privateChannels = false;
					console.warn(
						"Supabase jump: private live channels aren't set up on this project, using public ones. Run the setup again in settings to fix this.",
					);
				}
			},
			onReset: (session, previous) => this.onReset(session, previous),
		};
		return new LiveSession(sessionHost, path, text);
	}

	detach(binding: LiveBinding): void {
		const pending = this.pending.get(binding);
		if (pending !== undefined) {
			window.clearTimeout(pending);
			this.pending.delete(binding);
		}
		const session = binding.session;
		if (!session) return;
		const entry = this.entries.get(session.path);
		const wasPrimary = binding.primary;
		binding.unbind();
		if (!entry) return;
		entry.bindings = entry.bindings.filter((b) => b !== binding);
		if (entry.bindings.length > 0) {
			if (wasPrimary) entry.bindings[0]?.setPrimary(true);
			return;
		}
		entry.closeTimer = window.setTimeout(() => {
			if (entry.bindings.length > 0) return;
			entry.session.dispose();
			if (this.entries.get(session.path) === entry) this.entries.delete(session.path);
			this.host.onPeersChanged();
		}, CLOSE_GRACE_MS);
	}

	isLive(path: string): boolean {
		const entry = this.entries.get(path);
		return entry !== undefined && entry.bindings.length > 0;
	}

	currentText(path: string): string | null {
		const entry = this.entries.get(path);
		if (!entry || entry.bindings.length === 0) return null;
		return entry.session.text.toJSON();
	}

	handleRemoteRow(path: string, row: VaultFileRow, canMerge: boolean): boolean {
		const entry = this.entries.get(path);
		if (!entry) return false;
		const session = entry.session;
		if (!row.device_id) return true;
		if (row.device_id === this.host.settings.deviceId || session.seenDevices.has(row.device_id)) return true;

		const remote = row.content ?? "";
		const current = session.text.toJSON();
		if (remote === current) return true;

		if (canMerge) {
			const diff = commonDiff(current, remote);
			if (diff) {
				const ytext = session.text;
				session.doc.transact(() => {
					if (diff.deleteCount > 0) ytext.delete(diff.start, diff.deleteCount);
					if (diff.insert) ytext.insert(diff.start, diff.insert);
				}, ORIGIN_EXTERNAL);
			}
			return true;
		}

		void this.saveCopy(path, remote, row.device_name || "another device");
		return true;
	}

	private onReset(session: LiveSession, previous: string): void {
		const now = session.text.toJSON();
		if (previous === now) return;
		const entry = this.host.sync.state.get(session.path);
		if (entry?.h !== undefined && hashString(previous) === entry.h) return;
		if (!previous.trim()) return;
		void this.saveCopy(session.path, previous, this.host.settings.deviceName || defaultDeviceName());
	}

	private async saveCopy(path: string, content: string, device: string): Promise<void> {
		const copy = conflictPath(path, device);
		try {
			await this.host.sync.ensureFolder(copy);
			await this.host.app.vault.create(copy, content);
			new Notice(`Supabase jump: "${path}" was edited in two places at once. The other version was saved as "${copy}".`, 10000);
		} catch (err) {
			console.error("Supabase jump: could not save conflict copy", err);
		}
	}
}
