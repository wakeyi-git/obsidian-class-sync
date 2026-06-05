import { MirrorContext } from "./MirrorContext";
import { NoteDoc, AssetDoc, noteId, assetId } from "../model/types";
import { sha256 } from "../hash/hash";
import { recordPurge, abToB64, PURGE_ASSET_CAP, PurgeSnapshot } from "./recentPurge";
import { t } from "../../i18n";

export type UploadResult =
	| "uploaded"
	| "skipped-same"
	| "skipped-outside"
	| "skipped-excluded"
	| "skipped-asset-off"
	| "skipped-toolarge"
	| "skipped-missing";

/**
 * 로컬 vault 파일 → 로컬 PouchDB upsert. 기술문서 §11.2 / §18.2 / §8.2.
 *
 * markdown은 note 문서, 그 외 파일은 asset 문서(+PouchDB attachment)로 올린다.
 * 동일 contentHash면 생략(§18.2). lastModifiedDeviceId=내 deviceId라 에코는 Applier가 무시.
 */
export class Uploader {
	constructor(private ctx: MirrorContext) {}

	async uploadPath(localPath: string): Promise<UploadResult> {
		const ctx = this.ctx;
		if (ctx.isExcluded(localPath)) return "skipped-excluded";
		const dbPath = ctx.toDbPath(localPath);
		if (dbPath == null || !ctx.isValidDbPath(dbPath)) return "skipped-outside";

		return ctx.isMarkdown(localPath) ? this.uploadNote(localPath, dbPath) : this.uploadAsset(localPath, dbPath);
	}

	/**
	 * vault 파일 대신 주어진 내용으로 note 업로드(실시간 스냅샷용). 경로 매핑/제외/해시 dedupe는 동일.
	 * 열린 에디터를 건드리지 않고 로컬 DB에만 기록 → replication이 원격 전파.
	 */
	async uploadContent(localPath: string, content: string): Promise<UploadResult> {
		const ctx = this.ctx;
		if (ctx.isExcluded(localPath)) return "skipped-excluded";
		const dbPath = ctx.toDbPath(localPath);
		if (dbPath == null || !ctx.isValidDbPath(dbPath)) return "skipped-outside";
		if (!ctx.isMarkdown(localPath)) return "skipped-outside";

		const newHash = await sha256(content);
		const existing = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
		if (existing && !existing.deleted && existing.contentHash === newHash) return "skipped-same";

		const doc = await ctx.buildNoteDoc(dbPath, content, existing?.version ?? 0);
		await ctx.pouch.put(doc);
		this.markUploaded(dbPath);
		return "uploaded";
	}

	private async uploadNote(localPath: string, dbPath: string): Promise<UploadResult> {
		const ctx = this.ctx;
		const content = await ctx.readVaultFile(localPath);
		if (content == null) return "skipped-missing";
		const newHash = await sha256(content);

		// 동일하면 생략. 단 tombstone이면 같은 해시여도 부활.
		const existing = await ctx.pouch.get<NoteDoc>(noteId(dbPath));
		if (existing && !existing.deleted && existing.contentHash === newHash) return "skipped-same";

		const doc = await ctx.buildNoteDoc(dbPath, content, existing?.version ?? 0);
		await ctx.pouch.put(doc);
		await ctx.versions.snapshot(dbPath, content, "modify", doc.version); // 버전 히스토리(편집 시점)
		this.markUploaded(dbPath);
		return "uploaded";
	}

	private async uploadAsset(localPath: string, dbPath: string): Promise<UploadResult> {
		const ctx = this.ctx;
		if (!ctx.settings.syncAssets) return "skipped-asset-off";

		const maxBytes = (ctx.settings.maxAttachmentMB || 0) * 1024 * 1024;

		// 큰 파일을 메모리에 읽기 전에 stat.size로 먼저 한도 초과를 판정(모바일 메모리 보호, §24.6).
		if (maxBytes > 0) {
			const size = ctx.getFile(localPath)?.stat.size;
			if (size != null && size > maxBytes) {
				ctx.logger.warn(
					t("첨부 크기 초과로 생략: {path} ({size}MB)", { path: dbPath, size: (size / 1024 / 1024).toFixed(1) }),
				);
				return "skipped-toolarge";
			}
		}

		const data = await ctx.readVaultBinary(localPath);
		if (data == null) return "skipped-missing";

		if (maxBytes > 0 && data.byteLength > maxBytes) {
			ctx.logger.warn(
				t("첨부 크기 초과로 생략: {path} ({size}MB)", {
					path: dbPath,
					size: (data.byteLength / 1024 / 1024).toFixed(1),
				}),
			);
			return "skipped-toolarge";
		}

		const newHash = await sha256(data);
		const existing = await ctx.pouch.get<AssetDoc>(assetId(dbPath));
		if (existing && !existing.deleted && existing.contentHash === newHash) return "skipped-same";

		const doc = await ctx.buildAssetDoc(dbPath, data, existing?.version ?? 0);
		await ctx.pouch.putAsset(doc, data);
		this.markUploaded(dbPath);
		return "uploaded";
	}

