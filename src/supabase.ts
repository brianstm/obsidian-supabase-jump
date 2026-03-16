import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { Notice } from "obsidian";

export type SyncStatus = "offline" | "synced" | "syncing" | "error";

const STATUS_LABEL: Record<SyncStatus, string> = {
	offline: "🔴 Offline",
	synced: "🟢 Synced",
	syncing: "🔄 Syncing",
	error: "⚠️ Error",
};

export interface SupabaseHost {
	settings: {
		supabaseUrl: string;
		supabaseAnonKey: string;
		email: string;
		password: string;
	};
	statusBarItem: HTMLElement;
}

export class SupabaseManager {
	client: SupabaseClient | null = null;
	private host: SupabaseHost;
	private channels: ReturnType<SupabaseClient["channel"]>[] = [];
	private syncIntervals: number[] = [];

	constructor(host: SupabaseHost) {
		this.host = host;
	}

	setStatus(status: SyncStatus): void {
		this.host.statusBarItem.setText(STATUS_LABEL[status]);
	}

	async init(): Promise<void> {
		const { supabaseUrl, supabaseAnonKey, email } = this.host.settings;

		if (!supabaseUrl || !supabaseAnonKey || !email) {
			this.setStatus("offline");
			return;
		}

		let parsedUrl: URL;
		try {
			parsedUrl = new URL(supabaseUrl);
		} catch {
			this.setStatus("error");
			new Notice(
				"SupaBase Jump: Project URL is not a valid URL - check your settings",
			);
			return;
		}

		if (!parsedUrl.hostname.endsWith(".supabase.co")) {
			console.warn(
				"SupaBase Jump: Project URL does not look like a Supabase URL:",
				supabaseUrl,
			);
		}

		try {
			this.client = createClient(supabaseUrl, supabaseAnonKey, {
				auth: {
					persistSession: true,
					autoRefreshToken: true,
					detectSessionInUrl: false,
				},
			});
			await this.signIn();
		} catch (err) {
			console.error("SupaBase Jump: init error", err);
			this.client = null;
			this.setStatus("error");
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`SupaBase Jump: connection failed - ${msg}`, 8000);
		}
	}

	/**
	 * Attempts signInWithPassword. Falls back to signUp when Supabase returns
	 * "invalid_credentials" - this covers the first-run case on projects where
	 * email confirmation is disabled.
	 *
	 * Network-level throws (e.g. "Failed to fetch" when the project is paused
	 * or the URL is unreachable) are re-thrown as plain Errors so init()'s
	 * catch block can surface them in the Notice.
	 */
	async signIn(): Promise<void> {
		if (!this.client) return;

		const { email, password } = this.host.settings;
		if (!email || !password) {
			this.setStatus("offline");
			new Notice("SupaBase Jump: Email and password are required");
			return;
		}

		let signInResult: Awaited<
			ReturnType<SupabaseClient["auth"]["signInWithPassword"]>
		>;
		try {
			signInResult = await this.client.auth.signInWithPassword({
				email,
				password,
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`network error during sign-in - ${msg}`);
		}

		const { error } = signInResult;

		if (!error) {
			this.setStatus("synced");
			new Notice("SupaBase Jump: Connected");
			return;
		}

		if (error.code === "email_not_confirmed") {
			this.setStatus("offline");
			new Notice(
				"SupaBase Jump: email not confirmed\n\n" +
					"Check your inbox and click the confirmation link, then press connect again.\n\n" +
					'Or disable email confirmation: Supabase \u2192 authentication \u2192 providers \u2192 email \u2192 uncheck "Confirm email"',
				12000,
			);
			return;
		}

		if (error.code === "invalid_credentials") {
			let signUpResult: Awaited<
				ReturnType<SupabaseClient["auth"]["signUp"]>
			>;
			try {
				signUpResult = await this.client.auth.signUp({
					email,
					password,
				});
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				throw new Error(`network error during sign-up - ${msg}`);
			}

			if (signUpResult.error) {
				console.error(
					"SupaBase Jump: sign-up failed",
					signUpResult.error,
				);
				this.setStatus("error");
				new Notice(
					`SupaBase Jump: sign-up failed - ${signUpResult.error.message}`,
				);
				return;
			}

			const confirmed = signUpResult.data.user?.confirmed_at;
			if (!confirmed) {
				this.setStatus("offline");
				new Notice(
					"SupaBase Jump: account created - confirmation email sent\n\n" +
						"click the link in the email, then press connect\n\n" +
						'tip: disable email confirmation in supabase \u2192 authentication \u2192 providers \u2192 email \u2192 uncheck "Confirm email" to skip this step',
					12000,
				);
			} else {
				this.setStatus("synced");
				new Notice("SupaBase Jump: Account created and connected");
			}
			return;
		}

		console.error("SupaBase Jump: sign-in failed", error);
		this.setStatus("error");
		new Notice(`SupaBase Jump: sign-in failed - ${error.message}`);
	}

	async signOut(): Promise<void> {
		if (!this.client) return;
		await this.client.auth.signOut();
		this.setStatus("offline");
		new Notice("SupaBase Jump: Signed out");
	}

	registerChannel(channel: ReturnType<SupabaseClient["channel"]>) {
		this.channels.push(channel);
		return channel;
	}

	registerSyncInterval(id: number) {
		this.syncIntervals.push(id);
		return id;
	}

	cleanup(): void {
		if (this.client) {
			void this.client.removeAllChannels();
		}
		this.channels = [];

		this.syncIntervals.forEach((id) => window.clearInterval(id));
		this.syncIntervals = [];

		this.client = null;
		this.setStatus("offline");
	}
}
