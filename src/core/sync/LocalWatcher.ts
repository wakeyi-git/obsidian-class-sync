import { EventRef, TAbstractFile, TFile } from "obsidian";
import { MirrorContext } from "./MirrorContext";
import { Uploader } from "./Uploader";
import { sha256 } from "../hash/hash";

/**
 * vault 변경 감지 → debounce → 업로드. 기술문서 §11.2 / §11.3.
 *
 * ⚠️ 시작 시점이 중요하다: Obsidian은 앱 시작 시 기존 전 파일에 'create'를 한 번씩 발생시킨다.
 * 따라서 workspace.onLayoutReady() 이후에만 이벤트를 등록해 시작 시 전체 재업로드를 막는다.
 * Phase 1은 create/modify만 다룬다(이동/이름변경/삭제는 Phase 3).
 */
export class LocalWatcher {
	private refs: EventRef[] = [];
	private timers = new Map<string, ReturnType<typeof setTimeout>>();
	private started = false;

	constructor(
		private ctx: MirrorContext,
		private uploader: Uploader,
	) {}

	start(): void {
		if (this.started) return;
		this.started = true;
		// 시작 create 폭주 회피: layout-ready 이후 등록
		this.ctx.app.workspace.onLayoutReady(() => {
			if (!this.started) return; // 등록 전에 stop된 경우
			const vault = this.ctx.app.vault;
			this.refs.push(vault.on("create", (f) => this.onChange(f)));
			this.refs.push(vault.on("modify", (f) => this.onChange(f)));
			this.refs.push(vault.on("rename", (f, oldPath) => this.onRename(f, oldPath)));
			this.refs.push(vault.on("delete", (f) => this.onDelete(f)));
			this.ctx.logger.info(`LocalWatcher 시작 (localRoot=${this.ctx.localRoot || "(vault root)"})`);
		});
	}

	stop(): void {
		this.started = false;
		for (const ref of this.refs) this.ctx.app.vault.offref(ref);
		this.refs = [];
		for (const t of this.timers.values()) clearTimeout(t);
		this.timers.clear();
	}

	private onChange(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const localPath = file.path;

		// 빠른 1차 필터(상세 필터는 Uploader가 재확인)
		if (!this.ctx.isMarkdown(localPath)) return;
		if (this.ctx.isExcluded(localPath)) return;
		const dbPath = this.ctx.toDbPath(localPath);
		if (dbPath == null) return; // localRoot 밖

		void this.maybeSchedule(localPath, dbPath);
	}

	/**
	 * 원격 적용(applier)으로 인한 echo면 guard로 걸러 아예 무시한다(pending도 잡지 않음).
	 * 진짜 사용자 편집만 pending 표시 + 업로드 예약 → 디바운스 동안 원격 적용이 덮지 못하게.
	 */
	private async maybeSchedule(localPath: string, dbPath: string): Promise<void> {
		const content = await this.ctx.readVaultFile(localPath);
		if (content == null) return;
		const hash = await sha256(content);
		if (this.ctx.guard.shouldIgnore(localPath, hash)) return; // applier echo → 무시 (§16.2)

		this.ctx.markPending(dbPath);
		this.scheduleUpload(localPath, dbPath);
	}

	/**
	 * 이름변경/이동. 기술문서 §10.3: 옛 경로 tombstone + 새 경로 생성.
	 * applier가 archive로 일으킨 이동은 suppress로 걸러진다.
	 */
	private onRename(file: TAbstractFile, oldPath: string): void {
		if (!(file instanceof TFile)) return; // 폴더 이름변경은 범위 밖
		const newPath = file.path;
		if (this.ctx.isStructuralSuppressed(oldPath) || this.ctx.isStructuralSuppressed(newPath)) return;
		void this.handleRename(oldPath, newPath);
	}

	private async handleRename(oldPath: string, newPath: string): Promise<void> {
		try {
			// 옛 경로가 동기화 범위 안 markdown이면 tombstone
			const oldDb = this.ctx.toDbPath(oldPath);
			if (oldDb != null && this.ctx.isMarkdown(oldPath) && !this.ctx.isExcluded(oldPath)) {
				await this.uploader.tombstonePath(oldDb);
			}
			// 새 경로가 범위 안 markdown이면 업로드
			const newDb = this.ctx.toDbPath(newPath);
			if (newDb != null && this.ctx.isMarkdown(newPath) && !this.ctx.isExcluded(newPath)) {
				this.ctx.markPending(newDb);
				try {
					await this.uploader.uploadPath(newPath);
				} finally {
					this.ctx.clearPending(newDb);
				}
			}
		} catch (e) {
			this.ctx.logger.error(`이름변경 처리 실패: ${oldPath} → ${newPath} — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/**
	 * 삭제.
	 *  - .deleted/ 안의 파일을 지우면 → DB 문서 영구 제거(purge). 아카이브가 무한히 쌓이지 않게.
	 *  - 일반 파일 삭제 → tombstone(상대 vault는 정책대로 처리, 기술문서 §10.4).
	 */
	private onDelete(file: TAbstractFile): void {
		if (!(file instanceof TFile)) return;
		const localPath = file.path;
		if (this.ctx.isStructuralSuppressed(localPath)) return; // applier가 일으킨 삭제/이동 echo
		if (!this.ctx.isMarkdown(localPath)) return;

		// .deleted/ 안에서 삭제 → purge
		const archivedDb = this.ctx.archiveDbPath(localPath);
		if (archivedDb != null) {
			void this.uploader
				.purgePath(archivedDb)
				.catch((e) => this.ctx.logger.error(`purge 실패: ${localPath} — ${e instanceof Error ? e.message : String(e)}`));
			return;
		}

		// 일반 삭제 → tombstone
		if (this.ctx.isExcluded(localPath)) return;
		const dbPath = this.ctx.toDbPath(localPath);
		if (dbPath == null) return;
		void this.uploader
			.tombstonePath(dbPath)
			.catch((e) => this.ctx.logger.error(`삭제 처리 실패: ${localPath} — ${e instanceof Error ? e.message : String(e)}`));
	}

	private scheduleUpload(localPath: string, dbPath: string): void {
		const existing = this.timers.get(localPath);
		if (existing) clearTimeout(existing);
		const timer = setTimeout(() => {
			this.timers.delete(localPath);
			void this.flushUpload(localPath, dbPath);
		}, this.ctx.settings.debounceMs);
		this.timers.set(localPath, timer);
	}

	private async flushUpload(localPath: string, dbPath: string): Promise<void> {
		try {
			await this.uploader.uploadPath(localPath);
		} catch (e) {
			this.ctx.logger.error(`업로드 실패: ${localPath} — ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.ctx.clearPending(dbPath);
		}
	}
}
