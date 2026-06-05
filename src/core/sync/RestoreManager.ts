import { MirrorContext } from "./MirrorContext";
import { Uploader } from "./Uploader";
import { NoteDoc, AssetDoc, noteId, assetId } from "../model/types";
import { isRecoverable, restoreTargetPath, RestoreCollision } from "./restoreAction";
import { t } from "../../i18n";

/**
 * 삭제 파일 복구. 보고서 §2 P1.
 *
 * tombstone(deleted=true) 문서를 사용자가 다시 살릴 수 있게 한다.
 * - 노트: tombstone이 content를 보존하므로 DB에서 바로 복구.
 * - 첨부: tombstone은 바이너리가 없으므로 archive(_삭제됨/) vault 사본이 있을 때만 복구.
 */
export interface DeletedItem {
	kind: "note" | "asset";
	dbPath: string;
	localPath: string; // 원래 위치(현재 localRoot 기준)
	deletedAt?: string;
	deletedBy?: string;
	deletedByRole?: string;
	remoteDb: string;
	studentId: string;
	studentName: string;
	recoverable: boolean;
}

export type RestoreResult = "restored" | "skipped-exists" | "unrecoverable" | "not-deleted";

export interface RestoreOptions {
	collision?: RestoreCollision; // 원래 위치에 파일이 있을 때 처리(기본 keep-both)
	toLocalPath?: string; // "다른 이름으로 복구" — 명시 경로(충돌 정책 무시)
}

export class RestoreManager {
	constructor(
		private ctx: MirrorContext,
		private uploader: Uploader,
	) {}

	/** 이 링크의 삭제된(tombstone) 파일 목록. */
	async listDeleted(): Promise<DeletedItem[]> {
		const ctx = this.ctx;
		const out: DeletedItem[] = [];
		for (const d of await ctx.pouch.allNotes()) {
			if (!d.deleted) continue;
			out.push(this.toItem("note", d, isRecoverable("note", { hasContent: !!d.content, hasArchiveCopy: false })));
		}
		if (ctx.settings.syncAssets) {
			for (const d of await ctx.pouch.allAssets()) {
				if (!d.deleted) continue;
				const hasArchiveCopy = ctx.fileExists(ctx.archiveLocalPath(d.path));
				out.push(this.toItem("asset", d, isRecoverable("asset", { hasContent: false, hasArchiveCopy })));
			}
		}
		return out;
	}

	private toItem(kind: "note" | "asset", doc: NoteDoc | AssetDoc, recoverable: boolean): DeletedItem {
		const ctx = this.ctx;
		return {
			kind,
			dbPath: doc.path,
			localPath: ctx.toLocalPath(doc.path),
			deletedAt: doc.deletedAt,
			deletedBy: doc.deletedBy,
			deletedByRole: doc.deletedByRole,
			remoteDb: ctx.remoteDb,
			studentId: ctx.studentId,
			studentName: ctx.studentName,
			recoverable,
		};
	}

	/** 삭제된 파일을 vault + DB로 복구(deleted=false, version+1). */
	async restore(dbPath: string, opts: RestoreOptions = {}): Promise<RestoreResult> {
		const ctx = this.ctx;
		const isMd = ctx.isMarkdown(dbPath);
		const id = isMd ? noteId(dbPath) : assetId(dbPath);
		const doc = await ctx.pouch.get<NoteDoc | AssetDoc>(id);
		if (!doc || !doc.deleted) return "not-deleted";

		// 대상 경로 결정(다른 이름 지정 시 충돌 정책 무시).
		const baseLocal = ctx.toLocalPath(dbPath);
		const target = opts.toLocalPath ?? restoreTargetPath(baseLocal, ctx.fileExists(baseLocal), opts.collision ?? "keep-both");
		if (target == null) return "skipped-exists";
		const targetDb = ctx.toDbPath(target);
		if (targetDb == null) return "unrecoverable";

		if (isMd) {
			const note = doc as NoteDoc;
			if (note.content == null) return "unrecoverable";
			await this.writeAndRevive(target, targetDb, note.content);
		} else {
			// 첨부: archive 사본에서만 복구.
			const bin = await ctx.readVaultBinary(ctx.archiveLocalPath(dbPath));
			if (bin == null) return "unrecoverable";
			const prev = (await ctx.pouch.get<AssetDoc>(assetId(targetDb)))?.version ?? 0;
			ctx.guard.mark(target, (doc as AssetDoc).contentHash);
			await ctx.writeVaultBinary(target, bin);
			ctx.guard.releaseAfterDelay(target);
			await ctx.pouch.putAsset(await ctx.buildAssetDoc(targetDb, bin, prev), bin);
		}

		// 남은 archive(_삭제됨/) 사본 정리(echo는 suppress로 차단).
		const archivePath = ctx.archiveLocalPath(dbPath);
		const af = ctx.getFile(archivePath);
		if (af && archivePath !== target) {
			ctx.suppressStructural(archivePath);
			await ctx.deleteVaultFile(af);
		}

		ctx.logger.ok(t("삭제 복구: {path}", { path: target }), true);
		return "restored";
	}

	private async writeAndRevive(target: string, targetDb: string, content: string): Promise<void> {
		const ctx = this.ctx;
		const prev = (await ctx.pouch.get<NoteDoc>(noteId(targetDb)))?.version ?? 0;
		const fresh = await ctx.buildNoteDoc(targetDb, content, prev); // contentHash 계산됨
		ctx.guard.mark(target, fresh.contentHash); // vault 쓰기 echo 차단
		await ctx.writeVaultFile(target, content);
		ctx.guard.releaseAfterDelay(target);
		await ctx.pouch.put(fresh);
	}

	/** DB 문서 영구 삭제(purge). */
	purge(dbPath: string): Promise<"purged" | "skipped"> {
		return this.uploader.purgePath(dbPath);
	}
}
