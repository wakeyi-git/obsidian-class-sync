import { ItemView, WorkspaceLeaf } from "obsidian";
import { Logger, LogEntry } from "../core/log/Logger";

export const LOG_VIEW_TYPE = "class-sync-log-view";

/** POC 검증 로그를 실시간으로 보여주는 사이드 패널. */
export class LogView extends ItemView {
	private unsubscribe: (() => void) | null = null;
	private logEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, private logger: Logger) {
		super(leaf);
	}

	getViewType(): string {
		return LOG_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Class Sync 로그";
	}

	getIcon(): string {
		return "refresh-cw";
	}

	async onOpen(): Promise<void> {
		const container = this.contentEl;
		container.empty();

		const toolbar = container.createDiv({ cls: "class-sync-log-toolbar" });
		const clearBtn = toolbar.createEl("button", { text: "지우기" });
		clearBtn.onclick = () => this.logger.clear();

		this.logEl = container.createDiv({ cls: "class-sync-log-view" });

		// 기존 버퍼 렌더
		for (const entry of this.logger.getEntries()) this.append(entry);

		this.unsubscribe = this.logger.subscribe((entry) => {
			if (entry.message === "__clear__") {
				this.logEl?.empty();
				return;
			}
			this.append(entry);
		});
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private append(entry: LogEntry): void {
		if (!this.logEl) return;
		const line = this.logEl.createDiv({ cls: `csl-line csl-${entry.level}` });
		const time = new Date(entry.ts).toLocaleTimeString();
		line.createSpan({ cls: "csl-ts", text: time });
		line.createSpan({ text: entry.message });
		this.logEl.scrollTop = this.logEl.scrollHeight;
	}
}
