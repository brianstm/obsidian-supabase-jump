import { setIcon, setTooltip } from "obsidian";
import { timeAgo } from "./utils";

export type StatusKind = "signed-out" | "connecting" | "synced" | "syncing" | "offline" | "error";

export interface StatusInfo {
	kind: StatusKind;
	pending: number;
	peers: string[];
	lastSync: number;
	realtime: boolean;
	error: string;
}

const ICONS: Record<StatusKind, string> = {
	"signed-out": "cloud-off",
	connecting: "loader",
	synced: "cloud",
	syncing: "refresh-cw",
	offline: "wifi-off",
	error: "alert-triangle",
};

export class StatusBar {
	private iconEl: HTMLElement;
	private textEl: HTMLElement;
	private lastKey = "";

	constructor(private el: HTMLElement) {
		el.addClass("sbj-status");
		this.iconEl = el.createSpan({ cls: "sbj-status-icon" });
		this.textEl = el.createSpan({ cls: "sbj-status-text" });
	}

	render(info: StatusInfo): void {
		const label = this.label(info);
		const tip = this.tooltip(info);
		const key = `${info.kind}|${label}|${tip}`;
		if (key === this.lastKey) return;
		this.lastKey = key;
		setIcon(this.iconEl, ICONS[info.kind]);
		this.el.toggleClass("is-syncing", info.kind === "syncing");
		this.el.toggleClass("is-error", info.kind === "error");
		this.textEl.setText(label);
		setTooltip(this.el, tip, { placement: "top" });
	}

	private label(info: StatusInfo): string {
		switch (info.kind) {
			case "signed-out":
				return "Not connected";
			case "connecting":
				return "Connecting";
			case "syncing":
				return info.pending > 0 ? `Syncing ${info.pending}` : "Syncing";
			case "offline":
				return info.pending > 0 ? `Offline, ${info.pending} waiting` : "Offline";
			case "error":
				return "Sync error";
			case "synced":
				return info.peers.length > 0 ? `Live with ${info.peers.length}` : "Synced";
		}
	}

	private tooltip(info: StatusInfo): string {
		const lines: string[] = [];
		if (info.kind === "error" && info.error) lines.push(info.error);
		if (info.peers.length > 0) lines.push(`Also editing this note: ${info.peers.join(", ")}`);
		if (info.lastSync > 0) lines.push(`Last full sync ${timeAgo(info.lastSync)}`);
		if (info.kind === "synced" && !info.realtime) lines.push("Live updates paused, checking every 20 seconds");
		lines.push("Click for sync options");
		return lines.join("\n");
	}
}
