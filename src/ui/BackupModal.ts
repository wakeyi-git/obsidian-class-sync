import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

/** 설정 내보내기 모달 — 자격증명 제외된 JSON을 보여주고 복사. 기술문서 §22.4. */
export class ExportModal extends Modal {
	constructor(app: App, private json: string) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("설정 내보내기") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t(
				"아래 내용을 복사해 보관하거나 다른 기기에 붙여넣으세요. 보안을 위해 비밀번호·Yjs 토큰·학생 비밀번호는 제외됩니다.",
			),
		});

		const ta = contentEl.createEl("textarea", { cls: "class-sync-backup-input" });
		ta.rows = 12;
		ta.value = this.json;
		ta.readOnly = true;

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText(t("클립보드에 복사"))
					.setCta()
					.onClick(async () => {
						await navigator.clipboard.writeText(this.json).catch(() => {
							ta.select();
						});
						new Notice(t("Class Sync: 설정을 복사했습니다."));
					}),
			)
			.addButton((b) => b.setButtonText(t("닫기")).onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 설정 가져오기 모달 — JSON 붙여넣기 후 적용. */
export class ImportModal extends Modal {
	private value = "";
	constructor(app: App, private onImport: (json: string) => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("설정 가져오기") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t(
				"내보낸 JSON을 붙여넣으세요. 학생·공유 공간·옵션이 복원됩니다. 비밀번호/토큰은 이 기기에서 다시 입력해야 하며, 가져온 학생은 재초대가 필요합니다.",
			),
		});

		const ta = contentEl.createEl("textarea", { cls: "class-sync-backup-input" });
		ta.rows = 12;
		ta.placeholder = t("여기에 설정 JSON을 붙여넣기");
		ta.oninput = () => (this.value = ta.value);
		window.setTimeout(() => ta.focus(), 0);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("취소")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("가져오기"))
					.setCta()
					.onClick(async () => {
						const v = this.value.trim();
						if (!v) {
							new Notice(t("Class Sync: 내용을 붙여넣으세요."));
							return;
						}
						this.close();
						await this.onImport(v);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
