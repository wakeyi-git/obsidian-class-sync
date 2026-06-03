import { App, Notice, Plugin, PluginSettingTab, Setting, SettingGroup } from "obsidian";
import { ClassSyncSettings, StudentConfig, SharedSpace } from "./types";
import { ExportModal, ImportModal } from "../ui/BackupModal";
import { ConfirmModal } from "../ui/ConfirmModal";
import { validateFolderName, foldersOverlap } from "../core/path/path";
import { validateSettings, SettingsIssue } from "./validateSettings";
import { t } from "../i18n";

/** 검증 이슈 코드 → 사용자 메시지(i18n). validateSettings는 순수(코드만), 문구는 여기서. */
function issueMessage(i: SettingsIssue): string {
	switch (i.code) {
		case "dup-studentId":
			return t("학생 ID 중복: {value}", { value: String(i.params?.value) });
		case "dup-username":
			return t("계정(username) 중복: {value}", { value: String(i.params?.value) });
		case "dup-remoteDb":
			return t("Mirror DB 이름 중복: {value}", { value: String(i.params?.value) });
		case "folder-overlap":
			return t("폴더 겹침: ‘{a}’와 ‘{b}’ (이중 동기화 혼란)", { a: String(i.params?.a), b: String(i.params?.b) });
		case "couch-url":
			return t("CouchDB URL은 http(s)://로 시작해야 합니다.");
		case "yjs-wss":
			return t("Yjs 서버 URL은 wss://(보안) 사용을 권장합니다.");
		case "rt-no-url":
			return t("실시간이 켜져 있지만 Yjs 서버 URL이 비어 있습니다.");
		case "rt-no-token":
			return t("실시간이 켜져 있지만 토큰/공간 시크릿이 비어 있습니다.");
	}
}

/** SettingsTab가 의존하는 플러그인 동작 (순환 import 방지용 인터페이스). */
export interface SettingsHost extends Plugin {
	settings: ClassSyncSettings;
	saveSettings(): Promise<void>;
	testConnection(): Promise<void>;
	restartMode(): Promise<void>;
	requestApply(): void;
	resetSetup(): Promise<void>;
	inviteStudent(student: StudentConfig): Promise<boolean>;
	rotateStudentPassword(student: StudentConfig): Promise<void>;
	ingestInvite(code: string): Promise<void>;
	deployShared(space: SharedSpace): Promise<void>;
	exportSettingsJson(): string;
	importSettingsJson(json: string): Promise<{ ok: boolean; error?: string }>;
	openResetModal(): void;
	refreshUiLanguage(): void;
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
		this.renderLanguage(s);
		this.renderIssues(s);

		if (s.role === "teacher") this.renderTeacher(s);
		else this.renderStudent(s);

