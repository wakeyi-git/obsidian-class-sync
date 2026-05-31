import { TFile, normalizePath as obsidianNormalize } from "obsidian";
import { CoreServices } from "../CoreServices";
import { PouchService } from "../couch/PouchService";
import { NoteDoc } from "../model/types";
import { sha256 } from "../hash/hash";
import { dbPathToLocal, localPathToDb, normalizePath, validateVaultPath } from "../path/path";

/**
 * 하나의 student↔mirror 링크의 컨텍스트 + 공유 헬퍼. 기술문서 §9 / §16 / §14.2.
 *
 * 경로 매핑, vault 입출력, NoteDoc 빌드, 동기화 상태(syncState)와 changes 체크포인트(lastSeq)를
 * 한곳에서 다룬다. Applier/Watcher/Subscriber/FullSync가 공유한다.
 * Phase 2에서 Teacher는 학생마다 이 컨텍스트를 하나씩 갖는다.
 */
export class MirrorContext {
	constructor(
		public readonly core: CoreServices,
		public readonly studentId: string,
		public readonly localRoot: string,
		public readonly remoteDb: string,
		public readonly pouch: PouchService,
	) {}

	get app() {
		return this.core.app;
	}
	get settings() {
		return this.core.settings;
	}
	get logger() {
		return this.core.logger;
	}
	get guard() {
		return this.core.guard;
	}

	// --- 경로 매핑 (기술문서 §9) ---

	/** DB path → 로컬 vault 경로(정규화). */
	toLocalPath(dbPath: string): string {
		return obsidianNormalize(dbPathToLocal(this.localRoot, dbPath));
	}

	/** 로컬 vault 경로 → DB path. localRoot 밖이면 null(§9.4). */
	toDbPath(localPath: string): string | null {
		return localPathToDb(this.localRoot, localPath);
	}

	isMarkdown(path: string): boolean {
		return path.toLowerCase().endsWith(".md");
	}

	/** excludeFolders 또는 보관 폴더 아래 경로인지(로컬 경로 기준). 보관 폴더는 note로 동기화하지 않는다. */
	isExcluded(localPath: string): boolean {
		const p = normalizePath(localPath);
		const archiveRoot = normalizePath(dbPathToLocal(this.localRoot, this.settings.archiveFolder));
		if (archiveRoot !== "" && (p === archiveRoot || p.startsWith(archiveRoot + "/"))) return true;
		return this.settings.excludeFolders.some((f) => {
			const folder = normalizePath(f);
			return folder !== "" && (p === folder || p.startsWith(folder + "/"));
		});
	}

	// --- 로컬 changes 체크포인트 (settings에 영속) ---

	getLastSeq(): string | undefined {
		return this.settings.lastSeqByDb[this.remoteDb];
	}
	setLastSeq(seq: string): void {
		this.settings.lastSeqByDb[this.remoteDb] = seq;
		this.core.requestPersist();
	}

	// --- 업로드 대기 중인 로컬 경로 (적용 레이스 방지) ---
	// 사용자가 방금 편집해 업로드 대기 중인 파일은 원격 적용으로 덮지 않는다.
	private pending = new Set<string>();

	markPending(dbPath: string): void {
		this.pending.add(dbPath);
	}
	clearPending(dbPath: string): void {
		this.pending.delete(dbPath);
	}
	isPending(dbPath: string): boolean {
		return this.pending.has(dbPath);
	}

	// --- 구조적 변경(이동/삭제) echo 차단 ---
	// applier가 archive(파일 이동)/삭제할 때 발생하는 rename/delete 이벤트를 무시하기 위한 경로 표식.
	// 해시 기반 guard로는 삭제/이동을 못 거르므로 경로 기반 표식을 따로 둔다.
	private suppressed = new Map<string, ReturnType<typeof setTimeout>>();

