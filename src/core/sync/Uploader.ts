import { MirrorContext } from "./MirrorContext";
import { NoteDoc, noteId } from "../model/types";
import { sha256 } from "../hash/hash";

export type UploadResult = "uploaded" | "skipped-same" | "skipped-outside" | "skipped-excluded" | "skipped-nonmd" | "skipped-missing";

/**
 * 로컬 vault 파일 → 로컬 PouchDB upsert. 기술문서 §11.2 / §18.2.
 *
 * 로컬 DB에 쓰면 live replication이 원격으로 전파한다(오프라인이면 큐에 쌓였다 재연결 시 전파).
 * 동일 contentHash면 생략(§18.2). 업로드 문서는 lastModifiedDeviceId=내 deviceId라,
 * 로컬 changes로 되돌아와도 Applier가 무시한다(루프 차단).
 * LocalWatcher와 FullSync(up)가 공유한다.
 */
export class Uploader {
	constructor(private ctx: MirrorContext) {}

	async uploadPath(localPath: string): Promise<UploadResult> {
		const ctx = this.ctx;

		if (!ctx.isMarkdown(localPath)) return "skipped-nonmd";
		if (ctx.isExcluded(localPath)) return "skipped-excluded";

		const dbPath = ctx.toDbPath(localPath);
		if (dbPath == null || !ctx.isValidDbPath(dbPath)) return "skipped-outside";

		const content = await ctx.readVaultFile(localPath);
		if (content == null) return "skipped-missing";

		const newHash = await sha256(content);

		// 로컬 DB 현재 문서와 동일하면 생략 (§18.2).
		// 단, 기존이 tombstone(deleted)이면 같은 해시여도 부활(업로드)시킨다.
		const existing = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
		if (existing && !existing.deleted && existing.contentHash === newHash) return "skipped-same";

		const doc = await ctx.buildNoteDoc(dbPath, content, existing?.version ?? 0);
		await ctx.pouch.put(doc);
		ctx.logger.ok(`로컬→원격 업로드: ${dbPath}`);
		return "uploaded";
	}

	/**
	 * 파일 삭제/이름변경 시 옛 경로를 tombstone 처리(기술문서 §8.3 / §10.3).
	 * 내용은 보존(복구 가능), deleted=true로 표시해 상대 vault가 정책대로 처리하게 한다.
	 */
	async tombstonePath(dbPath: string): Promise<"tombstoned" | "skipped"> {
		const ctx = this.ctx;
		const s = ctx.settings;
		const existing = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
		if (!existing || existing.deleted) return "skipped"; // 없거나 이미 tombstone

		const now = Date.now();
		const doc: NoteDoc = {
			...existing,
			deleted: true,
			deletedAt: new Date(now).toISOString(),
			deletedBy: s.userId,
			deletedByRole: s.role,
			deleteMode: s.deletePolicy,
			version: (existing.version ?? 0) + 1,
			mtime: now,
			lastModifiedBy: s.userId,
			lastModifiedRole: s.role,
			lastModifiedDeviceId: s.deviceId,
			updatedAt: new Date(now).toISOString(),
		};
		await ctx.pouch.put(doc);
		ctx.logger.ok(`tombstone(삭제 표시): ${dbPath}`);
		return "tombstoned";
	}

	/**
	 * DB 문서 영구 제거(purge). 사용자가 .deleted/에서 파일을 지웠을 때 호출.
	 * PouchDB hard-remove → replication이 원격·타 클라이언트의 문서까지 제거한다.
	 */
	async purgePath(dbPath: string): Promise<"purged" | "skipped"> {
		const ctx = this.ctx;
		const existing = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
		if (!existing || !existing._rev) return "skipped";
		await ctx.pouch.removeRev(noteId(dbPath), existing._rev);
		ctx.logger.ok(`DB에서 영구 삭제(purge): ${dbPath}`);
		return "purged";
	}
}
