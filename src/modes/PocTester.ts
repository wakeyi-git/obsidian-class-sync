import { normalizePath as obsidianNormalize, TFile } from "obsidian";
import { CoreServices } from "../core/CoreServices";
import { PouchService, LiveHandle, SyncHandle } from "../core/couch/PouchService";
import { NoteDoc, noteId } from "../core/model/types";
import { sha256 } from "../core/hash/hash";
import { dbPathToLocal, validateVaultPath } from "../core/path/path";

/**
 * Phase 0 POC 검증 루틴 모음. 기술문서 §24.1이 요구하는 각 메커니즘을
 * 수동 트리거(명령)로 실행하고 결과를 로그에 남긴다.
 * Student/Teacher 두 mode가 공유하며, 동작 차이는 localRoot/role 라벨뿐이다.
 */
export class PocTester {
	private pouch: PouchService | null = null;
	private changesHandle: LiveHandle | null = null;
	private syncHandle: SyncHandle | null = null;

	constructor(private core: CoreServices) {}

	private get log() {
		return this.core.logger;
	}

	private get settings() {
		return this.core.settings;
	}

	/** 현재 설정으로 PouchService를 (재)생성. */
	private ensurePouch(): PouchService {
		if (!this.pouch) this.pouch = this.core.createPouch();
		return this.pouch;
	}

	/** 설정 변경 시 기존 연결을 버리고 다음 사용 때 새로 만들도록. */
	async resetPouch(): Promise<void> {
		this.stopChanges();
		this.stopSync();
		if (this.pouch) {
			await this.pouch.close();
			this.pouch = null;
		}
	}

	// 1) 연결/권한 테스트 -------------------------------------------------
	async testConnection(): Promise<void> {
		const s = this.settings;
		if (!s.couchdbUrl) {
			this.log.warn("CouchDB URL이 비어 있습니다. 설정을 먼저 입력하세요.", true);
			return;
		}
		this.log.info(`연결 테스트: ${s.couchdbUrl} / ${s.remoteDb}`);
		const pouch = this.ensurePouch();

		// HTTP 상태를 신뢰의 기준으로 삼는다 (PouchDB info()는 401에도 관대해 거짓 성공을 낼 수 있음).
		let raw: { status: number; length: number; snippet: string };
		try {
			raw = await pouch.rawInfo();
		} catch (e) {
			this.log.error(`연결 실패: 서버 도달 불가 — ${describe(e)}`, true);
			return;
		}

		if (raw.status === 401 || raw.status === 403) {
			this.log.error(`연결 실패: 인증 오류 (HTTP ${raw.status}). 아이디/비밀번호를 확인하세요. — ${raw.snippet}`, true);
			return;
		}
		if (raw.status >= 400) {
			this.log.error(`연결 실패: HTTP ${raw.status} — ${raw.snippet}`, true);
			return;
		}

		const res = await pouch.ping();
		if (res.ok) {
			this.log.ok(
				`연결 성공: ${s.remoteDb} (docs=${res.info?.doc_count ?? "?"}, update_seq=${res.info?.update_seq ?? "?"})`,
				true,
			);
		} else {
			this.log.error(`연결 실패: ${res.error}`, true);
		}
	}

	// 2) 문서 put/get 왕복 테스트 ----------------------------------------
	async testPutGet(): Promise<void> {
		const dbPath = "poc-test.md";
		const content = `# POC 테스트\n작성: ${new Date().toISOString()}\nrole=${this.settings.role}`;
		const doc = await this.buildNoteDoc(dbPath, content);
		this.log.info(`put 시도: ${doc._id}`);
		try {
			const pouch = this.ensurePouch();
			const saved = await pouch.put(doc);
			this.log.ok(`put 성공: ${saved._id} (_rev=${saved._rev})`);
			const got = await pouch.get<NoteDoc>(doc._id);
			if (got && got.contentHash === doc.contentHash) {
				this.log.ok(`get 왕복 확인 성공: contentHash 일치`, true);
			} else {
				this.log.error(`get 왕복 불일치: ${got ? "hash 다름" : "문서 없음"}`, true);
			}
		} catch (e) {
			this.log.error(`put/get 실패: ${describe(e)}`, true);
		}
	}

	// 3) changes feed 구독 ------------------------------------------------
	startChanges(): void {
		if (this.changesHandle) {
			this.log.warn("changes feed가 이미 구독 중입니다.");
			return;
		}
		this.log.info(`changes feed 구독 시작: ${this.settings.remoteDb} (since=now)`);
		this.changesHandle = this.ensurePouch().changes<NoteDoc>(
			(change) => {
				const by = change.doc?.lastModifiedDeviceId ?? "?";
				const mine = by === this.settings.deviceId ? " (내 기기 변경)" : "";
				this.log.ok(`change 수신: ${change.id} deleted=${change.deleted} by=${by}${mine}`);
			},
			{
				since: "now",
				onError: (e) => this.log.error(`changes 오류: ${e.message}`),
			},
		);
		this.log.ok("changes feed 구독 중. Fauxton 등에서 문서를 수정해 보세요.", true);
	}

	stopChanges(): void {
		if (this.changesHandle) {
			this.changesHandle.cancel();
			this.changesHandle = null;
			this.log.info("changes feed 구독 중지.");
		}
	}

