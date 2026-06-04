import { Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { ClassSyncSettings, DEFAULT_SETTINGS, Role, StudentConfig, SharedSpace } from "./settings/types";
import { SHARES_DOC_ID, RTCONFIG_DOC_ID } from "./core/model/types";
import { ClassSyncSettingTab, SettingsHost } from "./settings/SettingsTab";
import { Logger } from "./core/log/Logger";
import { CoreServices } from "./core/CoreServices";
import { ClassSyncMode } from "./modes/ClassSyncMode";
import { StudentMode } from "./modes/student/StudentMode";
import { TeacherMode } from "./modes/teacher/TeacherMode";
import { TFile, TFolder } from "obsidian";
import { RoleSetupModal } from "./ui/RoleSetupModal";
import { InviteModal } from "./ui/InviteModal";
import { ConflictModal, ConflictRow, ConflictHost } from "./ui/ConflictModal";
import { ResolveChoice } from "./core/sync/ConflictManager";
import { BulkCopy, CopyOptions, CopyResult } from "./modes/teacher/BulkCopy";
import { RealtimeManager } from "./core/realtime/RealtimeManager";
import { mintSpaceToken } from "./core/realtime/spaceToken";
import { realtimeEditorExtension } from "./core/realtime/editorBinding";
import { FeedbackStore } from "./core/feedback/FeedbackStore";
import { promptAddFeedback } from "./ui/FeedbackView";
import { ClassSyncPanelView, PANEL_VIEW_TYPE } from "./ui/PanelView";
import { PanelHost, PanelTab, DashboardRow } from "./ui/panel/PanelSection";
import { MirrorSync } from "./core/sync/MirrorSync";
import { testConnection } from "./core/sync/connectionTest";
import { runDiagnostics } from "./core/sync/diagnostics";
import { CouchAdmin } from "./core/couch/CouchAdmin";
import { InvitePayload, INVITE_ACTION, genPassword, parseInvite } from "./core/invite/invite";
import { exportSettings, importSettings } from "./settings/portable";
import { ResetModal } from "./ui/ResetModal";
import { initI18n, t } from "./i18n";

/**
 * Class Sync for Obsidian — 플러그인 진입점.
 *
 * 역할은 최초 1회 선택 후 잠긴다(기술문서 §5.4 보강). 실행 시 저장된 last_seq부터 증분 재개하고,
 * 전체 동기화는 최초 1회와 수동 명령에서만 수행한다.
 */
export default class ClassSyncPlugin extends Plugin implements SettingsHost, ConflictHost, PanelHost {
	settings!: ClassSyncSettings;
	logger = new Logger();
	private core!: CoreServices;
	private mode: ClassSyncMode | null = null;
	private realtime!: RealtimeManager;
	private rtStatus!: HTMLElement;
	private feedback!: FeedbackStore;
	private applyTimer: number | null = null;

	/** PanelHost: 피드백 섹션이 사용. */
	get feedbackStore(): FeedbackStore {
		return this.feedback;
	}

	async onload(): Promise<void> {
		await this.loadSettings();
		initI18n(this.settings.language); // 모든 t() 이전에 로케일 확정

		this.core = new CoreServices(this.app, this.settings, this.logger);
		this.core.save = () => this.saveData(this.settings);

		// 실시간 공동 편집(Yjs) — 공유 폴더 문서
		this.realtime = new RealtimeManager(
			this.app,
			this.core,
			() => this.core.sharedSpaces,
			(p) => this.syncForLocalPath(p), // 주기적 스냅샷 쓰기 대상
		);
		this.core.isRealtimeActive = (p) => this.realtime.isActive(p);
		this.registerEditorExtension(realtimeEditorExtension());

		// 피드백 레이어(§19.5)
		this.feedback = new FeedbackStore(this.core, (p) => this.syncForLocalPath(p));
		this.core.onFeedbackChange = () => this.feedback.refresh();
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onWorkspaceChange()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.onWorkspaceChange()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.onWorkspaceChange()));
		this.rtStatus = this.addStatusBarItem();
		this.registerInterval(window.setInterval(() => this.updateRtStatus(), 2000));

		// 백그라운드(앱/창 비활성) 시 원격 동기화 일시정지 → 배터리/네트워크 절감(기술문서 §24.6)
		this.registerDomEvent(document, "visibilitychange", () => this.onVisibilityChange());

		this.registerView(PANEL_VIEW_TYPE, (leaf: WorkspaceLeaf) => new ClassSyncPanelView(leaf, this));
		this.addSettingTab(new ClassSyncSettingTab(this.app, this));
		this.addRibbonIcon("graduation-cap", t("Class Sync 패널 열기"), () => this.activatePanel());
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

		this.logger.info(t("Class Sync 로드됨 (role={role}, setup={setup}).", { role: this.settings.role, setup: String(this.settings.setupComplete) }));
	}

	async onunload(): Promise<void> {
		if (this.applyTimer) window.clearTimeout(this.applyTimer);
		await this.realtime?.dispose();
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
		// 재배포/설정 적용 시 기존 세션을 깨끗이 종료(awareness 제거) 후 재구성 → 유령 커서 방지
		await this.realtime?.refresh();
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
					if (this.settings.displayName === t("학생A")) this.settings.displayName = t("교사");
				}
				await this.saveSettings();
				this.logger.ok(
					role === "teacher"
						? t("Teacher Mode 설정 완료. ‘시작하기’ 마법사를 따라 진행하세요.")
						: t("Student Mode 설정 완료. 교사 초대(QR/코드)로 연결하세요."),
					true,
				);
				await this.startMode();
				// 교사는 온보딩 마법사를 자동으로 띄운다(이미 완료/닫았으면 생략).
				if (role === "teacher" && !this.settings.teacherOnboardingDone) await this.activatePanel("setup");
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
		this.logger.warn(t("역할/동기화 상태/로컬 캐시를 초기화했습니다. 역할을 다시 선택하세요."), true);
		this.promptRoleSetup();
	}

	/** 현재 역할이 로컬 캐시를 가진 모든 DB(개인/학생 mirror + 공유 공간). 중복 제거. */
	private collectLocalDbs(): string[] {
		const s = this.settings;
		const dbs =
			s.role === "teacher"
				? s.students.map((st) => st.remoteDb)
				: [s.remoteDb];
		dbs.push(...s.sharedSpaces.map((sp) => sp.remoteDb));
		return [...new Set(dbs.filter((d) => d))];
	}

	/** 현재 역할의 모든 mirror DB + 공유 공간 DB 로컬 캐시(IndexedDB)를 삭제. */
	private async destroyLocalCaches(): Promise<void> {
		const dbs = this.collectLocalDbs();
		for (const db of dbs) {
			try {
				const p = this.core.createPouch(db);
				await p.destroyLocal();
				await p.close();
				this.logger.ok(t("로컬 캐시 삭제: {db}", { db }));
			} catch (e) {
				this.logger.error(t("로컬 캐시 삭제 실패({db}): {err}", { db, err: e instanceof Error ? e.message : String(e) }));
			}
		}
	}

	/** 로컬 캐시 초기화 후 서버에서 다시 받기. 명령에서 호출. */
	async resetLocalCache(): Promise<void> {
		await this.activatePanel("log");
		await this.mode?.stop();
		this.mode = null;
		await this.destroyLocalCaches();
		this.settings.lastSeqByDb = {};
		await this.saveSettings();
		if (this.settings.setupComplete) await this.startMode();
		this.logger.ok(t("로컬 캐시를 초기화했습니다. 서버에서 다시 동기화합니다."), true);
	}

	// --- 학생 프로비저닝 + 초대 (Teacher) ---
	/** 성공(프로비저닝+초대 표시) 시 true. 실패 시 false(호출자가 로컬 상태를 되돌릴 수 있게). */
	async inviteStudent(student: StudentConfig): Promise<boolean> {
		await this.activatePanel("log");
		const s = this.settings;
		if (!s.couchdbUrl || !s.username || !s.password) {
			this.logger.warn(t("관리자 계정(CouchDB URL/사용자/비밀번호)을 먼저 입력하세요."), true);
			return false;
		}
		if (!student.studentId) {
			this.logger.warn(t("학생 ID를 입력하세요."), true);
			return false;
		}
		// 기본값 보정
		if (!student.username) student.username = student.studentId;
		if (!student.remoteDb) student.remoteDb = `mirror_${student.studentId}`;
		if (!student.localRoot) student.localRoot = student.studentName || student.studentId;
		if (!student.password) student.password = genPassword();

		this.logger.info(t("학생 프로비저닝: {id} → {db}", { id: student.studentId, db: student.remoteDb }));
		const admin = new CouchAdmin(s.couchdbUrl, s.username, s.password);
		const res = await admin.provisionStudent({
			username: student.username,
			password: student.password,
			remoteDb: student.remoteDb,
		});
		if (!res.ok) {
			this.logger.error(t("프로비저닝 실패: {err}", { err: res.error ?? "" }), true);
			return false;
		}
		student.provisioned = true;
		await this.saveSettings();
		this.requestApply(); // 새 학생 링크를 자동으로 동기화에 반영
		this.logger.ok(t("프로비저닝 완료: {id} (계정/DB/권한)", { id: student.studentId }), true);

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
		return true;
	}

	/**
	 * 학생 비밀번호 재발급(회전). 새 비밀번호로 _users를 갱신하므로 **이전 초대 코드는 즉시 무효**가 된다.
	 * 잃어버린/유출된 초대를 폐기하는 용도. 새 초대 코드를 바로 보여준다.
	 *
	 * 서버 갱신이 실패하면 로컬 비밀번호를 이전 값으로 되돌려, 로컬만 새 비밀번호로 바뀐 불일치를 막는다.
	 */
	async rotateStudentPassword(student: StudentConfig): Promise<void> {
		if (this.settings.role !== "teacher") return;
		if (!student.studentId) {
			this.logger.warn(t("학생 ID를 입력하세요."), true);
			return;
		}
		const prev = student.password;
		student.password = genPassword(); // 새 비밀번호 후보
		this.logger.info(t("비밀번호 재발급(이전 초대 무효): {id}", { id: student.studentId }), true);
		const ok = await this.inviteStudent(student); // 재프로비저닝(_users 갱신) + 새 초대 표시
		if (!ok) {
			student.password = prev; // 서버 실패 → 로컬 되돌림(이전 비밀번호/초대 유지)
			this.logger.warn(t("비밀번호 재발급 실패 — 이전 비밀번호를 유지합니다."), true);
		}
	}

	// --- 공유 공간 배포 (Teacher) ---
	async deployShared(space: SharedSpace): Promise<void> {
		await this.activatePanel("log");
		const s = this.settings;
		if (s.role !== "teacher") {
			this.logger.warn(t("교사 모드에서만 사용할 수 있습니다."), true);
			return;
		}
		if (!s.couchdbUrl || !s.username || !s.password) {
			this.logger.warn(t("관리자 계정을 먼저 입력하세요."), true);
			return;
		}
		if (!space.remoteDb) space.remoteDb = `share_${space.id}`;
		if (!space.folder) space.folder = space.name || space.id;

		const admin = new CouchAdmin(s.couchdbUrl, s.username, s.password);
		const memberUsers = space.members
			.map((sid) => s.students.find((st) => st.studentId === sid)?.username)
			.filter((u): u is string => !!u);

		this.logger.info(t("공유 공간 배포: {name} → {db} (멤버 {count})", { name: space.name, db: space.remoteDb, count: memberUsers.length }));
		const res = await admin.provisionSharedSpace(space.remoteDb, memberUsers);
		if (!res.ok) {
			this.logger.error(t("공유 공간 프로비저닝 실패: {err}", { err: res.error ?? "" }), true);
			return;
		}
		space.provisioned = true;

		// HMAC 모드(yjsSecret 설정): 배포 때마다 **모든** 공유 공간 토큰을 재발급한다. 이 배포에서 모든 학생의
		// shares 문서가 다시 기록되므로, 시크릿 변경/TTL 만료 시 구 토큰이 그대로 다시 내려가는 일을 막는다.
		// (유출 시 해당 공간 room만 접근 가능 — 학급 전체 아님.)
		if (s.yjsSecret) {
			const ttl =
				s.yjsTokenTtlDays && s.yjsTokenTtlDays > 0
					? Math.floor(Date.now() / 1000) + s.yjsTokenTtlDays * 86400
					: undefined;
			for (const sp of s.sharedSpaces) {
				sp.token = await mintSpaceToken(s.yjsSecret, { classId: s.classId, spaceId: sp.id, exp: ttl });
			}
		}
		await this.saveSettings();

		// 모든 학생의 shares + rtconfig 문서 갱신(추가/제거 학생 모두 반영)
		for (const st of s.students) {
			const spaces = s.sharedSpaces
				.filter((sp) => sp.members.includes(st.studentId))
				.map((sp) => ({ id: sp.id, name: sp.name, remoteDb: sp.remoteDb, folder: sp.folder, token: sp.token }));
			const r = await admin.putDoc(st.remoteDb, { _id: SHARES_DOC_ID, type: "shares", spaces });
			if (!r.ok) this.logger.error(t("shares 기록 실패({id}): {err}", { id: st.studentId, err: r.error ?? "" }));
			const rc = await admin.putDoc(st.remoteDb, {
				_id: RTCONFIG_DOC_ID,
				type: "rtconfig",
				enabled: s.realtimeEnabled,
				url: s.yjsServerUrl,
				token: s.yjsToken,
				snapshotSec: s.realtimeSnapshotSec,
			});
			if (!rc.ok) this.logger.error(t("rtconfig 기록 실패({id}): {err}", { id: st.studentId, err: rc.error ?? "" }));
		}

		this.logger.ok(t("공유 공간 배포 완료: {name}", { name: space.name }), true);
		await this.restartMode();
	}

	// --- 학생 온보딩: 초대 코드/딥링크로 자동 설정 ---
	async ingestInvite(input: string): Promise<void> {
		const payload = parseInvite(input);
		if (!payload) {
			new Notice(t("Class Sync: 초대 코드를 해석할 수 없습니다."));
			this.logger.error(t("초대 코드 파싱 실패."));
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

		await this.activatePanel("log");
		this.logger.ok(t("초대 적용 완료: {name} ({db}). 동기화를 시작합니다.", { name: payload.studentName, db: payload.remoteDb }), true);
		await this.startMode();
	}

	// --- 연결 테스트 (설정 버튼) — 항상 최신 설정으로, 역할별 DB 전체 검사 ---
	async testConnection(): Promise<void> {
		await this.activatePanel("log");
		const dbs =
			this.settings.role === "teacher"
				? this.settings.students.map((s) => s.remoteDb).filter((d) => d)
				: [this.settings.remoteDb];
		if (dbs.length === 0) {
			this.logger.warn(t("테스트할 mirror DB가 없습니다. (교사: 학생을 추가하세요)"), true);
			return;
		}
		for (const db of dbs) await testConnection(this.core, db);
	}

	/** 종합 진단: 서버 도달 + 활성 링크별 읽기/쓰기 권한 + 실시간 상태. */
	async runDiagnostics(): Promise<void> {
		await this.activatePanel("log");
		const targets = (this.mode?.getSyncs() ?? []).map((s) => ({ db: s.remoteDb, label: s.label }));
		await runDiagnostics(this.core, targets);
		this.realtime.diagnose();
	}

	// --- 충돌 해소 (ConflictHost) ---
	async listConflicts(): Promise<ConflictRow[]> {
		const rows: ConflictRow[] = [];
		for (const sync of this.mode?.getSyncs() ?? []) {
			try {
				const infos = await sync.listConflicts();
				for (const info of infos) rows.push({ sync, info });
			} catch (e) {
				this.logger.error(t("충돌 목록 조회 실패({label}): {err}", { label: sync.label, err: e instanceof Error ? e.message : String(e) }));
			}
		}
		return rows;
	}

	async resolveConflict(row: ConflictRow, choice: ResolveChoice): Promise<void> {
		await this.activatePanel("log");
		await row.sync.resolveConflict(row.info.dbPath, choice);
	}

	async openConflictFiles(row: ConflictRow): Promise<void> {
		const local = this.app.vault.getAbstractFileByPath(row.info.localPath);
		const conflict = this.app.vault.getAbstractFileByPath(row.info.conflictPath);
		if (local instanceof TFile) await this.app.workspace.getLeaf(false).openFile(local);
		if (conflict instanceof TFile) await this.app.workspace.getLeaf("split").openFile(conflict);
		else this.logger.warn(t("원격본 파일이 없습니다: {path}", { path: row.info.conflictPath }), true);
	}

	// --- 설정 내보내기/가져오기 (기술문서 §22.4) ---
	exportSettingsJson(): string {
		return exportSettings(this.settings);
	}

	async importSettingsJson(json: string): Promise<{ ok: boolean; error?: string }> {
		const res = importSettings(this.settings, json);
		if (!res.ok) {
			this.logger.error(t("설정 가져오기 실패: {err}", { err: res.error }), true);
			return { ok: false, error: res.error };
		}
		this.settings = res.settings;
		this.core.settings = this.settings;
		await this.saveSettings();
		if (this.settings.setupComplete) await this.restartMode();
		this.logger.ok(t("설정을 가져와 적용했습니다. 비밀번호/Yjs 토큰은 다시 입력하고, 가져온 학생은 재초대하세요."), true);
		return { ok: true };
	}

	/**
	 * 서버 데이터 초기화(교사 전용, 파괴적). 모든 학생/공유 CouchDB DB를 삭제하고(선택 시 계정도),
	 * 로컬 캐시·프로비저닝 상태를 비운다. 학급 구성(목록)은 유지 → 재초대·재배포로 복구.
	 * Yjs 실시간 데이터는 플러그인이 못 지우므로 수동 안내만 표시한다.
	 */
	async resetServerData(deleteAccounts: boolean): Promise<void> {
		await this.activatePanel("log");
		const s = this.settings;
		if (s.role !== "teacher") {
			this.logger.warn(t("교사 모드에서만 사용할 수 있습니다."), true);
			return;
		}
		if (!s.couchdbUrl || !s.username || !s.password) {
			this.logger.warn(t("관리자 계정을 먼저 입력하세요."), true);
			return;
		}
		const admin = new CouchAdmin(s.couchdbUrl, s.username, s.password);
		const chk = await admin.checkAdmin();
		if (!chk.ok) {
			this.logger.error(t("관리자 인증 실패: {err}", { err: chk.error ?? "" }), true);
			return;
		}

		// 실행 중 엔진 정지(삭제할 DB로의 replication 차단). 대기 중 자동-적용도 취소.
		if (this.applyTimer) {
			window.clearTimeout(this.applyTimer);
			this.applyTimer = null;
		}
		await this.mode?.stop();
		this.mode = null;

		const dbs = [
			...s.students.map((st) => st.remoteDb).filter((d) => d),
			...s.sharedSpaces.map((sp) => sp.remoteDb).filter((d) => d),
		];
		this.logger.info(t("서버 데이터 초기화 시작 — DB {count}개{accounts}", { count: dbs.length, accounts: deleteAccounts ? t(" + 학생 계정") : "" }), true);

		for (const db of dbs) {
			const r = await admin.deleteDatabase(db);
			if (r.ok) this.logger.ok(t("DB 삭제: {db}", { db }));
			else this.logger.error(t("DB 삭제 실패: {db} — {err}", { db, err: r.error ?? "" }));
			// 로컬 PouchDB 캐시도 제거
			try {
				const p = this.core.createPouch(db);
				await p.destroyLocal();
				await p.close();
			} catch {
				/* 캐시 없음 등 무시 */
			}
		}

		if (deleteAccounts) {
			for (const st of s.students) {
				if (!st.username) continue;
				const r = await admin.deleteUser(st.username);
				if (r.ok) this.logger.ok(t("계정 삭제: {user}", { user: st.username }));
				else this.logger.error(t("계정 삭제 실패: {user} — {err}", { user: st.username, err: r.error ?? "" }));
			}
		}

		// 로컬 상태 초기화
		if (deleteAccounts) {
			// 계정까지 삭제 → 학급 명단(학생·공유 공간)도 완전 비움(처음부터 다시 구성)
			s.students = [];
			s.sharedSpaces = [];
			this.core.sharedSpaces = [];
		} else {
			// DB만 삭제 → 명단 유지, 프로비저닝 상태만 리셋(재초대로 복구)
			for (const st of s.students) st.provisioned = false;
			for (const sp of s.sharedSpaces) sp.provisioned = false;
		}
		s.lastSeqByDb = {};
		await this.saveSettings();

		this.logger.warn(
			t("Yjs 실시간 데이터는 수동 초기화하세요: NAS에서 yjs-websocket 컨테이너 재시작 또는 ./data 폴더 비우기 (docker compose down → data 삭제 → up)."),
			true,
		);
		this.logger.ok(
			deleteAccounts
				? t("서버 데이터·계정 초기화 완료. 학생 목록·공유 공간이 비워졌습니다 — 처음부터 다시 추가·초대·배포하세요.")
				: t("서버 데이터 초기화 완료. 학생 ‘초대’ → 공유 공간 ‘재배포’ 하면 자동으로 다시 동기화됩니다."),
			true,
		);
	}

	/** 언어 변경 시 로케일 재초기화 + 열린 패널 새로고침(설정 탭은 호출 측에서 display). */
	refreshUiLanguage(): void {
		initI18n(this.settings.language);
		for (const leaf of this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)) {
			if (leaf.view instanceof ClassSyncPanelView) leaf.view.refresh();
		}
	}

	/** 교사 온보딩 완료 표시(마법사 자동 노출 중단). */
	async completeOnboarding(): Promise<void> {
		this.settings.teacherOnboardingDone = true;
		await this.saveSettings();
	}

	/** 플러그인 설정 탭 열기(대시보드 조치 카드 CTA용). */
	openSettings(): void {
		const setting = (this.app as unknown as { setting?: { open?: () => void; openTabById?: (id: string) => void } }).setting;
		setting?.open?.();
		setting?.openTabById?.(this.manifest.id);
	}

	/** 설정 탭에서 초기화 모달 실행(교사 전용). */
	openResetModal(): void {
		if (this.settings.role !== "teacher") {
			new Notice(t("Class Sync: 교사 모드에서만 사용할 수 있습니다."));
			return;
		}
		const dbCount =
			this.settings.students.filter((st) => st.remoteDb).length +
			this.settings.sharedSpaces.filter((sp) => sp.remoteDb).length;
		new ResetModal(this.app, dbCount, (deleteAccounts) => this.resetServerData(deleteAccounts)).open();
	}

	/** 연결/경로 설정 변경을 실행 중 엔진에 반영(재시작). */
	async restartMode(): Promise<void> {
		if (!this.settings.setupComplete) return;
		await this.mode?.stop();
		await this.startMode();
		this.logger.ok(t("설정을 적용해 동기화를 재시작했습니다."), true);
	}

	/**
	 * 구조 변경(연결·학생·공유)을 자동 적용. 잦은 변경을 모아 한 번만 재시작(타이핑 중 재연결 방지).
	 * 별도 '적용' 버튼 없이 설정 변경이 곧바로 반영되게 한다.
	 */
	requestApply(): void {
		if (!this.settings.setupComplete) return;
		if (this.applyTimer) window.clearTimeout(this.applyTimer);
		this.applyTimer = window.setTimeout(() => {
			this.applyTimer = null;
			void this.restartMode();
		}, 500);
	}

	// --- 명령 등록 (패널 버튼과 동일 메서드를 호출) ---
	private registerCommands(): void {
		this.addCommand({ id: "class-sync-open-panel", name: t("패널 열기"), callback: () => this.activatePanel() });
		this.addCommand({ id: "class-sync-open-log", name: t("로그 패널 열기"), callback: () => this.activatePanel("log") });
		this.addCommand({
			id: "class-sync-test-connection",
			name: t("연결/권한 테스트"),
			callback: () => this.testConnection(),
		});
		this.addCommand({
			id: "class-sync-diagnostics",
			name: t("종합 진단 실행 (서버·읽기/쓰기 권한·실시간)"),
			callback: () => this.runDiagnostics(),
		});
		this.addCommand({ id: "class-sync-full-sync", name: t("전체 동기화"), callback: () => this.fullSync("both") });
		this.addCommand({ id: "class-sync-upload-only", name: t("업로드만 실행"), callback: () => this.fullSync("up") });
		this.addCommand({ id: "class-sync-download-only", name: t("다운로드만 실행"), callback: () => this.fullSync("down") });
		this.addCommand({
			id: "class-sync-toggle-autosync",
			name: t("자동 동기화 켜기/끄기"),
			callback: () => this.toggleAutoSync(),
		});
		this.addCommand({
			id: "class-sync-reset-local",
			name: t("로컬 캐시 초기화 (서버에서 다시 받기)"),
			callback: () => this.resetLocalCache(),
		});
		this.addCommand({
			id: "class-sync-conflicts",
			name: t("충돌 목록 열기"),
			callback: () => this.openConflictModal(),
		});
		this.addCommand({
			id: "class-sync-dashboard",
			name: t("동기화 상태 열기"),
			callback: () => this.activatePanel("sync"),
		});
		this.addCommand({
			id: "class-sync-deploy",
			name: t("학생에게 복사 (배포 탭 열기)"),
			callback: () => this.activatePanel("deploy"),
		});
		this.addCommand({
			id: "class-sync-realtime-status",
			name: t("실시간 상태 점검"),
			callback: () => this.realtimeStatus(),
		});
		this.addCommand({
			id: "class-sync-add-feedback",
			name: t("피드백 추가 (선택 영역)"),
			callback: () => promptAddFeedback(this.app, this.feedback),
		});
		this.addCommand({
			id: "class-sync-open-feedback",
			name: t("피드백 패널 열기"),
			callback: () => this.activatePanel("feedback"),
		});
		this.addCommand({
			id: "class-sync-refresh-shares",
			name: t("공유 공간 새로고침"),
			callback: () => this.refreshShares(),
		});
	}

	// --- 패널 버튼/명령 공용 동작 (PanelHost) ---

	/** 전체/업로드/다운로드 수동 동기화. */
	async fullSync(dir: "both" | "up" | "down"): Promise<void> {
		await this.activatePanel("log");
		await this.mode?.fullSync(dir);
	}

	/** 실시간 세션 점검 + 진단 로그. */
	async realtimeStatus(): Promise<void> {
		await this.activatePanel("log");
		this.realtime.syncOpenEditors();
		this.realtime.diagnose();
	}

	/** 공유 공간 새로고침(학생=shares 재조회, 교사=재시작). */
	async refreshShares(): Promise<void> {
		await this.activatePanel("log");
		const m = this.mode as unknown as { refreshShares?: () => Promise<void> } | null;
		if (this.settings.role === "student" && m?.refreshShares) await m.refreshShares();
		else await this.restartMode();
	}

	// --- 교사 편의: 경로(파일/폴더)를 학생에게 복사 (기술문서 §12.5 / §20). 배포 탭에서 호출. ---
	async bulkCopy(
		sourcePath: string,
		opts: CopyOptions,
		studentIds: string[],
	): Promise<CopyResult & { error?: string }> {
		if (this.settings.role !== "teacher") {
			return { written: 0, skipped: 0, error: t("교사 모드에서만 사용할 수 있습니다.") };
		}
		const src = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(src instanceof TFile) && !(src instanceof TFolder)) {
			return { written: 0, skipped: 0, error: t("경로를 찾을 수 없습니다: {path}", { path: sourcePath }) };
		}
		const targets = this.settings.students.filter((st) => studentIds.includes(st.studentId));
		if (targets.length === 0) {
			return { written: 0, skipped: 0, error: t("대상 학생이 없습니다.") };
		}
		const bulk = new BulkCopy(this.app, this.settings);
		try {
			if (src instanceof TFolder) return await bulk.copyFolder(src, targets, opts);
			// 파일: 대상 경로가 비어 있으면 원본 파일명으로 보낸다.
			const fileOpts = opts.destPath ? opts : { ...opts, destPath: src.name };
			return await bulk.copyFile(src, targets, fileOpts);
		} catch (e) {
			return { written: 0, skipped: 0, error: e instanceof Error ? e.message : String(e) };
		}
	}

	// --- 동기화 상태 (PanelHost) ---
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

	/** 통합 패널 활성화(우측 사이드바). tab을 주면 해당 탭으로 전환. */
	async activatePanel(tab?: PanelTab): Promise<void> {
		let leaf = this.app.workspace.getLeavesOfType(PANEL_VIEW_TYPE)[0];
		if (!leaf) {
			const right = this.app.workspace.getRightLeaf(false);
			if (!right) return;
			await right.setViewState({ type: PANEL_VIEW_TYPE, active: true });
			leaf = right;
		}
		this.app.workspace.revealLeaf(leaf);
		if (tab && leaf.view instanceof ClassSyncPanelView) leaf.view.setTab(tab);
	}

	/** 로컬 경로를 담당하는 동기화 링크(피드백 저장/조회 + 실시간 스냅샷 대상). 없으면 undefined. */
	private syncForLocalPath(localPath: string): MirrorSync | undefined {
		for (const sync of this.mode?.getSyncs() ?? []) {
			if (sync.owns(localPath)) return sync;
		}
		return undefined;
	}

	/** autoSync 토글 — 모드를 재시작해 감시/구독을 켜거나 끈다. */
	async toggleAutoSync(): Promise<void> {
		this.settings.autoSync = !this.settings.autoSync;
		await this.saveSettings();
		this.logger.info(t("자동 동기화: {state}", { state: this.settings.autoSync ? t("켜짐") : t("꺼짐") }), true);
		if (this.settings.setupComplete) {
			await this.mode?.stop();
			await this.startMode();
		}
	}

	// --- 백그라운드 동기화 일시정지 (모바일 배터리/네트워크 절감) ---
	private onVisibilityChange(): void {
		if (!this.settings.pauseWhenHidden) return;
		const hidden = document.hidden;
		for (const sync of this.mode?.getSyncs() ?? []) {
			if (hidden) sync.pauseReplication();
			else sync.resumeReplication();
		}
	}

	// --- 실시간 상태바 ---
	private onWorkspaceChange(): void {
		this.realtime?.syncOpenEditors();
		this.updateRtStatus();
	}

	private updateRtStatus(): void {
		if (!this.rtStatus) return;
		const file = this.app.workspace.getActiveFile();
		const n = file ? this.realtime.presenceFor(file.path) : 0;
		this.rtStatus.setText(n > 0 ? t("🟢 실시간 {n}명", { n }) : "");
	}
}
