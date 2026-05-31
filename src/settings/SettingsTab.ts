import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ClassSyncSettings, Role } from "./types";

/** SettingsTab가 의존하는 플러그인 동작 (순환 import 방지용 인터페이스). */
export interface SettingsHost extends Plugin {
	settings: ClassSyncSettings;
	saveSettings(): Promise<void>;
	switchRole(role: Role): Promise<void>;
	testConnection(): Promise<void>;
}

export class ClassSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private host: SettingsHost) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.host.settings;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Class Sync (Phase 0 POC)" });

		// --- 역할 ---
		new Setting(containerEl)
			.setName("역할")
			.setDesc("이 vault에서 사용할 역할. 변경 시 mode가 재시작됩니다. (기술문서 §5.3)")
			.addDropdown((dd) =>
				dd
					.addOption("student", "Student Mode")
					.addOption("teacher", "Teacher Mode")
					.setValue(s.role)
					.onChange(async (value) => {
						await this.host.switchRole(value as Role);
						this.display();
					}),
			);

		// --- 식별 정보 ---
		containerEl.createEl("h3", { text: "식별" });

		this.textSetting(containerEl, "학급 ID", "classId", "class_2026_1");
		this.textSetting(containerEl, "사용자 ID", "userId", "student_a");
		this.textSetting(containerEl, "표시 이름", "displayName", "학생A");

		new Setting(containerEl)
			.setName("기기 ID")
			.setDesc("동기화 루프 방지에 사용됩니다 (기술문서 §16.3). 자동 생성됨.")
			.addText((t) =>
				t.setValue(s.deviceId).onChange(async (v) => {
					s.deviceId = v.trim();
					await this.host.saveSettings();
				}),
			);

		// --- CouchDB 연결 ---
		containerEl.createEl("h3", { text: "CouchDB 연결" });

		this.textSetting(containerEl, "CouchDB URL", "couchdbUrl", "https://nas.example.com/couchdb");
		this.textSetting(containerEl, "사용자 이름", "username", "student_a");

		new Setting(containerEl)
			.setName("비밀번호")
			.addText((t) => {
				t.setPlaceholder("********")
					.setValue(s.password)
					.onChange(async (v) => {
						s.password = v;
						await this.host.saveSettings();
					});
				t.inputEl.type = "password";
				noAutoCorrect(t.inputEl);
			});

		this.textSetting(containerEl, "Mirror DB 이름", "remoteDb", "mirror_student_a");

		new Setting(containerEl)
			.setName("연결 테스트")
			.setDesc("Mirror DB에 접근해 연결과 권한을 확인합니다 (기술문서 §22.3).")
			.addButton((b) =>
				b
					.setButtonText("테스트 실행")
					.setCta()
					.onClick(async () => {
						b.setDisabled(true);
						try {
							await this.host.testConnection();
						} finally {
							b.setDisabled(false);
						}
					}),
			);

		// --- 경로 ---
		containerEl.createEl("h3", { text: "경로 매핑" });

		new Setting(containerEl)
			.setName(s.role === "teacher" ? "학생 폴더 (localRoot)" : "로컬 동기화 root (localRoot)")
			.setDesc(
				s.role === "teacher"
					? "검증할 학생 폴더 (예: 학생A). 기술문서 §9.3."
					: "vault root 기준 동기화 root. 비우면 vault 전체. 기술문서 §9.2.",
			)
			.addText((t) =>
				t
					.setPlaceholder(s.role === "teacher" ? "학생A" : "(vault root)")
					.setValue(s.localRoot)
					.onChange(async (v) => {
						s.localRoot = v.trim();
						await this.host.saveSettings();
					}),
			);
	}

	private textSetting(
		containerEl: HTMLElement,
		name: string,
		key: keyof ClassSyncSettings,
		placeholder: string,
	): void {
		const s = this.host.settings;
		new Setting(containerEl).setName(name).addText((t) => {
			t.setPlaceholder(placeholder)
				.setValue(String(s[key] ?? ""))
				.onChange(async (v) => {
					(s[key] as unknown as string) = v.trim();
					await this.host.saveSettings();
				});
			noAutoCorrect(t.inputEl);
		});
	}
}

/** 모바일에서 자격증명/ID가 자동 대문자화·자동완성으로 망가지는 것을 방지. */
function noAutoCorrect(el: HTMLInputElement): void {
	el.setAttribute("autocapitalize", "none");
	el.setAttribute("autocorrect", "off");
	el.setAttribute("autocomplete", "off");
	el.spellcheck = false;
}
