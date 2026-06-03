import { App, Modal, Setting } from "obsidian";
import { t } from "../i18n";

export interface ConfirmOptions {
	title: string;
	/** 본문(줄바꿈 \n으로 여러 단락). */
	message: string;
	confirmText?: string;
	warning?: boolean;
	onConfirm: () => void | Promise<void>;
}

/** 간단한 확인 모달(파괴적 동작 실수 방지). 서버 초기화처럼 단어 입력까지는 필요 없는 경우에 쓴다. */
export class ConfirmModal extends Modal {
	constructor(app: App, private opts: ConfirmOptions) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.opts.title });
		for (const line of this.opts.message.split("\n")) {
			if (line.trim()) contentEl.createEl("p", { cls: "setting-item-description", text: line });
		}
		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("취소")).onClick(() => this.close()))
			.addButton((b) => {
				b.setButtonText(this.opts.confirmText ?? t("삭제"));
				if (this.opts.warning) b.setWarning();
				b.onClick(async () => {
					this.close();
					await this.opts.onConfirm();
				});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
