import { CoreServices } from "../CoreServices";
import { PouchService } from "../couch/PouchService";
import { MirrorContext } from "./MirrorContext";
import { MirrorApplier } from "./MirrorApplier";
import { ConflictManager, ConflictInfo, ResolveChoice } from "./ConflictManager";
import { Uploader } from "./Uploader";
import { LocalWatcher } from "./LocalWatcher";
import { LocalApplier } from "./LocalApplier";
import { FullSync, SyncDirection } from "./FullSync";

/**
 * 하나의 student↔mirror 링크 동기화 엔진. 기술문서 §23.3.
 *
 * 오프라인 우선 구조:
 *  - PouchDB live replication(retry)으로 로컬 DB ↔ 원격을 자동 동기화(오프라인 큐·재연결·충돌).
 *  - LocalApplier: 로컬 DB 변경 → vault 반영
 *  - LocalWatcher: vault 변경 → 로컬 DB 기록(replication이 원격 전파)
 *
 * 실행 동작:
 *  - 최초: 기존 vault 파일을 로컬 DB로 1회 업로드 스캔(원격 문서는 replication이 자동으로 가져와 반영)
 *  - 이후: 저장된 local seq부터 증분 적용 + 상시 replication
 */
export interface MirrorSyncOptions {
	studentId: string;
	studentName: string;
	localRoot: string;
	remoteDb: string;
	childRoots?: string[];
	pouch?: PouchService;
	/** 'shares' 등 설정 문서가 바뀌면 호출(학생이 공유 링크 reconcile). */
	onConfigChange?: () => void;
}

export class MirrorSync {
	readonly ctx: MirrorContext;
	private readonly applier: MirrorApplier;
	private readonly conflicts: ConflictManager;
	private readonly uploader: Uploader;
	private readonly watcher: LocalWatcher;
	private readonly localApplier: LocalApplier;
	private readonly fullSyncRunner: FullSync;
	private started = false;

	constructor(core: CoreServices, opts: MirrorSyncOptions) {
		const remoteDb = opts.remoteDb;
		this.ctx = new MirrorContext(
			core,
			opts.studentId,
			opts.studentName,
			opts.localRoot,
			remoteDb,
			opts.pouch ?? core.createPouch(remoteDb),
			opts.childRoots ?? [],
		);
		this.conflicts = new ConflictManager(this.ctx);
		this.applier = new MirrorApplier(this.ctx, this.conflicts);
		this.uploader = new Uploader(this.ctx);
		this.watcher = new LocalWatcher(this.ctx, this.uploader);
		this.localApplier = new LocalApplier(this.ctx, this.applier, opts.onConfigChange);
		this.fullSyncRunner = new FullSync(this.ctx, this.applier, this.uploader);
	}

	/** 이 링크의 라벨(학생 식별). */
	get label(): string {
		return this.ctx.studentId || this.ctx.remoteDb;
	}

	// 대시보드용 정보 노출
	get studentId(): string {
		return this.ctx.studentId;
	}
	get studentName(): string {
		return this.ctx.studentName;
	}
	get remoteDb(): string {
		return this.ctx.remoteDb;
	}
	get localRoot(): string {
		return this.ctx.localRoot;
	}
	get status() {
		return this.ctx.status;
	}

	listConflicts(): Promise<ConflictInfo[]> {
		return this.conflicts.list();
	}

	resolveConflict(dbPath: string, choice: ResolveChoice): Promise<void> {
		return this.conflicts.resolve(dbPath, choice);
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;

		if (!this.ctx.settings.autoSync) {
			this.ctx.status.state = "disabled";
			this.ctx.logger.info("autoSync 꺼짐 — 자동 동기화 비활성. 수동 동기화만 가능.");
			return;
		}
		if (!this.ctx.settings.couchdbUrl) {
			this.ctx.status.state = "offline";
			this.ctx.logger.warn("CouchDB URL이 없습니다. 설정 후 '설정 적용'을 누르세요.", true);
			return;
		}
		this.ctx.status.state = "syncing";

		// 실시간 동기화를 켜기 전에, vault의 미반영 편집을 먼저 로컬 DB로 올린다.
		// (앱이 꺼져 있거나 autoSync가 꺼진 동안 생긴 편집 포함.)
		// 이래야 들어오는 원격 변경과 PouchDB 충돌(_conflicts)이 제대로 생겨,
		// 로컬 편집이 원격 버전에 덮이지 않는다. 기술문서 §17.2.
		try {
			await this.fullSyncRunner.run("up");
		} catch (e) {
			this.ctx.logger.error(`시작 시 업로드 정합 실패: ${e instanceof Error ? e.message : String(e)}`, true);
		}

		// 로컬 DB 변경을 vault에 반영(원격에서 replication으로 들어온 것 포함)
		this.localApplier.start();
		// 로컬 ↔ 원격 live replication (오프라인 큐·재연결·충돌)
		this.ctx.pouch.startReplication({
			onActive: () => {
				this.ctx.status.state = "syncing";
			},
			onPaused: () => {
				if (this.ctx.status.state !== "error") this.ctx.status.state = "idle";
				this.ctx.logger.info(`동기화 따라잡음(idle): ${this.ctx.remoteDb}`);
			},
			onError: (e) => {
				this.ctx.status.lastError = e.message;
				this.ctx.status.state = "error";
				// 인증 실패면 재시도를 멈춘다(계속 두드리면 서버가 계정을 잠금).
				if (isAuthError(e.message)) {
					this.ctx.pouch.stopReplication();
					this.ctx.logger.error(
						`인증 실패로 동기화 중지: ${this.ctx.remoteDb} — ${e.message}. 자격증명/초대를 확인 후 '설정 적용'으로 재시작하세요.`,
						true,
					);
				} else {
					this.ctx.logger.error(`replication 오류: ${e.message}`);
				}
			},
		});
		// vault 변경 감시
		this.watcher.start();
	}

	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		this.ctx.status.state = "disabled";
		this.watcher.stop();
		this.localApplier.stop();
		await this.ctx.core.flushPersist();
		await this.ctx.pouch.close();
	}

	fullSync(direction: SyncDirection = "both"): Promise<void> {
		return this.fullSyncRunner.run(direction);
	}
}

/** 인증/계정잠금 류 오류 판별(재시도 폭주 방지). */
function isAuthError(message: string): boolean {
	return /unauthorized|name or password|password is incorrect|forbidden|locked|\b401\b|\b403\b/i.test(message);
}
