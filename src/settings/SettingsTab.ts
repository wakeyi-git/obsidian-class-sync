import { App, Plugin, PluginSettingTab, Setting, SettingGroup } from "obsidian";
import { ClassSyncSettings, StudentConfig, SharedSpace } from "./types";
import { ExportModal, ImportModal } from "../ui/BackupModal";

/** SettingsTab가 의존하는 플러그인 동작 (순환 import 방지용 인터페이스). */
export interface SettingsHost extends Plugin {
	settings: ClassSyncSettings;
	saveSettings(): Promise<void>;
	testConnection(): Promise<void>;
	restartMode(): Promise<void>;
	resetSetup(): Promise<void>;
	inviteStudent(student: StudentConfig): Promise<void>;
	ingestInvite(code: string): Promise<void>;
	deployShared(space: SharedSpace): Promise<void>;
	exportSettingsJson(): string;
	importSettingsJson(json: string): Promise<{ ok: boolean; error?: string }>;
}

/**
 * 설정 탭. 섹션을 SettingGroup(.setting-group)으로 묶어 최신 Obsidian 설정 UI 가이드를 따른다.
 * 일반(역할)은 상단에 헤딩 없이 두고, 이후 섹션부터 그룹 헤딩을 붙인다.
 */
export class ClassSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private host: SettingsHost) {
		super(app, host);
	}

	display(): void {
		const { containerEl } = this;
		const s = this.host.settings;
		containerEl.empty();

		// 탭 제목이 이미 플러그인 이름을 표시하므로 상단 제목/그룹 헤딩은 두지 않는다(Obsidian 가이드).
		this.renderRole(s);

		if (s.role === "teacher") this.renderTeacher(s);
		else this.renderStudent(s);

		this.renderSyncOptions(s);
		this.renderBackup();
		this.renderApplyAndReset(s);
	}

	// --- 역할 (상단 일반 설정, 헤딩 없음) ---
	private renderRole(s: ClassSyncSettings): void {
		const roleLabel = s.role === "teacher" ? "Teacher Mode (교사)" : "Student Mode (학생)";
		new Setting(this.containerEl)
			.setName("역할")
			.setDesc(
				s.setupComplete
					? "최초 1회 설정 후 잠기며, 변경하려면 아래 ‘역할 재설정’을 사용하세요."
					: "아직 역할이 설정되지 않았습니다.",
			)
			.addText((t) => t.setValue(s.setupComplete ? roleLabel : "(미설정)").setDisabled(true));
	}

	// --- Teacher Mode ---
	private renderTeacher(s: ClassSyncSettings): void {
		const klass = this.group("학급");
		this.textSetting(klass, "학급 ID", "classId", "class_2026_1");
		this.textSetting(klass, "표시 이름", "displayName", "교사");

		const admin = this.group("관리자 계정", "학생 계정·DB·권한 생성에 쓰이는 자격증명이며 이 기기에만 저장됩니다.");
		this.textSetting(admin, "CouchDB URL", "couchdbUrl", "https://nas.example.com");
		this.textSetting(admin, "관리자 사용자", "username", "admin");
		this.passwordSetting(admin);
		admin.addSetting((set) =>
			set
				.setName("연결 테스트")
				.setDesc("모든 학생 mirror DB 접근/권한을 확인합니다.")
				.addButton((b) =>
					b.setButtonText("테스트 실행").setCta().onClick(() => this.runAsync(b, () => this.host.testConnection())),
				),
		);

		// 학생 목록 (카드)
		const students = this.group(
			"학생 목록",
			s.students.length === 0 ? "아래 ‘학생 추가’로 첫 학생을 등록하세요." : undefined,
		);
		s.students.forEach((st, i) => this.renderStudentCard(students, st, i));
		students.addSetting((set) =>
			set.setClass("class-sync-add-row").addButton((b) =>
				b
					.setButtonText("+ 학생 추가")
					.setCta()
					.onClick(async () => {
						s.students.push({ studentId: "", studentName: "", remoteDb: "", localRoot: "", username: "" });
						await this.host.saveSettings();
						this.display();
					}),
			),
		);

		// 공유 공간 (모둠/학급)
		const shared = this.group("공유 공간 (모둠/학급)", "멤버를 고르고 ‘배포’하면 공유 DB·권한이 생성되어 멤버 학생에게 전파됩니다.");
		s.sharedSpaces.forEach((sp, i) => this.renderSharedCard(shared, sp, i));
		shared.addSetting((set) =>
			set.setClass("class-sync-add-row").addButton((b) =>
				b
					.setButtonText("+ 공유 공간 추가")
					.setCta()
					.onClick(async () => {
						const id = `g${Date.now().toString(36)}`;
						s.sharedSpaces.push({ id, name: "", remoteDb: `share_${id}`, folder: "", members: [] });
						await this.host.saveSettings();
						this.display();
					}),
			),
		);

		// 실시간 공동 편집 (Yjs)
		const rt = this.group(
			"실시간 공동 편집 (Yjs)",
			"별도 Yjs WebSocket 서버로 공유 폴더 문서를 글자 단위 동시 편집하며, ‘배포’ 시 학생에게 전파됩니다.",
		);
		rt.addSetting((set) =>
			set.setName("실시간 편집 사용").addToggle((t) =>
				t.setValue(s.realtimeEnabled).onChange(async (v) => {
					s.realtimeEnabled = v;
					await this.host.saveSettings();
				}),
			),
		);
		this.textSetting(rt, "Yjs 서버 URL", "yjsServerUrl", "wss://yjs.example.com");
		rt.addSetting((set) =>
			set.setName("Yjs 토큰").addText((t) => {
				t.setPlaceholder("공유 비밀 토큰").setValue(s.yjsToken).onChange(async (v) => {
					s.yjsToken = v.trim();
					await this.host.saveSettings();
				});
				t.inputEl.type = "password";
				noAutoCorrect(t.inputEl);
			}),
		);
		rt.addSetting((set) =>
			set
				.setName("세션 중 스냅샷 주기(초)")
				.setDesc("실시간 세션 중 일정 주기로 CouchDB에 본문을 저장해 오프라인 멤버에 반영합니다(0=끔).")
				.addText((t) => {
					t.setPlaceholder("0").setValue(String(s.realtimeSnapshotSec));
					t.inputEl.type = "number";
					t.onChange(async (v) => {
						const n = Number(v);
						s.realtimeSnapshotSec = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
						await this.host.saveSettings();
					});
				}),
		);
	}

	private renderSharedCard(group: SettingGroup, sp: SharedSpace, index: number): void {
		const s = this.host.settings;
		const card = group.listEl.createDiv({ cls: "class-sync-student-card" });

		new Setting(card)
			.setName(sp.name || `공유 공간 ${index + 1}`)
			.setHeading()
			.addButton((b) =>
				b
					.setButtonText(sp.provisioned ? "재배포" : "배포")
					.setCta()
					.onClick(() => this.runAsync(b, async () => { await this.host.deployShared(sp); this.display(); })),
			)
			.addButton((b) =>
				b
					.setButtonText("삭제")
					.setWarning()
					.onClick(async () => {
						s.sharedSpaces.splice(index, 1);
						await this.host.saveSettings();
						this.display();
					}),
			);

		new Setting(card).setName("이름").addText((t) => {
			t.setPlaceholder("모둠1").setValue(sp.name).onChange(async (v) => {
				sp.name = v.trim();
				if (!sp.folder) sp.folder = v.trim();
				await this.host.saveSettings();
			});
			noAutoCorrect(t.inputEl);
		});
		new Setting(card).setName("폴더").addText((t) => {
			t.setPlaceholder("모둠1").setValue(sp.folder).onChange(async (v) => {
				sp.folder = v.trim();
				await this.host.saveSettings();
			});
			noAutoCorrect(t.inputEl);
		});

		const membersEl = card.createDiv({ cls: "class-sync-student-status" });
		membersEl.createSpan({ text: "멤버:" });
		for (const st of s.students) {
			if (!st.studentId) continue;
			new Setting(card).setName(st.studentName || st.studentId).addToggle((t) =>
				t.setValue(sp.members.includes(st.studentId)).onChange(async (v) => {
					if (v && !sp.members.includes(st.studentId)) sp.members.push(st.studentId);
					else if (!v) sp.members = sp.members.filter((m) => m !== st.studentId);
					await this.host.saveSettings();
				}),
			);
		}
		card.createEl("div", {
			cls: "class-sync-student-status",
			text: sp.provisioned ? `DB: ${sp.remoteDb} · 프로비저닝됨 ✓` : `DB: ${sp.remoteDb} · 미배포`,
		});
	}

	private renderStudentCard(group: SettingGroup, st: StudentConfig, index: number): void {
		const card = group.listEl.createDiv({ cls: "class-sync-student-card" });

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
		this.studentField(card, "폴더 (비우면 자동)", st, "localRoot", "<이름 또는 학생ID>");

		card.createEl("div", {
			cls: "class-sync-student-status",
			text: st.provisioned ? "상태: 프로비저닝됨 ✓" : "상태: 미프로비저닝 — ‘초대’를 누르면 계정/DB가 생성됩니다.",
		});
	}

	// --- Student Mode ---
	private renderStudent(s: ClassSyncSettings): void {
		const invite = this.group("초대로 연결", "교사가 준 QR을 카메라로 스캔하거나 초대 코드를 아래에 붙여넣으면 자동 설정됩니다.");
		let codeValue = "";
		invite.addSetting((set) =>
			set
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
				),
		);

		const info = this.group("연결 정보", "초대로 자동 설정됩니다.");
		this.readonlySetting(info, "학급 ID", s.classId);
		this.readonlySetting(info, "이름", s.displayName);
		this.readonlySetting(info, "CouchDB URL", s.couchdbUrl || "(미설정)");
		this.readonlySetting(info, "Mirror DB", s.remoteDb || "(미설정)");
		this.readonlySetting(info, "계정", s.username || "(미설정)");
		info.addSetting((set) =>
			set
				.setName("연결 테스트")
				.setDesc("내 mirror DB 접근/권한을 확인합니다.")
				.addButton((b) =>
					b.setButtonText("테스트 실행").setCta().onClick(() => this.runAsync(b, () => this.host.testConnection())),
				),
		);
	}

	// --- 공통: 동기화 옵션 ---
	private renderSyncOptions(s: ClassSyncSettings): void {
		const g = this.group("동기화");

		g.addSetting((set) =>
			set
				.setName("자동 동기화")
				.setDesc("끄면 수동 동기화만 하며, 변경은 즉시 적용됩니다.")
				.addToggle((t) =>
					t.setValue(s.autoSync).onChange(async (v) => {
						s.autoSync = v;
						await this.host.saveSettings();
						await this.host.restartMode();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName("첨부파일 동기화")
				.setDesc("이미지·PDF 등 비markdown 파일도 동기화합니다.")
				.addToggle((t) =>
					t.setValue(s.syncAssets).onChange(async (v) => {
						s.syncAssets = v;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName("첨부 최대 크기 (MB)")
				.setDesc("이 크기를 넘는 첨부는 동기화하지 않습니다(0=무제한).")
				.addText((t) =>
					t.setValue(String(s.maxAttachmentMB)).onChange(async (v) => {
						const n = parseInt(v, 10);
						s.maxAttachmentMB = Number.isFinite(n) && n >= 0 ? n : 20;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName("백그라운드 시 동기화 일시정지")
				.setDesc("앱이 가려지면 원격 동기화를 멈추고 복귀 시 재개해 배터리·네트워크를 아낍니다.")
				.addToggle((t) =>
					t.setValue(s.pauseWhenHidden).onChange(async (v) => {
						s.pauseWhenHidden = v;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName("모바일 업로드 지연 (ms)")
				.setDesc("모바일에서 편집 후 업로드까지의 지연으로, 길수록 배터리를 아낍니다(데스크톱은 영향 없음).")
				.addText((t) =>
					t.setValue(String(s.mobileDebounceMs)).onChange(async (v) => {
						const n = parseInt(v, 10);
						s.mobileDebounceMs = Number.isFinite(n) && n >= 0 ? n : 4000;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName("삭제 정책")
				.setDesc("삭제·이름변경 시 상대 vault의 옛 파일을 어떻게 처리할지 정합니다.")
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
				),
		);

		g.addSetting((set) =>
			set
				.setName("보관 폴더")
				.setDesc("‘보관 폴더로 이동’ 정책에서 삭제 파일이 모이며, 여기서 지우면 DB에서도 영구 삭제됩니다.")
				.addText((t) =>
					t.setPlaceholder("_삭제됨").setValue(s.archiveFolder).onChange(async (v) => {
						s.archiveFolder = v.trim() || "_삭제됨";
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName("충돌 폴더")
				.setDesc("충돌 시 원격 버전이 꺼내지는 폴더로, ‘충돌 목록 열기’ 명령으로 해소합니다.")
				.addText((t) =>
					t.setPlaceholder("_충돌").setValue(s.conflictFolder).onChange(async (v) => {
						s.conflictFolder = v.trim() || "_충돌";
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName("제외 폴더")
				.setDesc("동기화에서 제외할 폴더를 쉼표로 구분해 입력합니다.")
				.addText((t) =>
					t.setValue(s.excludeFolders.join(", ")).onChange(async (v) => {
						s.excludeFolders = v.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
						await this.host.saveSettings();
					}),
				),
		);
	}

	// --- 설정 백업/이전 + 적용/초기화 ---
	private renderBackup(): void {
		const g = this.group("백업 / 기기 이전");
		g.addSetting((set) =>
			set
				.setName("설정 내보내기 / 가져오기")
				.setDesc("학생·공유 공간·옵션을 JSON으로 백업하거나 다른 기기로 옮깁니다(비밀번호·토큰 제외).")
				.addButton((b) =>
					b.setButtonText("내보내기").onClick(() => new ExportModal(this.app, this.host.exportSettingsJson()).open()),
				)
				.addButton((b) =>
					b.setButtonText("가져오기").onClick(() =>
						new ImportModal(this.app, async (json) => {
							await this.host.importSettingsJson(json);
							this.display();
						}).open(),
					),
				),
		);
	}

	private renderApplyAndReset(s: ClassSyncSettings): void {
		const g = this.group("적용 / 초기화");
		g.addSetting((set) =>
			set
				.setName("설정 적용 (동기화 재시작)")
				.setDesc("연결·학생 목록·옵션 변경을 실행 중인 동기화에 반영합니다.")
				.addButton((b) => b.setButtonText("적용").onClick(() => this.runAsync(b, () => this.host.restartMode()))),
		);

		if (s.setupComplete) {
			g.addSetting((set) =>
				set
					.setName("역할 재설정 (동기화 상태 초기화)")
					.setDesc("역할을 다시 선택하며 동기화 체크포인트가 초기화됩니다(vault 파일은 유지).")
					.addButton((b) =>
						b.setButtonText("재설정").setWarning().onClick(async () => {
							await this.host.resetSetup();
							this.display();
						}),
					),
			);
		}
	}

	// --- 헬퍼 ---
	/** 섹션 그룹 생성(.setting-group). 선택적 설명은 그룹 상단 설명 행으로 추가. */
	private group(heading: string, desc?: string): SettingGroup {
		const g = new SettingGroup(this.containerEl).setHeading(heading);
		if (desc) g.addSetting((set) => set.setDesc(desc));
		return g;
	}

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

	private textSetting(group: SettingGroup, name: string, key: keyof ClassSyncSettings, placeholder: string): void {
		const s = this.host.settings;
		group.addSetting((set) =>
			set.setName(name).addText((t) => {
				t.setPlaceholder(placeholder)
					.setValue(String(s[key] ?? ""))
					.onChange(async (v) => {
						(s[key] as unknown as string) = v.trim();
						await this.host.saveSettings();
					});
				noAutoCorrect(t.inputEl);
			}),
		);
	}

	private passwordSetting(group: SettingGroup): void {
		const s = this.host.settings;
		group.addSetting((set) =>
			set.setName("관리자 비밀번호").addText((t) => {
				t.setPlaceholder("********").setValue(s.password).onChange(async (v) => {
					s.password = v;
					await this.host.saveSettings();
				});
				t.inputEl.type = "password";
				noAutoCorrect(t.inputEl);
			}),
		);
	}

	private readonlySetting(group: SettingGroup, name: string, value: string): void {
		group.addSetting((set) => set.setName(name).addText((t) => t.setValue(value).setDisabled(true)));
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
