import { App, Modal, Setting } from "obsidian";
import { Role } from "../settings/types";

/**
 * 최초 실행 역할 선택 화면. 기술문서 §21.1.
 * 역할은 한 번 선택하면 잠긴다(이후 설정에서 '재설정'으로만 변경).
 */
export class RoleSetupModal extends Modal {
	constructor(
		app: App,
		private onChoose: (role: Role) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "Class Sync 역할 선택" });
		contentEl.createEl("p", {
			text: "이 vault에서 사용할 역할을 선택하세요. 선택 후에는 변경할 수 없으며, 바꾸려면 설정에서 데이터 초기화가 필요합니다.",
		});

		new Setting(contentEl)
			.setName("Student Mode")
			.setDesc("이 vault를 교사의 학생별 폴더와 동기화합니다. 내가 만든 파일을 교사에게 보내고, 교사가 만든 파일을 받습니다.")
			.addButton((b) =>
				b
					.setButtonText("Student 선택")
					.setCta()
					.onClick(() => this.choose("student")),
			);

		new Setting(contentEl)
			.setName("Teacher Mode")
			.setDesc("이 vault의 학생 폴더를 각 학생 vault와 동기화합니다. 학생 폴더에서 파일을 만들고 수정하면 학생에게 반영됩니다.")
			.addButton((b) => b.setButtonText("Teacher 선택").onClick(() => this.choose("teacher")));
	}

	private choose(role: Role): void {
		this.onChoose(role);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
