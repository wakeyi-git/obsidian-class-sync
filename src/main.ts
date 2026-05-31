import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { ClassSyncSettings, DEFAULT_SETTINGS, Role, StudentConfig } from "./settings/types";
import { ClassSyncSettingTab, SettingsHost } from "./settings/SettingsTab";
import { Logger } from "./core/log/Logger";
import { CoreServices } from "./core/CoreServices";
import { ClassSyncMode } from "./modes/ClassSyncMode";
import { StudentMode } from "./modes/student/StudentMode";
import { TeacherMode } from "./modes/teacher/TeacherMode";
import { TFile } from "obsidian";
import { LogView, LOG_VIEW_TYPE } from "./ui/LogView";
import { RoleSetupModal } from "./ui/RoleSetupModal";
import { InviteModal } from "./ui/InviteModal";
import { ConflictModal, ConflictRow, ConflictHost } from "./ui/ConflictModal";
import { ResolveChoice } from "./core/sync/ConflictManager";
import { DashboardView, DASHBOARD_VIEW_TYPE, DashboardRow, DashboardHost } from "./ui/DashboardView";
import { testConnection } from "./core/sync/connectionTest";
import { CouchAdmin } from "./core/couch/CouchAdmin";
import { InvitePayload, INVITE_ACTION, genPassword, parseInvite } from "./core/invite/invite";

/**
 * Class Sync for Obsidian — Phase 1 진입점.
 *
 * 역할은 최초 1회 선택 후 잠긴다(기술문서 §5.4 보강). 실행 시 저장된 last_seq부터 증분 재개하고,
 * 전체 동기화는 최초 1회와 수동 명령에서만 수행한다.
 */
export default class ClassSyncPlugin extends Plugin implements SettingsHost, ConflictHost, DashboardHost {
	settings!: ClassSyncSettings;
	private logger = new Logger();
	private core!: CoreServices;
	private mode: ClassSyncMode | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.core = new CoreServices(this.app, this.settings, this.logger);
		this.core.save = () => this.saveData(this.settings);

		this.registerView(LOG_VIEW_TYPE, (leaf: WorkspaceLeaf) => new LogView(leaf, this.logger));
		this.registerView(DASHBOARD_VIEW_TYPE, (leaf: WorkspaceLeaf) => new DashboardView(leaf, this));
		this.addSettingTab(new ClassSyncSettingTab(this.app, this));
		this.addRibbonIcon("refresh-cw", "Class Sync 로그 열기", () => this.activateLogView());
		this.addRibbonIcon("users", "Class Sync 대시보드 열기", () => this.activateDashboard());
		this.registerCommands();

		// 학생 초대 딥링크: 폰 카메라로 QR 스캔 → obsidian://class-sync-invite?d=... → 자동 설정
		this.registerObsidianProtocolHandler(INVITE_ACTION, (params) => {
			void this.ingestInvite(params.d ?? "");
		});

		if (!this.settings.setupComplete) {
			// 최초 실행: 역할 선택 후 시작
			this.promptRoleSetup();
		} else {
			await this.startMode();
		}

		this.logger.info(`Class Sync 로드됨 [Phase 2] (role=${this.settings.role}, setup=${this.settings.setupComplete}).`);
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

	/** 최초 실행 역할 선택 모달 → 역할 잠금 + 모드 시작. 학생은 초대 코드로 바로 설정 가능. */
	private promptRoleSetup(): void {
		new RoleSetupModal(
			this.app,
			async (role) => {
				this.settings.role = role;
				this.settings.setupComplete = true;
				if (role === "teacher") {
					this.settings.userId = "teacher";
					if (this.settings.displayName === "학생A") this.settings.displayName = "교사";
				}
				await this.saveSettings();
				this.logger.ok(
					role === "teacher"
						? "Teacher Mode 설정 완료. 설정에서 관리자 계정 입력 후 학생을 추가하세요."
						: "Student Mode 설정 완료. 교사 초대(QR/코드)로 연결하세요.",
					true,
				);
				await this.startMode();
			},
			(code) => void this.ingestInvite(code),
		).open();
	}

