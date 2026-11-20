import * as Y from "yjs";
import { REALTIME_SUBSCRIBE_STATES } from "@supabase/supabase-js";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { base64ToBytes, bytesToBase64, hash32, hashString, randomId } from "../utils";

export const ORIGIN_REMOTE = "remote";
export const ORIGIN_EXTERNAL = "external";
const ORIGIN_SEED = "seed";

export interface PeerInfo {
	key: string;
	deviceId: string;
	name: string;
	color: string;
}

export interface Seed {
	id: string;
	at: number;
	key: string;
}

export interface RelCursor {
	a: unknown;
	h: unknown;
}

export interface SessionHost {
	client: SupabaseClient;
	userId: string;
	vaultId: string;
	me: PeerInfo;
	privateChannels: boolean;
	onPrivateRejected(): void;
	onReset(session: LiveSession, previousText: string): void;
}

type Message =
	| { t: "hello"; from: string; sv: string; seed: Seed }
	| { t: "state"; from: string; to: string; u: string; sv: string; seed: Seed; full: boolean; reply: boolean }
	| { t: "tick"; from: string; seed: Seed; u?: string; c?: RelCursor | null }
	| { t: "req"; from: string; to: string }
	| { t: "chunk"; from: string; id: string; i: number; n: number; d: string };

const UPDATE_FLUSH_MS = 40;
const CURSOR_FLUSH_MS = 90;
const CHUNK_CHARS = 60_000;
const RESOLVE_COOLDOWN_MS = 2000;

function seedWins(a: Seed, b: Seed): boolean {
	if (a.at !== b.at) return a.at < b.at;
	if (a.id !== b.id) return a.id < b.id;
	return a.key < b.key;
}

function meaningful(update: Uint8Array): boolean {
	return update.length > 2;
}

export class LiveSession {
	doc: Y.Doc;
	seed: Seed;
	peers = new Map<string, PeerInfo>();
	seenDevices = new Set<string>();
	cursors = new Map<string, RelCursor>();
	joined = false;

	private channel: RealtimeChannel | null = null;
	private everJoined = false;
	private disposed = false;
	private pendingUpdates: Uint8Array[] = [];
	private pendingCursor: RelCursor | null | undefined = undefined;
	private flushTimer: number | null = null;
	private chunks = new Map<string, { n: number; parts: string[]; got: number; at: number }>();
	private lastResolve = new Map<string, number>();
	private listeners = new Set<(kind: "peers" | "cursors" | "reset") => void>();

	constructor(
		private host: SessionHost,
		readonly path: string,
		initialText: string,
	) {
		this.doc = new Y.Doc();
		this.seed = { id: hashString(initialText), at: Date.now(), key: host.me.key };
		this.applySeed(initialText);
		this.watchDoc();
	}

	get text(): Y.Text {
		return this.doc.getText("content");
	}

