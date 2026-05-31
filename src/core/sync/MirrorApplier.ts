import { MirrorContext } from "./MirrorContext";
import { ConflictManager } from "./ConflictManager";
import { NoteDoc } from "../model/types";
import { sha256 } from "../hash/hash";

export type ApplyResult =
	| "applied"
	| "deleted"
	| "skipped-self"
	| "skipped-same"
	| "skipped-deleted"
	| "skipped-nonmd"
	| "skipped-pending"
	| "conflict";

/** _conflicts를 포함한 로컬 문서. */
type DocWithConflicts = NoteDoc & { _conflicts?: string[] };

/**
 * 로컬 PouchDB 문서 → 로컬 vault 적용. 기술문서 §11.4 / §16.2 / §14.
 *
 * 충돌 판정은 PouchDB의 _conflicts(리비전 충돌)를 신뢰의 기준으로 삼는다.
 * - 깨끗한(충돌 없는) 원격 갱신 → vault에 적용
 * - _conflicts 존재(양쪽이 분기 편집) → preserve-local: vault를 덮지 않고 보류·경고 (정식 해소는 Phase 3)
 * - 내 기기가 만든 내용이거나 업로드 대기 중인 로컬 편집 → 덮지 않음
 */
export class MirrorApplier {
	private loggedConflicts = new Set<string>();

	constructor(
		private ctx: MirrorContext,
		private conflicts: ConflictManager,
	) {}

	async applyDoc(doc: DocWithConflicts): Promise<ApplyResult> {
		const ctx = this.ctx;

		if (!ctx.isMarkdown(doc.path) || !ctx.isValidDbPath(doc.path)) return "skipped-nonmd";

		// 삭제(tombstone) 처리. 기술문서 §10.4 / §15.
		if (doc.deleted) return await this.applyDeletion(doc);

		// 업로드 대기 중인 로컬 편집이면 덮지 않음(레이스 방지) — 업로드가 곧 정합한다.
		if (ctx.isPending(doc.path)) return "skipped-pending";

		const localPath = ctx.toLocalPath(doc.path);
		const local = await ctx.readVaultFile(localPath);
		const localHash = local == null ? null : await sha256(local);

		// 이미 동일 내용 (충돌이 해소되어 양쪽이 같아졌을 수 있으니 남은 원격본 정리)
		if (localHash === doc.contentHash) {
			await this.conflicts.cleanupCopy(doc.path);
			return "skipped-same";
		}

		const hasConflict = !!doc._conflicts && doc._conflicts.length > 0;
		if (hasConflict) {
			// 양쪽이 서로 다르게 편집 → 로컬 유지(preserve-local) + 원격본을 _충돌/에 꺼내 둠
			await this.conflicts.materialize(doc);
			if (!this.loggedConflicts.has(doc.path)) {
				this.loggedConflicts.add(doc.path);
				ctx.logger.warn(
					`충돌 보류(preserve-local): ${localPath} — 양쪽 분기 편집. 로컬 유지, 원격본을 _충돌/에 저장. '충돌 목록'에서 해소하세요.`,
					true,
				);
			}
			return "conflict";
		}

		// 내 기기가 만든 내용인데 vault가 다르면, vault에 더 최신 로컬 편집이 있는 것 → 덮지 않음
		if (doc.lastModifiedDeviceId === ctx.settings.deviceId) {
			return "skipped-self";
		}

		// 충돌이 있던 경로인데 로컬이 원격과 다르면, 상대가 해소해 내 편집이 곧 덮일 차례.
		// 흔적 없이 잃지 않도록 내 버전을 먼저 보존한다. (데이터 손실 방지)
		if (local != null && this.conflicts.hadConflict(doc.path)) {
			await this.conflicts.preserveLocal(doc.path, local);
			ctx.logger.warn(
				`상대가 충돌을 해소함 — 내 편집이 덮어써집니다. 내 버전을 '${ctx.localBackupPath(doc.path)}'에 보관했습니다.`,
				true,
			);
		}

		// 충돌 없는 원격 갱신 → 적용 (guard로 에코 차단)
		this.loggedConflicts.delete(doc.path);
		await this.conflicts.cleanupCopy(doc.path); // 해소 전파로 들어온 갱신이면 남은 원격본 정리
		ctx.guard.mark(localPath, doc.contentHash);
		await ctx.writeVaultFile(localPath, doc.content);
		ctx.guard.releaseAfterDelay(localPath);
		ctx.status.lastDownloadAt = Date.now();
		ctx.logger.ok(`원격→로컬 적용: ${localPath}`);
		return "applied";
	}

	/**
	 * purge 전파: DB 문서가 영구 제거되면 이쪽 vault의 아카이브 사본(.deleted/<path>)도 정리.
	 * 사용자가 한쪽 .deleted/에서 지우면 다른 쪽 .deleted/ 사본도 따라 정리된다.
	 */
	async applyPurge(id: string): Promise<void> {
		const ctx = this.ctx;
		if (!id.startsWith("note:")) return;
		const dbPath = id.slice("note:".length);
		const archivePath = ctx.archiveLocalPath(dbPath);
		const file = ctx.getFile(archivePath);
		if (!file) return;
		ctx.suppressStructural(archivePath);
		await ctx.deleteVaultFile(file);
		ctx.logger.info(`purge 전파: 아카이브 정리 ${archivePath}`);
	}

	/** tombstone 적용: 정책(archive/propagate-delete/ignore-delete)대로 로컬 파일 처리. */
	private async applyDeletion(doc: DocWithConflicts): Promise<ApplyResult> {
		const ctx = this.ctx;

		// 내가 만든 tombstone의 에코 → 무시 (내 vault는 이미 처리됨)
		if (doc.lastModifiedDeviceId === ctx.settings.deviceId) return "skipped-self";

		// 삭제한 쪽의 의도(deleteMode)를 따른다. 없으면 내 설정.
		const policy = doc.deleteMode ?? ctx.settings.deletePolicy;
		if (policy === "ignore-delete") return "skipped-deleted";

		const localPath = ctx.toLocalPath(doc.path);
		const file = ctx.getFile(localPath);
		if (!file) return "skipped-deleted"; // 이미 없음

		// 구조적 변경 echo 차단: 이 경로의 rename/delete 이벤트를 잠시 무시
		ctx.suppressStructural(localPath);

		if (policy === "propagate-delete") {
			await ctx.deleteVaultFile(file);
			ctx.logger.ok(`원격 삭제 반영(완전 삭제): ${localPath}`);
			return "deleted";
		}

		// archive: localRoot/.deleted/ 아래로 이동 (기술문서 §15.1)
		let archivePath = ctx.archiveLocalPath(doc.path);
		if (ctx.fileExists(archivePath)) archivePath = `${archivePath}.${Date.now()}`;
		ctx.suppressStructural(archivePath);
		await ctx.renameVaultFile(file, archivePath);
		ctx.logger.ok(`원격 삭제 반영(.deleted 보관): ${localPath} → ${archivePath}`);
		return "deleted";
	}
}