	// 4) vault 파일 쓰기/읽기 --------------------------------------------
	async testFileRW(): Promise<void> {
		const dbPath = "poc-file.md";
		const localPath = this.localPathFor(dbPath);
		const content = `POC 파일 쓰기 테스트\n${new Date().toISOString()}`;
		try {
			await this.writeVaultFile(localPath, content);
			this.log.ok(`vault 파일 쓰기 성공: ${localPath}`);
			const readBack = await this.readVaultFile(localPath);
			if (readBack === content) this.log.ok("vault 파일 읽기 왕복 확인 성공.", true);
			else this.log.error("vault 파일 읽기 내용 불일치.", true);
		} catch (e) {
			this.log.error(`vault 파일 r/w 실패: ${describe(e)}`, true);
		}
	}

	// 5) 원격 → 로컬 적용 + Remote Apply Guard 검증 -----------------------
	async testRemoteApplyWithGuard(): Promise<void> {
		const dbPath = "poc-guard.md";
		const localPath = this.localPathFor(dbPath);
		const content = `원격에서 내려온 내용\n${new Date().toISOString()}`;
		const hash = await sha256(content);

		this.log.info("원격 적용 시뮬레이션 시작 (guard 등록 후 vault에 쓰기).");
		// 기술문서 §16.2: 원격 반영 직전 guard.mark → vault.modify → releaseAfterDelay
		this.core.guard.mark(localPath, hash);
		try {
			await this.writeVaultFile(localPath, content);
			this.core.guard.releaseAfterDelay(localPath);
			this.log.ok(`원격→로컬 적용 완료: ${localPath}`);

			// 이 파일에 대한 modify 이벤트가 LocalWatcher로 들어왔다고 가정하고 guard 확인
			const ignored = this.core.guard.shouldIgnore(localPath, hash);
			if (ignored) {
				this.log.ok("guard 동작 확인: 이 변경은 무시됨 → 재업로드 안 함 (루프 차단). ", true);
			} else {
				this.log.error("guard 미동작: 변경이 무시되지 않음 (루프 위험).", true);
			}
		} catch (e) {
			this.log.error(`원격 적용/guard 테스트 실패: ${describe(e)}`, true);
		}
	}

	// 6) 로컬 ↔ 원격 PouchDB replication --------------------------------
	startSync(): void {
		if (this.syncHandle) {
			this.log.warn("sync가 이미 실행 중입니다.");
			return;
		}
		const localName = `local_${this.settings.remoteDb}`;
		this.log.info(`로컬↔원격 sync 시작: ${localName} ⇄ ${this.settings.remoteDb}`);
		this.syncHandle = this.ensurePouch().startSync(localName, {
			onChange: (info) => this.log.ok(`sync change: direction=${info.direction} docs=${info.change?.docs?.length ?? 0}`),
			onPaused: () => this.log.info("sync 일시중지(동기화 따라잡음)."),
			onError: (e) => this.log.error(`sync 오류: ${e.message}`),
		});
		this.log.ok("PouchDB live replication 실행 중.", true);
	}

	stopSync(): void {
		if (this.syncHandle) {
			this.syncHandle.cancel();
			this.syncHandle = null;
			this.log.info("sync 중지.");
		}
	}

	async dispose(): Promise<void> {
		await this.resetPouch();
	}

	// --- 내부 헬퍼 -------------------------------------------------------

	private async buildNoteDoc(dbPath: string, content: string): Promise<NoteDoc> {
		const s = this.settings;
		const now = Date.now();
		return {
			_id: noteId(dbPath),
			type: "note",
			schemaVersion: 1,
			classId: s.classId,
			studentId: s.userId,
			path: dbPath,
			content,
			contentHash: await sha256(content),
			mtime: now,
			deleted: false,
			version: 1,
			lastModifiedBy: s.userId,
			lastModifiedRole: s.role,
			lastModifiedDeviceId: s.deviceId,
			updatedAt: new Date(now).toISOString(),
		};
	}

	private localPathFor(dbPath: string): string {
		if (!validateVaultPath(dbPath)) throw new Error(`잘못된 DB path: ${dbPath}`);
		return obsidianNormalize(dbPathToLocal(this.settings.localRoot, dbPath));
	}

	private async writeVaultFile(path: string, content: string): Promise<void> {
		const vault = this.core.app.vault;
		await this.ensureParentFolder(path);
		const existing = vault.getAbstractFileByPath(path);
		if (existing instanceof TFile) {
			await vault.modify(existing, content);
		} else {
			await vault.create(path, content);
		}
	}

	private async readVaultFile(path: string): Promise<string | null> {
		const file = this.core.app.vault.getAbstractFileByPath(path);
		if (file instanceof TFile) return await this.core.app.vault.read(file);
		return null;
	}

	private async ensureParentFolder(path: string): Promise<void> {
		const idx = path.lastIndexOf("/");
		if (idx <= 0) return;
		const folder = path.slice(0, idx);
		if (!this.core.app.vault.getAbstractFileByPath(folder)) {
			await this.core.app.vault.createFolder(folder).catch(() => {
				/* 이미 존재 등은 무시 */
			});
		}
	}
}

function describe(e: unknown): string {
	if (e instanceof Error) return e.message;
	if (e && typeof e === "object") {
		const o = e as Record<string, unknown>;
		const parts = [o.status, o.name, o.message ?? o.reason ?? o.error].filter(Boolean);
		if (parts.length) return parts.join(" ");
		try {
			return JSON.stringify(o);
		} catch {
			return String(e);
		}
	}
	return String(e);
}
