import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Notice } from "obsidian";
import { errorMessage } from "./utils";

export type ConnectionState =
	| "signed-out"
	| "connecting"
	| "online"
	| "offline"
	| "error";

export interface ConnectionHost {
	settings: { supabaseUrl: string; supabaseAnonKey: string; email: string };
	getPassword(): string;
}

const RETRY_STEPS_MS = [3000, 10000, 30000, 60000, 120000];

export function isNetworkError(err: unknown): boolean {
	if (!navigator.onLine) return true;
	const msg = errorMessage(err);
	return /failed to fetch|load failed|network|timed? ?out|offline|fetch error|socket|ECONN|ENOTFOUND/i.test(msg);
}

export class Connection {
	client: SupabaseClient | null = null;
	userId: string | null = null;
	state: ConnectionState = "signed-out";
	lastError = "";

	private listeners = new Set<(state: ConnectionState) => void>();
	private retryTimer: number | null = null;
	private retryStep = 0;
	private connecting: Promise<boolean> | null = null;

	constructor(private host: ConnectionHost) {}

	get ready(): boolean {
		return this.client !== null && this.userId !== null && this.state === "online";
	}

	onChange(cb: (state: ConnectionState) => void): () => void {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	private setState(state: ConnectionState, error = ""): void {
		this.lastError = error;
		if (this.state === state) return;
		this.state = state;
		for (const cb of this.listeners) cb(state);
	}

	connect(interactive = false): Promise<boolean> {
		if (this.connecting) return this.connecting;
		this.connecting = this.doConnect(interactive).finally(() => {
			this.connecting = null;
		});
		return this.connecting;
	}

	private async doConnect(interactive: boolean): Promise<boolean> {
		this.clearRetry();
		const { supabaseUrl, supabaseAnonKey, email } = this.host.settings;
		const password = this.host.getPassword();

		if (!supabaseUrl || !supabaseAnonKey || !email || !password) {
			this.setState("signed-out");
			if (interactive) {
				new Notice("Supabase jump: fill in the project URL, key, email and password first.");
			}
			return false;
		}

		try {
			new URL(supabaseUrl);
		} catch {
			this.setState("error", "Project URL is not valid");
			if (interactive) new Notice("Supabase jump: the project URL doesn't look right.");
			return false;
		}

		this.setState("connecting");

		if (!this.client) {
			this.client = createClient(supabaseUrl, supabaseAnonKey, {
				auth: {
					persistSession: false,
					autoRefreshToken: true,
					detectSessionInUrl: false,
				},
				realtime: {
					heartbeatIntervalMs: 15000,
				},
			});
		}

		try {
			const ok = await this.signIn(email, password, interactive);
			if (!ok) return false;
			this.retryStep = 0;
			this.setState("online");
			return true;
		} catch (err) {
			if (isNetworkError(err)) {
				this.setState("offline", "No connection");
				this.scheduleRetry();
			} else {
				this.setState("error", errorMessage(err));
				if (interactive) new Notice(`Supabase jump: could not connect. ${errorMessage(err)}`, 8000);
			}
			console.error("Supabase jump: connect failed", err);
			return false;
		}
	}

	private async signIn(email: string, password: string, interactive: boolean): Promise<boolean> {
		const client = this.client;
		if (!client) return false;

		const { data, error } = await client.auth.signInWithPassword({ email, password });

		if (!error && data.user) {
			this.userId = data.user.id;
			if (interactive) new Notice("Supabase jump: connected");
			return true;
		}

		if (!error) throw new Error("Sign in returned no user");
		if (error.status === 0 || error.name === "AuthRetryableFetchError") throw error;

		if (error.code === "email_not_confirmed") {
			this.setState("signed-out", "Email not confirmed");
			if (interactive) {
				new Notice(
					"Supabase jump: your email isn't confirmed yet. Click the link Supabase sent you, then press connect again.\n\n" +
						"You can also turn off email confirmation in Supabase under Authentication, Providers, Email.",
					12000,
				);
			}
			return false;
		}

		if (error.code === "invalid_credentials" && interactive) {
			return this.signUp(email, password);
		}

		this.setState("error", error.message);
		if (interactive) new Notice(`Supabase jump: sign in failed. ${error.message}`);
		return false;
	}

	private async signUp(email: string, password: string): Promise<boolean> {
		const client = this.client;
		if (!client) return false;
		const { data, error } = await client.auth.signUp({ email, password });

		if (error) {
			this.setState("error", error.message);
			new Notice(`Supabase jump: sign in failed. ${error.message}`);
			return false;
		}

		if (data.user && data.user.identities && data.user.identities.length === 0) {
			this.setState("error", "Wrong password");
			new Notice("Supabase jump: that email already has an account, but the password is wrong.");
			return false;
		}

		if (!data.session || !data.user) {
			this.setState("signed-out", "Email not confirmed");
			new Notice(
				"Supabase jump: account created. Check your inbox, click the confirmation link, then press connect again.",
				12000,
			);
			return false;
		}

		this.userId = data.user.id;
		new Notice("Supabase jump: account created and connected");
		return true;
	}

	async signOut(): Promise<void> {
		this.clearRetry();
		const client = this.client;
		if (client) {
			try {
				await client.removeAllChannels();
				await client.auth.signOut();
			} catch (err) {
				console.warn("Supabase jump: sign out had a problem", err);
			}
		}
		this.client = null;
		this.userId = null;
		this.setState("signed-out");
	}

	pause(): void {
		void this.client?.auth.stopAutoRefresh();
	}

	async resume(): Promise<void> {
		if (!this.client) return;
		if (this.state === "offline" || this.state === "error") {
			await this.connect();
			return;
		}
		if (this.state !== "online") return;
		try {
			await this.client.auth.startAutoRefresh();
			const { data } = await this.client.auth.getSession();
			if (!data.session) {
				await this.connect();
				return;
			}
			if (!this.client.realtime.isConnected()) this.client.realtime.connect();
		} catch (err) {
			console.warn("Supabase jump: resume check failed", err);
		}
	}

	markOffline(): void {
		if (this.state === "online") {
			this.setState("offline", "No connection");
			this.scheduleRetry();
		}
	}

	private scheduleRetry(): void {
		if (this.retryTimer !== null) return;
		const delay = RETRY_STEPS_MS[Math.min(this.retryStep, RETRY_STEPS_MS.length - 1)] ?? 60000;
		this.retryStep++;
		this.retryTimer = window.setTimeout(() => {
			this.retryTimer = null;
			void this.connect();
		}, delay);
	}

	private clearRetry(): void {
		if (this.retryTimer !== null) {
			window.clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	dispose(): void {
		this.clearRetry();
		this.listeners.clear();
		const client = this.client;
		this.client = null;
		this.userId = null;
		if (client) {
			void client.removeAllChannels();
			void client.auth.stopAutoRefresh();
		}
	}
}