	private markUploaded(dbPath: string): void {
		this.ctx.status.lastUploadAt = Date.now();
		this.ctx.status.lastError = undefined;
		this.ctx.logger.ok(t("로컬→원격 업로드: {path}", { path: dbPath }));
	}

	/** 삭제/이름변경 시 옛 경로를 tombstone 처리(note/asset 공통). 기술문서 §8.3 / §10.3. */
	async tombstonePath(dbPath: string): Promise<"tombstoned" | "skipped"> {
		const ctx = this.ctx;
		const s = ctx.settings;
		const id = ctx.isMarkdown(dbPath) ? noteId(dbPath) : assetId(dbPath);
		const existing = await ctx.pouch.get<NoteDoc | AssetDoc>(id);
		if (!existing || existing.deleted) return "skipped";

		// 삭제 직전 내용을 버전 히스토리에 보존(마크다운).
		if (ctx.isMarkdown(dbPath) && (existing as NoteDoc).content != null) {
			await ctx.versions.snapshot(dbPath, (existing as NoteDoc).content, "delete", existing.version ?? 0);
		}

		const now = Date.now();
		const doc: any = {
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
		delete doc._attachments; // tombstone은 바이너리 불필요
		await ctx.pouch.put(doc);
		ctx.logger.ok(t("tombstone(삭제 표시): {path}", { path: dbPath }));
		return "tombstoned";
	}

	/** DB 문서 영구 제거(purge, note/asset 공통). .deleted/에서 지웠을 때. */
	async purgePath(dbPath: string): Promise<"purged" | "skipped"> {
		const ctx = this.ctx;
		const id = ctx.isMarkdown(dbPath) ? noteId(dbPath) : assetId(dbPath);
		const existing = await ctx.pouch.get<NoteDoc | AssetDoc>(id);
		if (!existing || !existing._rev) return "skipped";
		await this.snapshotBeforePurge(dbPath, existing); // '최근 영구 삭제' 되돌리기용
		await ctx.pouch.removeRev(id, existing._rev);
		ctx.logger.ok(t("DB에서 영구 삭제(purge): {path}", { path: dbPath }));
		return "purged";
	}

	/** purge 직전 스냅샷을 capped 목록에 기록. 노트는 content(tombstone에 보존됨)로, 첨부는 cap 이하 바이너리만. */
	private async snapshotBeforePurge(dbPath: string, existing: NoteDoc | AssetDoc): Promise<void> {
		const ctx = this.ctx;
		const base = {
			id: `${dbPath}@${existing._rev}`,
			dbPath,
			purgedAt: Date.now(),
			purgedBy: ctx.settings.userId,
		};
		let snap: PurgeSnapshot;
		if (ctx.isMarkdown(dbPath)) {
			const content = (existing as NoteDoc).content;
			snap = { ...base, kind: "note", content, recoverable: content != null };
		} else {
			const bin = await ctx.pouch.getAssetBinary(assetId(dbPath)).catch(() => null);
			const ok = bin != null && bin.byteLength <= PURGE_ASSET_CAP;
			snap = {
				...base,
				kind: "asset",
				mime: (existing as AssetDoc).mime,
				binaryB64: ok ? abToB64(bin as ArrayBuffer) : undefined,
				recoverable: ok,
			};
		}
		try {
			await recordPurge(ctx.pouch, snap);
		} catch {
			/* 스냅샷 기록 실패는 purge를 막지 않는다 */
		}
	}
}
