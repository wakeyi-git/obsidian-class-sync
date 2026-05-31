import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ClassSyncSettings } from "./types";

/** SettingsTab가 의존하는 플러그인 동작 (순환 import 방지용 인터페이스). */
export interface SettingsHost extends Plugin {
	settings: ClassSyncSettings;
	saveSettings(): Promise<void>;
	testConnection(): Promise<void>;
	restartMode(): Promise<void>;
	resetSetup(): Promise<void>;
}

export class ClassSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private host: SettingsHost) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.host.settings;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Class Sync" });

		// --- 역할 (최초 설정 후 잠금) ---
		const roleLabel = s.role === "teacher" ? "Teacher Mode" : "Student Mode";
		if (s.setupComplete) {
			new Setting(containerEl)
				.setName("역할")
				.setDesc("역할은 최초 1회 설정 후 잠깁니다. 변경하려면 아래 '역할 재설정'을 사용하세요.")
				.addText((t) => {
					t.setValue(roleLabel).setDisabled(true);
				});
		} else {
			new Setting(containerEl)
				.setName("역할")
				.setDesc("아직 역할이 설정되지 않았습니다. 플러그인을 다시 로드하면 역할 선택 화면이 표시됩니다.")
				.addText((t) => t.setValue("(미설정)").setDisabled(true));
		}

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
			.setDesc("최신 설정으로 Mirror DB 접근/권한을 확인합니다 (기술문서 §22.3).")
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
					? "동기화할 학생 폴더 (예: 학생A). 기술문서 §9.3."
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

		// --- 동기화 옵션 ---
		containerEl.createEl("h3", { text: "동기화" });

		new Setting(containerEl)
			.setName("자동 동기화")
			.setDesc("켜면 로컬 변경 감시 + 원격 변경 구독이 활성화됩니다. 끄면 수동 동기화만 가능. 변경 시 즉시 적용됩니다.")
			.addToggle((t) =>
				t.setValue(s.autoSync).onChange(async (v) => {
					s.autoSync = v;
					await this.host.saveSettings();
					await this.host.restartMode(); // 실행 중인 엔진에 즉시 반영
				}),
			);

		new Setting(containerEl)
			.setName("삭제 정책")
			.setDesc("삭제·이름변경 시 상대 vault의 옛 파일 처리. 기술문서 §15.")
			.addDropdown((dd) =>
				dd
					.addOption("archive", "보관 폴더로 이동")
					.addOption("propagate-delete", "즉시 삭제")
					.addOption("ignore-delete", "삭제 무시")
					.setValue(s.deletePolicy)
					.onChange(async (v) => {
						s.deletePolicy = v as ClassSyncSettings["deletePolicy"];
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("보관 폴더")
			.setDesc("'보관 폴더로 이동' 정책일 때 삭제 파일이 모이는 폴더. 이 폴더에서 지우면 DB에서도 영구 삭제됩니다. (점으로 시작하면 Obsidian이 표시하지 않으니 보이는 이름 권장)")
			.addText((t) =>
				t
					.setPlaceholder("_삭제됨")
					.setValue(s.archiveFolder)
					.onChange(async (v) => {
						s.archiveFolder = v.trim() || "_삭제됨";
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("제외 폴더")
			.setDesc("동기화에서 제외할 폴더(쉼표로 구분). 기술문서 §11.1.")
			.addText((t) =>
				t
					.setValue(s.excludeFolders.join(", "))
					.onChange(async (v) => {
						s.excludeFolders = v
							.split(",")
							.map((x) => x.trim())
							.filter((x) => x.length > 0);
						await this.host.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("설정 적용 (동기화 재시작)")
			.setDesc("CouchDB 연결·경로·옵션 변경을 실행 중인 동기화에 반영합니다.")
			.addButton((b) =>
				b.setButtonText("적용").onClick(async () => {
					b.setDisabled(true);
					try {
						await this.host.restartMode();
					} finally {
						b.setDisabled(false);
					}
				}),
			);

		// --- 위험 구역: 역할 재설정 ---
		if (s.setupComplete) {
			containerEl.createEl("h3", { text: "역할 재설정" });
			new Setting(containerEl)
				.setName("역할 재설정 (동기화 상태 초기화)")
				.setDesc("역할을 다시 선택합니다. 동기화 체크포인트(last_seq)와 상태가 초기화되어 다음 시작 시 전체 동기화가 다시 수행됩니다. vault 파일은 삭제되지 않습니다.")
				.addButton((b) =>
					b
						.setButtonText("재설정")
						.setWarning()
						.onClick(async () => {
							await this.host.resetSetup();
							this.display();
						}),
				);
		}
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
