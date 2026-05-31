import { Plugin, WorkspaceLeaf } from "obsidian";
import { ClassSyncSettings, DEFAULT_SETTINGS, Role } from "./settings/types";
import { ClassSyncSettingTab, SettingsHost } from "./settings/SettingsTab";
import { Logger } from "./core/log/Logger";
import { CoreServices } from "./core/CoreServices";
import { ClassSyncMode } from "./modes/ClassSyncMode";
import { StudentMode } from "./modes/student/StudentMode";
import { TeacherMode } from "./modes/teacher/TeacherMode";
import { LogView, LOG_VIEW_TYPE } from "./ui/LogView";

/**
 * Class Sync for Obsidian — Phase 0 POC 진입점.
 *
 * 기술문서 §5.2 / §5.3 패턴: 설정의 role에 따라 Student/Teacher mode를 활성화하고,
 * 역할 변경 시 기존 mode를 정지하고 새 mode를 시작한다.
 * POC 명령은 플러그인 레벨에 한 번 등록하고 현재 mode의 tester로 위임한다.
 */
export default class ClassSyncPlugin extends Plugin implements SettingsHost {
	settings!: ClassSyncSettings;
	private logger = new Logger();
	private core!: CoreServices;
	private mode!: ClassSyncMode;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.core = new CoreServices(this.app, this.settings, this.logger);

		this.registerView(LOG_VIEW_TYPE, (leaf: WorkspaceLeaf) => new LogView(leaf, this.logger));

		this.addSettingTab(new ClassSyncSettingTab(this.app, this));

		this.addRibbonIcon("refresh-cw", "Class Sync 로그 열기", () => this.activateLogView());

		this.registerCommands();

		this.mode = this.createMode(this.settings.role);
		await this.mode.start();

		this.logger.info(
			`Class Sync 로드됨 [build: ios-auth-fix] (role=${this.settings.role}). 명령 팔레트에서 "Class Sync:" 검색.`,
		);
	}

	async onunload(): Promise<void> {
		await this.mode?.stop();
		this.core?.dispose();
	}

	// --- 설정 ---
	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		// 연결 관련 설정이 바뀌었을 수 있으므로 다음 사용 때 PouchService를 새로 만들도록
		await this.mode?.tester.resetPouch();
	}

	// --- 역할 전환 (기술문서 §5.3) ---
	async switchRole(nextRole: Role): Promise<void> {
		if (this.mode?.role === nextRole) return;
		await this.mode?.stop();
		this.settings.role = nextRole;
		await this.saveData(this.settings);
		this.core.settings = this.settings;
		this.mode = this.createMode(nextRole);
		await this.mode.start();
		this.logger.ok(`역할 전환 완료: ${nextRole}`, true);
	}

	private createMode(role: Role): ClassSyncMode {
		return role === "teacher" ? new TeacherMode(this.core) : new StudentMode(this.core);
	}

	// --- 연결 테스트 (설정 탭 버튼) ---
	async testConnection(): Promise<void> {
		await this.activateLogView();
		await this.mode.tester.testConnection();
	}

	// --- POC 명령 등록 ---
	private registerCommands(): void {
		const tester = () => this.mode.tester;

		this.addCommand({
			id: "class-sync-open-log",
			name: "로그 패널 열기",
			callback: () => this.activateLogView(),
		});
		this.addCommand({
			id: "class-sync-test-connection",
			name: "연결/권한 테스트",
			callback: async () => {
				await this.activateLogView();
				await tester().testConnection();
			},
		});
		this.addCommand({
			id: "class-sync-test-putget",
			name: "문서 put/get 테스트",
			callback: () => tester().testPutGet(),
		});
		this.addCommand({
			id: "class-sync-changes-start",
			name: "changes feed 구독 시작",
			callback: () => tester().startChanges(),
		});
		this.addCommand({
			id: "class-sync-changes-stop",
			name: "changes feed 구독 중지",
			callback: () => tester().stopChanges(),
		});
		this.addCommand({
			id: "class-sync-test-filerw",
			name: "vault 파일 쓰기/읽기 테스트",
			callback: () => tester().testFileRW(),
		});
		this.addCommand({
			id: "class-sync-test-guard",
			name: "원격→로컬 적용 + guard 테스트",
			callback: () => tester().testRemoteApplyWithGuard(),
		});
		this.addCommand({
			id: "class-sync-sync-start",
			name: "로컬↔원격 sync 시작",
			callback: () => tester().startSync(),
		});
		this.addCommand({
			id: "class-sync-sync-stop",
			name: "로컬↔원격 sync 중지",
			callback: () => tester().stopSync(),
		});
		this.addCommand({
			id: "class-sync-switch-role",
			name: "역할 전환 (student ⇄ teacher)",
			callback: () => this.switchRole(this.settings.role === "teacher" ? "student" : "teacher"),
		});
	}

	// --- 로그 뷰 활성화 ---
	private async activateLogView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(LOG_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: LOG_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
	}
}