	/** 역할 재설정(데이터 초기화). 설정 탭에서 호출. 로컬 캐시까지 비운다. */
	async resetSetup(): Promise<void> {
		await this.mode?.stop();
		this.mode = null;
		await this.destroyLocalCaches();
		this.settings.setupComplete = false;
		this.settings.lastSeqByDb = {};
		await this.saveSettings();
		this.logger.warn("역할/동기화 상태/로컬 캐시를 초기화했습니다. 역할을 다시 선택하세요.", true);
		this.promptRoleSetup();
	}

	/** 현재 역할의 모든 mirror DB 로컬 캐시(IndexedDB)를 삭제. */
	private async destroyLocalCaches(): Promise<void> {
		const dbs =
			this.settings.role === "teacher"
				? this.settings.students.map((s) => s.remoteDb).filter((d) => d)
				: [this.settings.remoteDb].filter((d) => d);
		for (const db of dbs) {
			try {
				const p = this.core.createPouch(db);
				await p.destroyLocal();
				await p.close();
				this.logger.ok(`로컬 캐시 삭제: ${db}`);
			} catch (e) {
				this.logger.error(`로컬 캐시 삭제 실패(${db}): ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	/** 로컬 캐시 초기화 후 서버에서 다시 받기. 명령에서 호출. */
	async resetLocalCache(): Promise<void> {
		await this.activateLogView();
		await this.mode?.stop();
		this.mode = null;
		await this.destroyLocalCaches();
		this.settings.lastSeqByDb = {};
		await this.saveSettings();
		if (this.settings.setupComplete) await this.startMode();
		this.logger.ok("로컬 캐시를 초기화했습니다. 서버에서 다시 동기화합니다.", true);
	}

	// --- 학생 프로비저닝 + 초대 (Teacher) ---
	async inviteStudent(student: StudentConfig): Promise<void> {
		await this.activateLogView();
		const s = this.settings;
		if (!s.couchdbUrl || !s.username || !s.password) {
			this.logger.warn("관리자 계정(CouchDB URL/사용자/비밀번호)을 먼저 입력하세요.", true);
			return;
		}
		if (!student.studentId) {
			this.logger.warn("학생 ID를 입력하세요.", true);
			return;
		}
		// 기본값 보정
		if (!student.username) student.username = student.studentId;
		if (!student.remoteDb) student.remoteDb = `mirror_${student.studentId}`;
		if (!student.localRoot) student.localRoot = student.studentName || student.studentId;
		if (!student.password) student.password = genPassword();

		this.logger.info(`학생 프로비저닝: ${student.studentId} → ${student.remoteDb}`);
		const admin = new CouchAdmin(s.couchdbUrl, s.username, s.password);
		const res = await admin.provisionStudent({
			username: student.username,
			password: student.password,
			remoteDb: student.remoteDb,
		});
		if (!res.ok) {
			this.logger.error(`프로비저닝 실패: ${res.error}`, true);
			return;
		}
		student.provisioned = true;
		await this.saveSettings();
		this.logger.ok(`프로비저닝 완료: ${student.studentId} (계정/DB/권한)`, true);

		const payload: InvitePayload = {
			v: 1,
			couchdbUrl: s.couchdbUrl,
			classId: s.classId,
			studentId: student.studentId,
			studentName: student.studentName,
			remoteDb: student.remoteDb,
			username: student.username,
			password: student.password,
		};
		new InviteModal(this.app, payload).open();
	}

	// --- 학생 온보딩: 초대 코드/딥링크로 자동 설정 ---
	async ingestInvite(input: string): Promise<void> {
		const payload = parseInvite(input);
		if (!payload) {
			new Notice("Class Sync: 초대 코드를 해석할 수 없습니다.");
			this.logger.error("초대 코드 파싱 실패.");
			return;
		}
		await this.mode?.stop();
		this.mode = null;

		const s = this.settings;
		s.role = "student";
		s.setupComplete = true;
		s.couchdbUrl = payload.couchdbUrl;
		s.classId = payload.classId;
		s.userId = payload.studentId;
		s.displayName = payload.studentName;
		s.username = payload.username;
		s.password = payload.password;
		s.remoteDb = payload.remoteDb;
		s.localRoot = ""; // 학생 vault 전체
		s.lastSeqByDb = {};
		await this.saveSettings();

		await this.activateLogView();
		this.logger.ok(`초대 적용 완료: ${payload.studentName} (${payload.remoteDb}). 동기화를 시작합니다.`, true);
		await this.startMode();
	}

	// --- 연결 테스트 (설정 버튼) — 항상 최신 설정으로, 역할별 DB 전체 검사 ---
	async testConnection(): Promise<void> {
		await this.activateLogView();
		const dbs =
			this.settings.role === "teacher"
				? this.settings.students.map((s) => s.remoteDb).filter((d) => d)
				: [this.settings.remoteDb];
		if (dbs.length === 0) {
			this.logger.warn("테스트할 mirror DB가 없습니다. (교사: 학생을 추가하세요)", true);
			return;
		}
		for (const db of dbs) await testConnection(this.core, db);
	}

	// --- 충돌 해소 (ConflictHost) ---
	async listConflicts(): Promise<ConflictRow[]> {
		const rows: ConflictRow[] = [];
		for (const sync of this.mode?.getSyncs() ?? []) {
			try {
				const infos = await sync.listConflicts();
				for (const info of infos) rows.push({ sync, info });
			} catch (e) {
				this.logger.error(`충돌 목록 조회 실패(${sync.label}): ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		return rows;
	}

	async resolveConflict(row: ConflictRow, choice: ResolveChoice): Promise<void> {
		await this.activateLogView();
		await row.sync.resolveConflict(row.info.dbPath, choice);
	}

	async openConflictFiles(row: ConflictRow): Promise<void> {
		const local = this.app.vault.getAbstractFileByPath(row.info.localPath);
		const conflict = this.app.vault.getAbstractFileByPath(row.info.conflictPath);
		if (local instanceof TFile) await this.app.workspace.getLeaf(false).openFile(local);
		if (conflict instanceof TFile) await this.app.workspace.getLeaf("split").openFile(conflict);
		else this.logger.warn(`원격본 파일이 없습니다: ${row.info.conflictPath}`, true);
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
		const fullSync = async (dir: "both" | "up" | "down") => {
			await this.activateLogView();
			await this.mode?.fullSync(dir);
		};

		this.addCommand({ id: "class-sync-open-log", name: "로그 패널 열기", callback: () => this.activateLogView() });
		this.addCommand({
			id: "class-sync-test-connection",
			name: "연결/권한 테스트",
			callback: () => this.testConnection(),
		});
		this.addCommand({ id: "class-sync-full-sync", name: "전체 동기화", callback: () => fullSync("both") });
		this.addCommand({ id: "class-sync-upload-only", name: "업로드만 실행", callback: () => fullSync("up") });
		this.addCommand({ id: "class-sync-download-only", name: "다운로드만 실행", callback: () => fullSync("down") });
		this.addCommand({
			id: "class-sync-toggle-autosync",
			name: "자동 동기화 켜기/끄기",
			callback: () => this.toggleAutoSync(),
		});
		this.addCommand({
			id: "class-sync-reset-local",
			name: "로컬 캐시 초기화 (서버에서 다시 받기)",
			callback: () => this.resetLocalCache(),
		});
		this.addCommand({
			id: "class-sync-conflicts",
			name: "충돌 목록 열기",
			callback: () => new ConflictModal(this.app, this).open(),
		});
		this.addCommand({
			id: "class-sync-dashboard",
			name: "대시보드 열기",
			callback: () => this.activateDashboard(),
		});
	}

	// --- 대시보드 (DashboardHost) ---
	async getDashboardRows(): Promise<DashboardRow[]> {
		const rows: DashboardRow[] = [];
		for (const sync of this.mode?.getSyncs() ?? []) {
			let conflicts = 0;
			try {
				conflicts = (await sync.listConflicts()).length;
			} catch {
				/* 조회 실패는 0으로 */
			}
			rows.push({
				studentName: sync.studentName,
				studentId: sync.studentId,
				remoteDb: sync.remoteDb,
				localRoot: sync.localRoot,
				conflicts,
				...sync.status,
			});
		}
		return rows;
	}

	openConflictModal(): void {
		new ConflictModal(this.app, this).open();
	}

	private async activateDashboard(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
			this.app.workspace.revealLeaf(leaf);
		}
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
