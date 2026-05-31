import { App, Plugin, PluginSettingTab, Setting } from "obsidian";
import { ClassSyncSettings, StudentConfig } from "./types";

/** SettingsTab가 의존하는 플러그인 동작 (순환 import 방지용 인터페이스). */
export interface SettingsHost extends Plugin {
	settings: ClassSyncSettings;
	saveSettings(): Promise<void>;
	testConnection(): Promise<void>;
	restartMode(): Promise<void>;
	resetSetup(): Promise<void>;
	inviteStudent(student: StudentConfig): Promise<void>;
	ingestInvite(code: string): Promise<void>;
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
		this.renderRole(s);

		if (s.role === "teacher") this.renderTeacher(s);
		else this.renderStudent(s);

		this.renderSyncOptions(s);
		this.renderApplyAndReset(s);
	}

	// --- 역할 (잠금) ---
	private renderRole(s: ClassSyncSettings): void {
		const roleLabel = s.role === "teacher" ? "Teacher Mode (교사)" : "Student Mode (학생)";
		new Setting(this.containerEl)
			.setName("역할")
			.setDesc(
				s.setupComplete
					? "역할은 최초 1회 설정 후 잠깁니다. 변경하려면 아래 '역할 재설정'을 사용하세요."
					: "아직 역할이 설정되지 않았습니다.",
			)
			.addText((t) => t.setValue(s.setupComplete ? roleLabel : "(미설정)").setDisabled(true));
	}

	// --- Teacher Mode ---
	private renderTeacher(s: ClassSyncSettings): void {
		const c = this.containerEl;

		c.createEl("h3", { text: "학급" });
		this.textSetting("학급 ID", "classId", "class_2026_1");
		this.textSetting("표시 이름", "displayName", "교사");

		c.createEl("h3", { text: "관리자 계정" });
		c.createEl("p", {
			cls: "setting-item-description",
			text: "CouchDB 관리자 자격증명. 학생 계정·DB·권한을 생성하는 데 쓰이며 이 기기에만 저장됩니다.",
		});
		this.textSetting("CouchDB URL", "couchdbUrl", "https://nas.example.com");
		this.textSetting("관리자 사용자", "username", "admin");
		this.passwordSetting();

		new Setting(c)
			.setName("연결 테스트")
			.setDesc("모든 학생 mirror DB 접근/권한을 확인합니다.")
			.addButton((b) =>
				b.setButtonText("테스트 실행").setCta().onClick(() => this.runAsync(b, () => this.host.testConnection())),
			);

		// 학생 목록 (카드)
		c.createEl("h3", { text: "학생 목록" });
		if (s.students.length === 0) {
			c.createEl("p", { cls: "setting-item-description", text: "아직 학생이 없습니다. 아래 '학생 추가'로 시작하세요." });
		}
		s.students.forEach((st, i) => this.renderStudentCard(st, i));

		new Setting(c).addButton((b) =>
			b
				.setButtonText("+ 학생 추가")
				.setCta()
				.onClick(async () => {
					s.students.push({ studentId: "", studentName: "", remoteDb: "", localRoot: "", username: "" });
					await this.host.saveSettings();
					this.display();
				}),
		);
	}

	private renderStudentCard(st: StudentConfig, index: number): void {
		const card = this.containerEl.createDiv({ cls: "class-sync-student-card" });

		new Setting(card)
			.setName(st.studentName || st.studentId || `학생 ${index + 1}`)
			.setHeading()
			.addButton((b) =>
				b
					.setButtonText(st.provisioned ? "초대 재발급" : "초대")
					.setCta()
					.onClick(() => this.runAsync(b, async () => { await this.host.inviteStudent(st); this.display(); })),
			)
			.addButton((b) =>
				b
					.setButtonText("삭제")
					.setWarning()
					.onClick(async () => {
						this.host.settings.students.splice(index, 1);
						await this.host.saveSettings();
						this.display();
					}),
			);

		this.studentField(card, "이름", st, "studentName", "학생A");
		this.studentField(card, "학생 ID", st, "studentId", "student_a");
		// 비우면 초대 시점에 학생 ID로 자동 채움 (계정=ID, DB=mirror_<ID>, 폴더=이름/ID)
		this.studentField(card, "Mirror DB (비우면 자동)", st, "remoteDb", "mirror_<학생ID>");
		this.studentField(card, "폴더 localRoot (비우면 자동)", st, "localRoot", "<이름 또는 학생ID>");

		card.createEl("div", {
			cls: "class-sync-student-status",
			text: st.provisioned ? "상태: 프로비저닝됨 ✓" : "상태: 미프로비저닝 — '초대'를 누르면 계정/DB가 생성됩니다.",
		});
	}

	// --- Student Mode ---
	private renderStudent(s: ClassSyncSettings): void {
		const c = this.containerEl;

		c.createEl("h3", { text: "초대로 설정" });
		c.createEl("p", {
			cls: "setting-item-description",
			text: "교사에게 받은 QR을 휴대폰 카메라로 스캔하면 자동 설정됩니다. 또는 초대 코드를 아래에 붙여넣으세요.",
		});

		let codeValue = "";
		new Setting(c)
			.setName("초대 코드")
			.addText((t) => {
				t.setPlaceholder("교사에게 받은 초대 코드 붙여넣기").onChange((v) => (codeValue = v));
				noAutoCorrect(t.inputEl);
			})
			.addButton((b) =>
				b
					.setButtonText("적용")
					.setCta()
					.onClick(() => this.runAsync(b, async () => { await this.host.ingestInvite(codeValue); this.display(); })),
			);

		c.createEl("h3", { text: "연결 정보" });
		c.createEl("p", { cls: "setting-item-description", text: "초대로 자동 설정됩니다." });
		this.readonlySetting("학급 ID", s.classId);
		this.readonlySetting("이름", s.displayName);
		this.readonlySetting("CouchDB URL", s.couchdbUrl || "(미설정)");
		this.readonlySetting("Mirror DB", s.remoteDb || "(미설정)");
		this.readonlySetting("계정", s.username || "(미설정)");

		new Setting(c)
			.setName("연결 테스트")
			.setDesc("내 mirror DB 접근/권한을 확인합니다.")
			.addButton((b) =>
				b.setButtonText("테스트 실행").setCta().onClick(() => this.runAsync(b, () => this.host.testConnection())),
			);
	}

	// --- 공통: 동기화 옵션 ---
	private renderSyncOptions(s: ClassSyncSettings): void {
		const c = this.containerEl;
		c.createEl("h3", { text: "동기화" });

		new Setting(c)
			.setName("자동 동기화")
			.setDesc("켜면 실시간 양방향 동기화. 끄면 수동 동기화만. 변경 시 즉시 적용됩니다.")
			.addToggle((t) =>
				t.setValue(s.autoSync).onChange(async (v) => {
					s.autoSync = v;
					await this.host.saveSettings();
					await this.host.restartMode();
				}),
			);

		new Setting(c)
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

		new Setting(c)
			.setName("보관 폴더")
			.setDesc("'보관 폴더로 이동' 정책일 때 삭제 파일이 모이는 폴더. 이 폴더에서 지우면 DB에서도 영구 삭제됩니다.")
			.addText((t) =>
				t.setPlaceholder("_삭제됨").setValue(s.archiveFolder).onChange(async (v) => {
					s.archiveFolder = v.trim() || "_삭제됨";
					await this.host.saveSettings();
				}),
			);

		new Setting(c)
			.setName("제외 폴더")
			.setDesc("동기화에서 제외할 폴더(쉼표로 구분). 기술문서 §11.1.")
			.addText((t) =>
				t.setValue(s.excludeFolders.join(", ")).onChange(async (v) => {
					s.excludeFolders = v.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
					await this.host.saveSettings();
				}),
			);
	}

	private renderApplyAndReset(s: ClassSyncSettings): void {
		const c = this.containerEl;
		new Setting(c)
			.setName("설정 적용 (동기화 재시작)")
			.setDesc("연결·학생 목록·옵션 변경을 실행 중인 동기화에 반영합니다.")
			.addButton((b) => b.setButtonText("적용").onClick(() => this.runAsync(b, () => this.host.restartMode())));

		if (s.setupComplete) {
			c.createEl("h3", { text: "역할 재설정" });
			new Setting(c)
				.setName("역할 재설정 (동기화 상태 초기화)")
				.setDesc("역할을 다시 선택합니다. 동기화 체크포인트가 초기화됩니다. vault 파일은 삭제되지 않습니다.")
				.addButton((b) =>
					b.setButtonText("재설정").setWarning().onClick(async () => {
						await this.host.resetSetup();
						this.display();
					}),
				);
		}
	}

	// --- 헬퍼 ---
	private studentField(card: HTMLElement, name: string, st: StudentConfig, key: keyof StudentConfig, placeholder: string): void {
		new Setting(card).setName(name).addText((t) => {
			t.setPlaceholder(placeholder)
				.setValue(String(st[key] ?? ""))
				.onChange(async (v) => {
					(st[key] as unknown as string) = v.trim();
					await this.host.saveSettings();
				});
			noAutoCorrect(t.inputEl);
		});
	}

	private textSetting(name: string, key: keyof ClassSyncSettings, placeholder: string): void {
		const s = this.host.settings;
		new Setting(this.containerEl).setName(name).addText((t) => {
			t.setPlaceholder(placeholder)
				.setValue(String(s[key] ?? ""))
				.onChange(async (v) => {
					(s[key] as unknown as string) = v.trim();
					await this.host.saveSettings();
				});
			noAutoCorrect(t.inputEl);
		});
	}

	private passwordSetting(): void {
		const s = this.host.settings;
		new Setting(this.containerEl).setName("관리자 비밀번호").addText((t) => {
			t.setPlaceholder("********").setValue(s.password).onChange(async (v) => {
				s.password = v;
				await this.host.saveSettings();
			});
			t.inputEl.type = "password";
			noAutoCorrect(t.inputEl);
		});
	}

	private readonlySetting(name: string, value: string): void {
		new Setting(this.containerEl).setName(name).addText((t) => t.setValue(value).setDisabled(true));
	}

	private async runAsync(b: { setDisabled(v: boolean): unknown }, fn: () => Promise<void>): Promise<void> {
		b.setDisabled(true);
		try {
			await fn();
		} finally {
			b.setDisabled(false);
		}
	}
}

/** 모바일에서 자격증명/ID가 자동 대문자화·자동완성으로 망가지는 것을 방지. */
function noAutoCorrect(el: HTMLInputElement): void {
	el.setAttribute("autocapitalize", "none");
	el.setAttribute("autocorrect", "off");
	el.setAttribute("autocomplete", "off");
	el.spellcheck = false;
}