		this.renderSyncOptions(s);
		this.renderBackup();
		this.renderApplyAndReset(s);
	}

	// --- 설정 검증 경고(상단 지속 표시) ---
	private renderIssues(s: ClassSyncSettings): void {
		const issues = validateSettings(s);
		if (issues.length === 0) return;
		const box = this.containerEl.createDiv({ cls: "class-sync-issues" });
		box.createDiv({ cls: "class-sync-issues-title", text: t("확인이 필요한 설정 {n}건", { n: issues.length }) });
		for (const i of issues) {
			const row = box.createDiv({ cls: `class-sync-issue is-${i.level}` });
			row.setText((i.level === "error" ? "⛔ " : "⚠ ") + issueMessage(i));
		}
	}

	// --- 언어 ---
	private renderLanguage(s: ClassSyncSettings): void {
		new Setting(this.containerEl)
			.setName(t("언어"))
			.setDesc(t("UI 언어. ‘자동’은 Obsidian 언어를 따릅니다."))
			.addDropdown((d) => {
				d.addOption("auto", t("자동 (Obsidian 따름)"));
				d.addOption("ko", "한국어");
				d.addOption("en", "English");
				d.setValue(s.language).onChange(async (v) => {
					s.language = v as ClassSyncSettings["language"];
					await this.host.saveSettings();
					this.host.refreshUiLanguage();
					this.display();
				});
			});
	}

	// --- 역할 (상단 일반 설정, 헤딩 없음) ---
	private renderRole(s: ClassSyncSettings): void {
		const roleLabel = s.role === "teacher" ? t("Teacher Mode (교사)") : t("Student Mode (학생)");
		new Setting(this.containerEl)
			.setName(t("역할"))
			.setDesc(
				s.setupComplete
					? t("최초 1회 설정 후 잠기며, 변경하려면 아래 ‘역할 재설정’을 사용하세요.")
					: t("아직 역할이 설정되지 않았습니다."),
			)
			.addText((txt) => txt.setValue(s.setupComplete ? roleLabel : t("(미설정)")).setDisabled(true));
	}

	// --- Teacher Mode ---
	private renderTeacher(s: ClassSyncSettings): void {
		const klass = this.group(t("학급"));
		this.textSetting(klass, t("학급 ID"), "classId", "class_2026_1");
		this.textSetting(klass, t("표시 이름"), "displayName", t("교사"));

		const admin = this.group(t("관리자 계정"), t("학생 계정·DB·권한 생성용 자격증명(이 기기에만 저장) — 칸을 벗어나면 변경이 자동 적용됩니다."));
		this.textSetting(admin, "CouchDB URL", "couchdbUrl", "https://nas.example.com", { applyOnBlur: true });
		this.textSetting(admin, t("관리자 사용자"), "username", "admin", { applyOnBlur: true });
		this.passwordSetting(admin);
		admin.addSetting((set) =>
			set
				.setName(t("연결 테스트"))
				.setDesc(t("모든 학생 mirror DB 접근/권한을 확인합니다."))
				.addButton((b) =>
					b.setButtonText(t("테스트 실행")).setCta().onClick(() => this.runAsync(b, () => this.host.testConnection())),
				),
		);

		// 학생 목록 (카드)
		const students = this.group(
			t("학생 목록"),
			s.students.length === 0 ? t("아래 ‘학생 추가’로 첫 학생을 등록하세요.") : undefined,
		);
		s.students.forEach((st, i) => this.renderStudentCard(students, st, i));
		students.addSetting((set) =>
			set.setClass("class-sync-add-row").addButton((b) =>
				b
					.setButtonText(t("+ 학생 추가"))
					.setCta()
					.onClick(async () => {
						s.students.push({ studentId: "", studentName: "", remoteDb: "", localRoot: "", username: "" });
						await this.host.saveSettings();
						this.display();
					}),
			),
		);

		// 공유 공간 (모둠/학급)
		const shared = this.group(t("공유 공간 (모둠/학급)"), t("멤버를 고르고 ‘배포’하면 공유 DB·권한이 생성되어 멤버 학생에게 전파됩니다."));
		s.sharedSpaces.forEach((sp, i) => this.renderSharedCard(shared, sp, i));
		shared.addSetting((set) =>
			set.setClass("class-sync-add-row").addButton((b) =>
				b
					.setButtonText(t("+ 공유 공간 추가"))
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
			t("실시간 공동 편집 (Yjs)"),
			t("별도 Yjs WebSocket 서버로 공유 폴더 문서를 글자 단위 동시 편집하며, ‘배포’ 시 학생에게 전파됩니다."),
		);
		rt.addSetting((set) =>
			set.setName(t("실시간 편집 사용")).addToggle((tg) =>
				tg.setValue(s.realtimeEnabled).onChange(async (v) => {
					s.realtimeEnabled = v;
					await this.host.saveSettings();
				}),
			),
		);
		this.textSetting(rt, t("Yjs 서버 URL"), "yjsServerUrl", "wss://yjs.example.com");
		rt.addSetting((set) =>
			set.setName(t("Yjs 토큰")).addText((txt) => {
				txt.setPlaceholder(t("공유 비밀 토큰")).setValue(s.yjsToken).onChange(async (v) => {
					s.yjsToken = v.trim();
					await this.host.saveSettings();
				});
				txt.inputEl.type = "password";
				noAutoCorrect(txt.inputEl);
			}),
		);
		rt.addSetting((set) =>
			set
				.setName(t("Yjs 공간 시크릿 (HMAC, 권장)"))
				.setDesc(t("설정하면 공유 공간별 서명 토큰을 발급합니다(유출돼도 해당 공간만 접근). 서버 YJS_SECRET와 동일하게 두고 공유하지 마세요. 재배포 시 토큰이 갱신됩니다."))
				.addText((txt) => {
					txt.setPlaceholder(t("서버 YJS_SECRET와 동일")).setValue(s.yjsSecret ?? "").onChange(async (v) => {
						s.yjsSecret = v.trim() || undefined;
						await this.host.saveSettings();
					});
					txt.inputEl.type = "password";
					noAutoCorrect(txt.inputEl);
				}),
		);
		rt.addSetting((set) =>
			set
				.setName(t("공간 토큰 만료(일)"))
				.setDesc(t("0=무만료. 값을 두면 주기적 재배포로 토큰을 무효화할 수 있습니다."))
				.addText((txt) => {
					txt.setPlaceholder("0").setValue(String(s.yjsTokenTtlDays ?? 0));
					txt.inputEl.type = "number";
					txt.onChange(async (v) => {
						const n = Number(v);
						s.yjsTokenTtlDays = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
						await this.host.saveSettings();
					});
				}),
		);
		rt.addSetting((set) =>
			set
				.setName(t("세션 중 스냅샷 주기(초)"))
				.setDesc(t("실시간 세션 중 일정 주기로 CouchDB에 본문을 저장해 오프라인 멤버에 반영합니다(0=끔)."))
				.addText((txt) => {
					txt.setPlaceholder("0").setValue(String(s.realtimeSnapshotSec));
					txt.inputEl.type = "number";
					txt.onChange(async (v) => {
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
			.setName(sp.name || t("공유 공간 {n}", { n: index + 1 }))
			.setHeading()
			.addButton((b) =>
				b
					.setButtonText(sp.provisioned ? t("재배포") : t("배포"))
					.setCta()
					.onClick(() => this.runAsync(b, async () => { await this.host.deployShared(sp); this.display(); })),
			)
			.addButton((b) =>
				b
					.setButtonText(t("삭제"))
					.setWarning()
					.onClick(() =>
						new ConfirmModal(this.host.app, {
							title: t("공유 공간 삭제: {name}", { name: sp.name || sp.id }),
							message: t(
								"이 공유 공간을 목록에서 제거합니다.\n서버 데이터(공유 DB)는 유지되며 동기화 링크만 사라집니다.\n서버까지 지우려면 관리 탭의 ‘서버 데이터 초기화’를 사용하세요.",
							),
							warning: true,
							onConfirm: async () => {
								s.sharedSpaces.splice(index, 1);
								await this.host.saveSettings();
								this.host.requestApply();
								this.display();
							},
						}).open(),
					),
			);

		new Setting(card).setName(t("이름")).addText((txt) => {
			txt.setPlaceholder(t("모둠1")).setValue(sp.name).onChange(async (v) => {
				sp.name = v.trim();
				if (!sp.folder) sp.folder = v.trim();
				await this.host.saveSettings();
			});
			noAutoCorrect(txt.inputEl);
			this.applyOnBlur(txt.inputEl);
		});
		new Setting(card).setName(t("폴더")).addText((txt) => {
			txt.setPlaceholder(t("모둠1")).setValue(sp.folder).onChange(async (v) => {
				const v2 = v.trim();
				if (!this.okFolder(v2)) return;
				sp.folder = v2;
				await this.host.saveSettings();
			});
			noAutoCorrect(txt.inputEl);
			this.applyOnBlur(txt.inputEl);
		});

		const membersEl = card.createDiv({ cls: "class-sync-student-status" });
		membersEl.createSpan({ text: t("멤버:") });
		for (const st of s.students) {
			if (!st.studentId) continue;
			new Setting(card).setName(st.studentName || st.studentId).addToggle((tg) =>
				tg.setValue(sp.members.includes(st.studentId)).onChange(async (v) => {
					if (v && !sp.members.includes(st.studentId)) sp.members.push(st.studentId);
					else if (!v) sp.members = sp.members.filter((m) => m !== st.studentId);
					await this.host.saveSettings();
				}),
			);
		}
		card.createEl("div", {
			cls: "class-sync-student-status",
			text: sp.provisioned
				? t("DB: {db} · 프로비저닝됨 ✓", { db: sp.remoteDb })
				: t("DB: {db} · 미배포", { db: sp.remoteDb }),
		});
	}

	private renderStudentCard(group: SettingGroup, st: StudentConfig, index: number): void {
		const card = group.listEl.createDiv({ cls: "class-sync-student-card" });

		const head = new Setting(card)
			.setName(st.studentName || st.studentId || t("학생 {n}", { n: index + 1 }))
			.setHeading()
			.addButton((b) =>
				b
					.setButtonText(st.provisioned ? t("초대 재발급") : t("초대"))
					.setCta()
					.onClick(() => this.runAsync(b, async () => { await this.host.inviteStudent(st); this.display(); })),
			);
		if (st.provisioned) {
			head.addButton((b) =>
				b
					.setButtonText(t("비밀번호 재발급"))
					.setTooltip(t("새 비밀번호로 바꿔 이전 초대 코드를 무효화합니다."))
					.onClick(() => this.runAsync(b, async () => { await this.host.rotateStudentPassword(st); this.display(); })),
			);
		}
		head
			.addButton((b) =>
				b
					.setButtonText(t("삭제"))
					.setWarning()
					.onClick(() =>
						new ConfirmModal(this.host.app, {
							title: t("학생 삭제: {name}", { name: st.studentName || st.studentId || t("학생") }),
							message: t(
								"이 학생을 목록에서 제거합니다.\n서버 데이터(계정·Mirror DB)는 유지되며 동기화 링크만 사라집니다.\n서버까지 지우려면 관리 탭의 ‘서버 데이터 초기화’를 사용하세요.",
							),
							warning: true,
							onConfirm: async () => {
								this.host.settings.students.splice(index, 1);
								await this.host.saveSettings();
								this.host.requestApply();
								this.display();
							},
						}).open(),
					),
			);

		this.studentField(card, t("이름"), st, "studentName", t("학생A"));
		this.studentField(card, t("학생 ID"), st, "studentId", "student_a");
		// 비우면 초대 시점에 학생 ID로 자동 채움 (계정=ID, DB=mirror_<ID>, 폴더=이름/ID)
		this.studentField(card, t("Mirror DB (비우면 자동)"), st, "remoteDb", t("mirror_<학생ID>"));
		this.studentField(card, t("폴더 (비우면 자동)"), st, "localRoot", t("<이름 또는 학생ID>"));

		card.createEl("div", {
			cls: "class-sync-student-status",
			text: st.provisioned ? t("상태: 프로비저닝됨 ✓") : t("상태: 미프로비저닝 — ‘초대’를 누르면 계정/DB가 생성됩니다."),
		});
	}

	// --- Student Mode ---
	private renderStudent(s: ClassSyncSettings): void {
		const invite = this.group(t("초대로 연결"), t("교사가 준 QR을 카메라로 스캔하거나 초대 코드를 아래에 붙여넣으면 자동 설정됩니다."));
		let codeValue = "";
		invite.addSetting((set) =>
			set
				.setName(t("초대 코드"))
				.addText((txt) => {
					txt.setPlaceholder(t("교사에게 받은 초대 코드 붙여넣기")).onChange((v) => (codeValue = v));
					noAutoCorrect(txt.inputEl);
				})
				.addButton((b) =>
					b
						.setButtonText(t("적용"))
						.setCta()
						.onClick(() => this.runAsync(b, async () => { await this.host.ingestInvite(codeValue); this.display(); })),
				),
		);

		const info = this.group(t("연결 정보"), t("초대로 자동 설정됩니다."));
		this.readonlySetting(info, t("학급 ID"), s.classId);
		this.readonlySetting(info, t("이름"), s.displayName);
		this.readonlySetting(info, "CouchDB URL", s.couchdbUrl || t("(미설정)"));
		this.readonlySetting(info, "Mirror DB", s.remoteDb || t("(미설정)"));
		this.readonlySetting(info, t("계정"), s.username || t("(미설정)"));
		info.addSetting((set) =>
			set
				.setName(t("연결 테스트"))
				.setDesc(t("내 mirror DB 접근/권한을 확인합니다."))
				.addButton((b) =>
					b.setButtonText(t("테스트 실행")).setCta().onClick(() => this.runAsync(b, () => this.host.testConnection())),
				),
		);
	}

	// --- 공통: 동기화 옵션 ---
	private renderSyncOptions(s: ClassSyncSettings): void {
		const g = this.group(t("동기화"));

		g.addSetting((set) =>
			set
				.setName(t("자동 동기화"))
				.setDesc(t("끄면 수동 동기화만 하며, 변경은 즉시 적용됩니다."))
				.addToggle((tg) =>
					tg.setValue(s.autoSync).onChange(async (v) => {
						s.autoSync = v;
						await this.host.saveSettings();
						this.host.requestApply();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("첨부파일 동기화"))
				.setDesc(t("이미지·PDF 등 비markdown 파일도 동기화합니다."))
				.addToggle((tg) =>
					tg.setValue(s.syncAssets).onChange(async (v) => {
						s.syncAssets = v;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("첨부 최대 크기 (MB)"))
				.setDesc(t("이 크기를 넘는 첨부는 동기화하지 않습니다(0=무제한)."))
				.addText((txt) =>
					txt.setValue(String(s.maxAttachmentMB)).onChange(async (v) => {
						const n = parseInt(v, 10);
						s.maxAttachmentMB = Number.isFinite(n) && n >= 0 ? n : 20;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("백그라운드 시 동기화 일시정지"))
				.setDesc(t("앱이 가려지면 원격 동기화를 멈추고 복귀 시 재개해 배터리·네트워크를 아낍니다."))
				.addToggle((tg) =>
					tg.setValue(s.pauseWhenHidden).onChange(async (v) => {
						s.pauseWhenHidden = v;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("모바일 업로드 지연 (ms)"))
				.setDesc(t("모바일에서 편집 후 업로드까지의 지연으로, 길수록 배터리를 아낍니다(데스크톱은 영향 없음)."))
				.addText((txt) =>
					txt.setValue(String(s.mobileDebounceMs)).onChange(async (v) => {
						const n = parseInt(v, 10);
						s.mobileDebounceMs = Number.isFinite(n) && n >= 0 ? n : 4000;
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("삭제 정책"))
				.setDesc(t("삭제·이름변경 시 상대 vault의 옛 파일을 어떻게 처리할지 정합니다."))
				.addDropdown((dd) =>
					dd
						.addOption("archive", t("보관 폴더로 이동"))
						.addOption("propagate-delete", t("즉시 삭제"))
						.addOption("ignore-delete", t("삭제 무시"))
						.setValue(s.deletePolicy)
						.onChange(async (v) => {
							s.deletePolicy = v as ClassSyncSettings["deletePolicy"];
							await this.host.saveSettings();
						}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("보관 폴더"))
				.setDesc(t("‘보관 폴더로 이동’ 정책에서 삭제 파일이 모이며, 여기서 지우면 DB에서도 영구 삭제됩니다."))
				.addText((txt) =>
					txt.setPlaceholder(t("_삭제됨")).setValue(s.archiveFolder).onChange(async (v) => {
						const v2 = v.trim();
						if (!this.okFolder(v2)) return;
						if (v2 && foldersOverlap(v2, s.conflictFolder)) {
							new Notice(t("보관 폴더와 충돌 폴더가 겹칩니다. 다른 경로를 쓰세요."));
							return;
						}
						s.archiveFolder = v2 || "_삭제됨";
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("충돌 폴더"))
				.setDesc(t("충돌 시 원격 버전이 꺼내지는 폴더로, ‘충돌 목록 열기’ 명령으로 해소합니다."))
				.addText((txt) =>
					txt.setPlaceholder(t("_충돌")).setValue(s.conflictFolder).onChange(async (v) => {
						const v2 = v.trim();
						if (!this.okFolder(v2)) return;
						if (v2 && foldersOverlap(v2, s.archiveFolder)) {
							new Notice(t("보관 폴더와 충돌 폴더가 겹칩니다. 다른 경로를 쓰세요."));
							return;
						}
						s.conflictFolder = v2 || "_충돌";
						await this.host.saveSettings();
					}),
				),
		);

		g.addSetting((set) =>
			set
				.setName(t("제외 폴더"))
				.setDesc(t("동기화에서 제외할 폴더를 쉼표로 구분해 입력합니다."))
				.addText((txt) =>
					txt.setValue(s.excludeFolders.join(", ")).onChange(async (v) => {
						const folders = v.split(",").map((x) => x.trim()).filter((x) => x.length > 0);
						const bad = folders.find((f) => !validateFolderName(f));
						if (bad) {
							new Notice(t("잘못된 폴더 경로입니다: {path} (‘..’·절대경로·.obsidian 불가)", { path: bad }));
							return;
						}
						s.excludeFolders = folders;
						await this.host.saveSettings();
					}),
				),
		);
	}

	// --- 설정 백업/이전 + 적용/초기화 ---
	private renderBackup(): void {
		const g = this.group(t("백업 / 기기 이전"));
		g.addSetting((set) =>
			set
				.setName(t("설정 내보내기 / 가져오기"))
				.setDesc(t("학생·공유 공간·옵션을 JSON으로 백업하거나 다른 기기로 옮깁니다(비밀번호·토큰 제외)."))
				.addButton((b) =>
					b.setButtonText(t("내보내기")).onClick(() => new ExportModal(this.app, this.host.exportSettingsJson()).open()),
				)
				.addButton((b) =>
					b.setButtonText(t("가져오기")).onClick(() =>
						new ImportModal(this.app, async (json) => {
							await this.host.importSettingsJson(json);
							this.display();
						}).open(),
					),
				),
		);
	}

	private renderApplyAndReset(s: ClassSyncSettings): void {
		const g = this.group(t("초기화"));

		// 서버 데이터 초기화 — 교사 전용, 파괴적. 백엔드를 처음 상태로.
		if (s.role === "teacher") {
			g.addSetting((set) =>
				set
					.setName(t("서버 데이터 초기화"))
					.setDesc(t("서버의 모든 학생·공유 데이터베이스를 삭제해 백엔드를 초기화합니다(되돌릴 수 없음 · Yjs는 수동 안내)."))
					.addButton((b) => b.setButtonText(t("초기화…")).setWarning().onClick(() => this.host.openResetModal())),
			);
		}

		// ③ 역할 재설정 — 로컬만 초기화하고 역할 재선택(서버·vault는 유지).
		if (s.setupComplete) {
			g.addSetting((set) =>
				set
					.setName(t("역할 재설정 (로컬 초기화)"))
					.setDesc(t("교사↔학생 역할 변경이나 재시작용 — 로컬 체크포인트·캐시를 비우고 역할을 다시 고릅니다(서버 데이터·vault 파일은 유지)."))
					.addButton((b) =>
						b.setButtonText(t("재설정")).setWarning().onClick(async () => {
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

	/** 폴더 경로 입력 검증: 비었으면 통과(기본값 대체), 잘못된 경로면 Notice 후 false. */
	private okFolder(value: string): boolean {
		if (!value) return true;
		if (!validateFolderName(value)) {
			new Notice(t("잘못된 폴더 경로입니다: {path} (‘..’·절대경로·.obsidian 불가)", { path: value }));
			return false;
		}
		return true;
	}

	private studentField(card: HTMLElement, name: string, st: StudentConfig, key: keyof StudentConfig, placeholder: string): void {
		new Setting(card).setName(name).addText((t) => {
			t.setPlaceholder(placeholder)
				.setValue(String(st[key] ?? ""))
				.onChange(async (v) => {
					const v2 = v.trim();
					if (key === "localRoot" && !this.okFolder(v2)) return; // 잘못된 폴더 경로는 저장하지 않음
					(st[key] as unknown as string) = v2;
					await this.host.saveSettings();
				});
			noAutoCorrect(t.inputEl);
			this.applyOnBlur(t.inputEl); // 칸을 벗어나면 자동 적용
		});
	}

	private textSetting(
		group: SettingGroup,
		name: string,
		key: keyof ClassSyncSettings,
		placeholder: string,
		opts?: { applyOnBlur?: boolean },
	): void {
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
				if (opts?.applyOnBlur) this.applyOnBlur(t.inputEl);
			}),
		);
	}

	private passwordSetting(group: SettingGroup): void {
		const s = this.host.settings;
		group.addSetting((set) =>
			set.setName(t("관리자 비밀번호")).addText((txt) => {
				txt.setPlaceholder("********").setValue(s.password).onChange(async (v) => {
					s.password = v;
					await this.host.saveSettings();
				});
				txt.inputEl.type = "password";
				noAutoCorrect(txt.inputEl);
				this.applyOnBlur(txt.inputEl); // 연결 자격증명: 칸을 벗어나면 자동 적용
			}),
		);
	}

	/** 구조 필드(연결·학생·공유): 타이핑 중엔 적용하지 않고, 포커스가 빠질 때 값이 바뀌었으면 자동 적용. */
	private applyOnBlur(input: HTMLInputElement): void {
		let focusVal = input.value;
		input.addEventListener("focus", () => {
			focusVal = input.value;
		});
		input.addEventListener("blur", () => {
			if (input.value !== focusVal) {
				focusVal = input.value;
				this.host.requestApply();
			}
		});
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