	onEvent(cb: (kind: "peers" | "cursors" | "reset") => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private emit(kind: "peers" | "cursors" | "reset"): void {
		for (const cb of this.listeners) cb(kind);
	}

	// Two devices that open the same text produce identical Yjs items this way,
	// so their docs merge cleanly instead of doubling the content.
	private applySeed(text: string): void {
		if (!text) return;
		const seedDoc = new Y.Doc();
		seedDoc.clientID = hash32(this.seed.id) || 1;
		seedDoc.getText("content").insert(0, text);
		Y.applyUpdate(this.doc, Y.encodeStateAsUpdate(seedDoc), ORIGIN_SEED);
		seedDoc.destroy();
	}

	private watchDoc(): void {
		this.doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === ORIGIN_REMOTE || origin === ORIGIN_SEED) return;
			this.pendingUpdates.push(update);
			this.scheduleFlush(UPDATE_FLUSH_MS);
		});
	}

	start(): void {
		if (this.disposed) return;
		this.openChannel(this.host.privateChannels);
	}

	private topic(privateChannel: boolean): string {
		const fileKey = hashString(this.path);
		return privateChannel
			? `sbj:${this.host.userId}:${this.host.vaultId}:${fileKey}`
			: `sbj-live-${this.host.vaultId}-${fileKey}`;
	}

	private openChannel(privateChannel: boolean): void {
		this.closeChannel();
		const ch = this.host.client.channel(this.topic(privateChannel), {
			config: {
				private: privateChannel,
				broadcast: { self: false, ack: false },
				presence: { key: this.host.me.key, enabled: true },
			},
		});
		this.channel = ch;

		ch.on("broadcast", { event: "m" }, (msg: { payload?: unknown }) => {
			if (this.channel !== ch || !msg.payload) return;
			try {
				this.onMessage(msg.payload as Message);
			} catch (err) {
				console.error("Supabase jump: live message failed", err);
			}
		});

		ch.on("presence", { event: "sync" }, () => {
			if (this.channel !== ch) return;
			this.readPresence(ch);
		});

		ch.subscribe((status, err) => {
			if (this.channel !== ch || this.disposed) return;
			if (status === REALTIME_SUBSCRIBE_STATES.SUBSCRIBED) {
				this.joined = true;
				this.everJoined = true;
				void ch.track({ ...this.host.me });
				this.sendHello();
				return;
			}
			if (status === REALTIME_SUBSCRIBE_STATES.CHANNEL_ERROR && privateChannel && !this.everJoined) {
				const reason = err?.message ?? "";
				if (/unauthori[sz]ed|not authori[sz]ed|permission|policy|denied/i.test(reason)) {
					this.host.onPrivateRejected();
					this.openChannel(false);
					return;
				}
			}
			this.joined = false;
		});
	}

	private closeChannel(): void {
		const ch = this.channel;
		this.channel = null;
		this.joined = false;
		if (ch) void this.host.client.removeChannel(ch);
	}

	resync(): void {
		if (this.disposed) return;
		const ch = this.channel;
		const state = String(ch?.state ?? "closed");
		if (!ch || state === "errored" || state === "closed") {
			this.openChannel(this.host.privateChannels);
			return;
		}
		if (this.joined) this.sendHello();
	}

	private readPresence(ch: RealtimeChannel): void {
		const state = ch.presenceState<PeerInfo>();
		const next = new Map<string, PeerInfo>();
		for (const metas of Object.values(state)) {
			for (const meta of metas) {
				if (!meta.key || meta.key === this.host.me.key) continue;
				next.set(meta.key, { key: meta.key, deviceId: meta.deviceId, name: meta.name, color: meta.color });
				if (meta.deviceId) this.seenDevices.add(meta.deviceId);
			}
		}
		for (const key of this.cursors.keys()) {
			if (!next.has(key)) this.cursors.delete(key);
		}
		this.peers = next;
		this.emit("peers");
		this.emit("cursors");
	}

	private send(msg: Message): void {
		const ch = this.channel;
		if (!ch || !this.joined) return;
		const json = JSON.stringify(msg);
		if (json.length <= CHUNK_CHARS) {
			void ch.send({ type: "broadcast", event: "m", payload: msg });
			return;
		}
		const id = randomId(8);
		const n = Math.ceil(json.length / CHUNK_CHARS);
		for (let i = 0; i < n; i++) {
			const part: Message = {
				t: "chunk",
				from: this.host.me.key,
				id,
				i,
				n,
				d: json.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
			};
			void ch.send({ type: "broadcast", event: "m", payload: part });
		}
	}

	private sendHello(): void {
		this.send({
			t: "hello",
			from: this.host.me.key,
			sv: bytesToBase64(Y.encodeStateVector(this.doc)),
			seed: this.seed,
		});
	}

	private sendState(to: string, theirSv: Uint8Array | null, full: boolean, reply: boolean): void {
		const update = full || !theirSv ? Y.encodeStateAsUpdate(this.doc) : Y.encodeStateAsUpdate(this.doc, theirSv);
		if (!full && reply && !meaningful(update)) return;
		this.send({
			t: "state",
			from: this.host.me.key,
			to,
			u: bytesToBase64(update),
			sv: bytesToBase64(Y.encodeStateVector(this.doc)),
			seed: this.seed,
			full,
			reply,
		});
	}

	setCursor(cursor: RelCursor | null): void {
		this.pendingCursor = cursor;
		this.scheduleFlush(CURSOR_FLUSH_MS);
	}

	private scheduleFlush(delay: number): void {
		if (this.flushTimer !== null) return;
		this.flushTimer = window.setTimeout(() => {
			this.flushTimer = null;
			this.flush();
		}, delay);
	}

	private flush(): void {
		if (!this.joined) {
			this.pendingUpdates = [];
			return;
		}
		const updates = this.pendingUpdates;
		this.pendingUpdates = [];
		const cursor = this.pendingCursor;
		this.pendingCursor = undefined;
		if (updates.length === 0 && cursor === undefined) return;
		const msg: Message = { t: "tick", from: this.host.me.key, seed: this.seed };
		if (updates.length > 0) {
			msg.u = bytesToBase64(updates.length === 1 ? (updates[0] as Uint8Array) : Y.mergeUpdates(updates));
		}
		if (cursor !== undefined) msg.c = cursor;
		this.send(msg);
	}

	private onMessage(msg: Message): void {
		if (this.disposed || msg.from === this.host.me.key) return;
		switch (msg.t) {
			case "chunk":
				this.onChunk(msg);
				return;
			case "hello":
				this.onHello(msg);
				return;
			case "state":
				if (msg.to === this.host.me.key) this.onState(msg);
				return;
			case "tick":
				this.onTick(msg);
				return;
			case "req":
				if (msg.to === this.host.me.key) this.sendState(msg.from, null, true, true);
				return;
		}
	}

	private onChunk(msg: Extract<Message, { t: "chunk" }>): void {
		const now = Date.now();
		for (const [id, c] of this.chunks) {
			if (now - c.at > 30000) this.chunks.delete(id);
		}
		let entry = this.chunks.get(msg.id);
		if (!entry) {
			entry = { n: msg.n, parts: new Array<string>(msg.n), got: 0, at: now };
			this.chunks.set(msg.id, entry);
		}
		if (entry.parts[msg.i] === undefined) {
			entry.parts[msg.i] = msg.d;
			entry.got++;
		}
		if (entry.got === entry.n) {
			this.chunks.delete(msg.id);
			this.onMessage(JSON.parse(entry.parts.join("")) as Message);
		}
	}

	private compatible(seed: Seed): boolean {
		return seed.id === this.seed.id;
	}

	private canResolve(peer: string): boolean {
		const now = Date.now();
		if (now - (this.lastResolve.get(peer) ?? 0) < RESOLVE_COOLDOWN_MS) return false;
		this.lastResolve.set(peer, now);
		return true;
	}

	private onHello(msg: Extract<Message, { t: "hello" }>): void {
		if (this.compatible(msg.seed)) {
			this.sendState(msg.from, base64ToBytes(msg.sv), false, false);
		} else if (seedWins(this.seed, msg.seed)) {
			this.sendState(msg.from, null, true, true);
		} else {
			this.send({ t: "req", from: this.host.me.key, to: msg.from });
		}
	}

	private onState(msg: Extract<Message, { t: "state" }>): void {
		if (this.compatible(msg.seed)) {
			Y.applyUpdate(this.doc, base64ToBytes(msg.u), ORIGIN_REMOTE);
			if (!msg.reply) this.sendState(msg.from, base64ToBytes(msg.sv), false, true);
			return;
		}
		if (seedWins(msg.seed, this.seed)) {
			if (msg.full) this.resetTo(base64ToBytes(msg.u), msg.seed);
			else this.send({ t: "req", from: this.host.me.key, to: msg.from });
		} else if (this.canResolve(msg.from)) {
			this.sendState(msg.from, null, true, true);
		}
	}

	private onTick(msg: Extract<Message, { t: "tick" }>): void {
		if (!this.compatible(msg.seed)) {
			if (!this.canResolve(msg.from)) return;
			if (seedWins(msg.seed, this.seed)) this.send({ t: "req", from: this.host.me.key, to: msg.from });
			else this.sendState(msg.from, null, true, true);
			return;
		}
		if (msg.u) Y.applyUpdate(this.doc, base64ToBytes(msg.u), ORIGIN_REMOTE);
		if (msg.c !== undefined) {
			if (msg.c === null) this.cursors.delete(msg.from);
			else this.cursors.set(msg.from, msg.c);
			this.emit("cursors");
		}
	}

	private resetTo(update: Uint8Array, seed: Seed): void {
		const previous = this.text.toJSON();
		const old = this.doc;
		this.doc = new Y.Doc();
		Y.applyUpdate(this.doc, update, ORIGIN_REMOTE);
		this.seed = seed;
		this.pendingUpdates = [];
		this.watchDoc();
		old.destroy();
		this.cursors.clear();
		this.emit("reset");
		this.host.onReset(this, previous);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.flushTimer !== null) {
			window.clearTimeout(this.flushTimer);
			this.flushTimer = null;
		}
		this.flush();
		const ch = this.channel;
		if (ch && this.joined) void ch.untrack();
		this.closeChannel();
		this.listeners.clear();
		this.doc.destroy();
	}
}
