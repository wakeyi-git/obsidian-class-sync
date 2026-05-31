import { Plugin, WorkspaceLeaf } from "obsidian";
import { ClassSyncSettings, DEFAULT_SETTINGS, Role } from "./settings/types";
import { ClassSyncSettingTab, SettingsHost } from "./settings/SettingsTab";
import { Logger } from "./core/log/Logger";
import { CoreServices } from "./core/CoreServices";
import { ClassSyncMode } from "./modes/ClassSyncMode";
import { StudentMode } from "./modes/student/StudentMode";
import { TeacherMode } from "./modes/teacher/TeacherMode";
import { LogView, LOG_VIEW_TYPE } from "./ui/LogView";
import { RoleSetupModal } from "./ui/RoleSetupModal";
import { testConnection } from "./core/sync/connectionTest";

/**
 * Class Sync for Obsidian — Phase 1 진입점.
 *
 * 역할은 최초 1회 선택 후 잠긴다(기술문서 §5.4 보강). 실행 시 저장된 last_seq부터 증분 재개하고,
 * 전체 동기화는 최초 1회와 수동 명령에서만 수행한다.
 */
export default class ClassSyncPlugin extends Plugin implements SettingsHost {
	settings!: ClassSyncSettings;
	private logger = new Logger();
	private core!: CoreServices;
	private mode: ClassSyncMode | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.core = new CoreServices(this.app, this.settings, this.logger);
		this.core.save = () => this.saveData(this.settings);

		this.registerView(LOG_VIEW_TYPE, (leaf: WorkspaceLeaf) => new LogView(leaf, this.logger));
		this.addSettingTab(new ClassSyncSettingTab(this.app, this));
		this.addRibbonIcon("refresh-cw", "Class Sync 로그 열기", () => this.activateLogView());
		this.registerCommands();

		if (!this.settings.setupComplete) {
			// 최초 실행: 역할 선택 후 시작
			this.promptRoleSetup();
		} else {
			await this.startMode();
		}

		this.logger.info(`Class Sync 로드됨 [Phase 1] (role=${this.settings.role}, setup=${this.settings.setupComplete}).`);
	}

	async onunload(): Promise<void> {
		await this.mode?.stop();
		await this.core?.flushPersist();
		this.core?.dispose();
	}

	// --- 설정 ---
	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// --- 모드 시작/정지 ---
	private createMode(role: Role): ClassSyncMode {
		return role === "teacher" ? new TeacherMode(this.core) : new StudentMode(this.core);
	}

	private async startMode(): Promise<void> {
		this.core.settings = this.settings;
		this.mode = this.createMode(this.settings.role);
		await this.mode.start();
	}

	/** 최초 실행 역할 선택 모달 → 역할 잠금 + 모드 시작. */
	private promptRoleSetup(): void {
		new RoleSetupModal(this.app, async (role) => {
			this.settings.role = role;
			this.settings.setupComplete = true;
			await this.saveSettings();
			this.logger.ok(`역할 설정 완료: ${role}. 설정에서 CouchDB 연결 정보를 입력하세요.`, true);
			await this.startMode();
		}).open();
	}

	/** 역할 재설정(데이터 초기화). 설정 탭에서 호출. */
	async resetSetup(): Promise<void> {
		await this.mode?.stop();
		this.mode = null;
		this.settings.setupComplete = false;
		this.settings.lastSeqByDb = {};
		await this.saveSettings();
		this.logger.warn("역할/동기화 상태를 초기화했습니다. 역할을 다시 선택하세요.", true);
		this.promptRoleSetup();
	}

	// --- 연결 테스트 (설정 버튼) — 항상 최신 설정으로 검사 ---
	async testConnection(): Promise<void> {
		await this.activateLogView();
		await testConnection(this.core);
	}

	/** 연결/경로 설정 변경을 실행 중 엔진에 반영(재시작). 설정 탭 '적용' 버튼. */
	async restartMode(): Promise<void> {
		if (!this.settings.setupComplete) return;
		await this.mode?.stop();
		await this.startMode();
		this.logger.ok("설정을 적용해 동기화를 재시작했습니다.", true);
	}

	// --- 명령 등록 ---
	private registerCommands(): void {
		const sync = () => this.mode?.sync;

		this.addCommand({ id: "class-sync-open-log", name: "로그 패널 열기", callback: () => this.activateLogView() });
		this.addCommand({
			id: "class-sync-test-connection",
			name: "연결/권한 테스트",
			callback: () => this.testConnection(),
		});
		this.addCommand({
			id: "class-sync-full-sync",
			name: "전체 동기화",
			callback: async () => {
				await this.activateLogView();
				await sync()?.fullSync("both");
			},
		});
		this.addCommand({
			id: "class-sync-upload-only",
			name: "업로드만 실행",
			callback: async () => {
				await this.activateLogView();
				await sync()?.fullSync("up");
			},
		});
		this.addCommand({
			id: "class-sync-download-only",
			name: "다운로드만 실행",
			callback: async () => {
				await this.activateLogView();
				await sync()?.fullSync("down");
			},
		});
		this.addCommand({
			id: "class-sync-toggle-autosync",
			name: "자동 동기화 켜기/끄기",
			callback: () => this.toggleAutoSync(),
		});
	}

	/** autoSync 토글 — 모드를 재시작해 감시/구독을 켜거나 끈다. */
	private async toggleAutoSync(): Promise<void> {
		this.settings.autoSync = !this.settings.autoSync;
		await this.saveSettings();
		this.logger.info(`자동 동기화: ${this.settings.autoSync ? "켜짐" : "꺼짐"}`, true);
		if (this.settings.setupComplete) {
			await this.mode?.stop();
			await this.startMode();
		}
	}

	// --- 로그 뷰 ---
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
