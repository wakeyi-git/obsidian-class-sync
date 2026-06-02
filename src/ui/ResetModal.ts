import { App, Modal, Notice, Setting } from "obsidian";
import { t } from "../i18n";

const confirmWord = (): string => t("초기화");

/**
 * 서버 데이터 초기화 확인 모달(파괴적). 삭제 범위를 선택하고, 확인 단어를 입력해야 실행된다.
 * Yjs 실시간 데이터는 플러그인이 직접 못 지우므로 수동 안내를 함께 표시한다.
 */
export class ResetModal extends Modal {
	private deleteAccounts = false;
	private confirmValue = "";

	constructor(app: App, private dbCount: number, private onConfirm: (deleteAccounts: boolean) => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("⚠️ 서버 데이터 초기화") });
		contentEl.createEl("p", {
			cls: "class-sync-reset-warn",
			text: t("서버의 모든 학생·공유 CouchDB 데이터베이스({count}개)를 영구 삭제합니다. 되돌릴 수 없습니다.", {
				count: this.dbCount,
			}),
		});
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t(
				"로컬 캐시·프로비저닝 상태가 초기화됩니다. DB만 삭제하면 학급 명단은 유지(재초대로 복구)되고, 계정까지 삭제하면 명단(학생·공유 공간)도 비워집니다.",
			),
		});

		new Setting(contentEl)
			.setName(t("학생 계정(_users)·학급 명단까지 삭제"))
			.setDesc(
				t(
					"끄면 DB만 삭제(계정·명단 유지). 켜면 학생 계정과 학급 명단(학생·공유 공간)까지 완전 삭제 → 처음부터 다시 구성해야 합니다.",
				),
			)
			.addToggle((tg) => tg.setValue(this.deleteAccounts).onChange((v) => (this.deleteAccounts = v)));

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t(
				"Yjs 실시간 데이터는 수동 초기화: NAS에서 yjs-websocket 컨테이너를 재시작하거나 ./data 폴더를 비우세요(docker compose down → data 삭제 → up).",
			),
		});

		const word = confirmWord();
		let runBtn: { setDisabled(v: boolean): unknown } | null = null;
		new Setting(contentEl)
			.setName(t("확인을 위해 ‘{word}’ 입력", { word }))
			.addText((txt) => {
				txt.setPlaceholder(word).onChange((v) => {
					this.confirmValue = v.trim();
					runBtn?.setDisabled(this.confirmValue !== word);
				});
				window.setTimeout(() => txt.inputEl.focus(), 0);
			});

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("취소")).onClick(() => this.close()))
			.addButton((b) => {
				runBtn = b;
				b.setButtonText(t("초기화 실행"))
					.setWarning()
					.setDisabled(true)
					.onClick(async () => {
						if (this.confirmValue !== word) {
							new Notice(t("Class Sync: 확인을 위해 ‘{word}’를 입력하세요.", { word }));
							return;
						}
						this.close();
						await this.onConfirm(this.deleteAccounts);
					});
			});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