	suppressStructural(localPath: string, ms = 5000): void {
		const prev = this.suppressed.get(localPath);
		if (prev) clearTimeout(prev);
		this.suppressed.set(
			localPath,
			setTimeout(() => this.suppressed.delete(localPath), ms),
		);
	}
	isStructuralSuppressed(localPath: string): boolean {
		return this.suppressed.has(localPath);
	}

	/** archive 대상 경로: localRoot/<archiveFolder>/<dbPath>. 기술문서 §10.4 / §15.1. */
	archiveLocalPath(dbPath: string): string {
		return obsidianNormalize(dbPathToLocal(this.localRoot, `${this.settings.archiveFolder}/${dbPath}`));
	}

	/**
	 * 보관 폴더 안의 로컬 경로 → 원래 dbPath(역매핑). 보관 폴더 밖이면 null.
	 * 사용자가 보관 폴더에서 파일을 지우면 해당 dbPath의 DB 문서를 purge하기 위함.
	 */
	archiveDbPath(localPath: string): string | null {
		const root = normalizePath(dbPathToLocal(this.localRoot, this.settings.archiveFolder));
		const p = normalizePath(localPath);
		if (p === root) return null;
		if (p.startsWith(root + "/")) return p.slice(root.length + 1);
		return null;
	}

	/** 파일 이동(이름변경). 부모 폴더 보장 후 vault.rename. */
	async renameVaultFile(file: TFile, toLocalPath: string): Promise<void> {
		await this.ensureFolderFor(toLocalPath);
		await this.app.fileManager.renameFile(file, toLocalPath);
	}

	async deleteVaultFile(file: TFile): Promise<void> {
		await this.app.vault.trash(file, false); // 시스템 휴지통이 아닌 vault 내 .trash
	}

	getFile(localPath: string): TFile | null {
		const f = this.app.vault.getAbstractFileByPath(localPath);
		return f instanceof TFile ? f : null;
	}

	fileExists(localPath: string): boolean {
		return this.app.vault.getAbstractFileByPath(localPath) != null;
	}

	private async ensureFolderFor(localPath: string): Promise<void> {
		await this.ensureParentFolder(localPath);
	}

	// --- vault 입출력 ---

	async readVaultFile(localPath: string): Promise<string | null> {
		const file = this.app.vault.getAbstractFileByPath(localPath);
		if (file instanceof TFile) return await this.app.vault.read(file);
		return null;
	}

	async writeVaultFile(localPath: string, content: string): Promise<void> {
		await this.ensureParentFolder(localPath);
		const existing = this.app.vault.getAbstractFileByPath(localPath);
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, content);
		} else {
			await this.app.vault.create(localPath, content);
		}
	}

	private async ensureParentFolder(localPath: string): Promise<void> {
		const idx = localPath.lastIndexOf("/");
		if (idx <= 0) return;
		const folder = localPath.slice(0, idx);
		if (!this.app.vault.getAbstractFileByPath(folder)) {
			await this.app.vault.createFolder(folder).catch(() => {
				/* 이미 존재 등 무시 */
			});
		}
	}

	// --- 문서 빌드 ---

	/** 로컬 내용으로 NoteDoc 빌드(업로드용). 기술문서 §8.1. */
	async buildNoteDoc(dbPath: string, content: string, prevVersion = 0): Promise<NoteDoc> {
		const s = this.settings;
		const now = Date.now();
		return {
			_id: `note:${dbPath}`,
			type: "note",
			schemaVersion: 1,
			classId: s.classId,
			studentId: this.studentId,
			path: dbPath,
			content,
			contentHash: await sha256(content),
			mtime: now,
			deleted: false,
			version: prevVersion + 1,
			lastModifiedBy: s.userId,
			lastModifiedRole: s.role,
			lastModifiedDeviceId: s.deviceId,
			updatedAt: new Date(now).toISOString(),
		};
	}

	/** DB path 유효성(§9.1). */
	isValidDbPath(dbPath: string): boolean {
		return validateVaultPath(dbPath);
	}
}
