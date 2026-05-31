import { App, Modal, Setting } from "obsidian";
import { Role } from "../settings/types";

/**
 * 최초 실행 역할 선택 화면. 기술문서 §21.1.
 * 역할은 한 번 선택하면 잠긴다(이후 설정에서 '재설정'으로만 변경).
 * 학생은 교사 초대 코드로 바로 설정할 수도 있다.
 */
export class RoleSetupModal extends Modal {
	constructor(
		app: App,
		private onChoose: (role: Role) => void,
		private onInvite: (code: string) => void,
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
			.setDesc("교사의 학생 폴더와 내 vault를 동기화합니다. 보통 교사 초대(QR/코드)로 설정합니다.")
			.addButton((b) => b.setButtonText("Student 선택").setCta().onClick(() => this.choose("student")));

		new Setting(contentEl)
			.setName("Teacher Mode")
			.setDesc("이 vault의 학생 폴더를 각 학생 vault와 동기화하고, 학생을 초대해 학급을 관리합니다.")
			.addButton((b) => b.setButtonText("Teacher 선택").onClick(() => this.choose("teacher")));

		contentEl.createEl("h3", { text: "학생: 초대 코드로 바로 설정" });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "교사에게 받은 QR을 휴대폰 카메라로 스캔하면 자동 설정됩니다. 또는 초대 코드를 아래에 붙여넣으세요.",
		});
		let code = "";
		new Setting(contentEl)
			.setName("초대 코드")
			.addText((t) => {
				t.setPlaceholder("초대 코드 붙여넣기").onChange((v) => (code = v));
				t.inputEl.setAttribute("autocapitalize", "none");
				t.inputEl.setAttribute("autocorrect", "off");
			})
			.addButton((b) =>
				b.setButtonText("초대로 설정").onClick(() => {
					if (!code.trim()) return;
					this.onInvite(code);
					this.close();
				}),
			);
	}

	private choose(role: Role): void {
		this.onChoose(role);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
