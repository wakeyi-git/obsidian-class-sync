import { TFile } from "obsidian";
import { MirrorContext } from "./MirrorContext";
import { MirrorApplier } from "./MirrorApplier";
import { Uploader } from "./Uploader";
import {
	LinkManifestDoc,
	ManifestEntry,
	DocState,
	loadManifest,
	saveManifest,
	selectManifestOrphans,
	exceedsBulkThreshold,
} from "./LinkManifest";
import { NoteDoc, AssetDoc, noteId, assetId } from "../model/types";
import { exceedsAttachmentLimit } from "./attachment";
import { sha256 } from "../hash/hash";
import { t } from "../../i18n";

export type SyncDirection = "both" | "up" | "down";

/**
 * 수동/최초 전체 정합. 기술문서 §17.3.
 *
 * 로컬 PouchDB 기준으로 동작한다(원격은 replication이 맞춤).
 * up:   localRoot 아래 markdown 전체를 로컬 DB와 비교해 업로드(동일 해시 생략)
 * down: 로컬 DB note 문서 전체를 vault에 강제 재적용(평소엔 LocalApplier가 자동 처리)
 *
 * changes 체크포인트(last_seq)는 LocalApplier가 단독으로 관리하므로 여기서 건드리지 않는다.
 */
export class FullSync {
	constructor(
		private ctx: MirrorContext,
		private applier: MirrorApplier,
		private uploader: Uploader,
	) {}

	async run(direction: SyncDirection = "both"): Promise<void> {
		const ctx = this.ctx;
		ctx.logger.info(t("전체 동기화 시작 ({direction}) — {db}", { direction, db: ctx.remoteDb }));

		// 직전 동기화 종료 시점의 manifest(기준선). 삭제 정합의 "과거 존재" 근거로 쓴다.
		const baseline = await loadManifest(ctx.pouch);

		// 1) vault → 로컬 DB (업로드 방향에서만)
		if (direction === "up" || direction === "both") await this.upload();

		// 2~4) 방향별 replication + 삭제 정합.
		//   up:   reconcile(원격 미확인) → push 만
		//   down: pull 만 (로컬 변경 밀지 않음, 삭제 정합 없음)
		//   both: pull 먼저 → reconcile(최신 원격 rev 반영) → push  ← 오프라인 중 원격 수정과의 조기 tombstone 방지
		try {
			if (direction === "down") {
				const pulled = await ctx.pouch.replicatePullOnce();
				ctx.logger.info(t("원격 다운로드: ↓{pulled} 문서", { pulled }));
			} else if (direction === "up") {
				ctx.logger.info(t("‘업로드만’: 원격 최신 수정과 비교하지 않고 삭제를 정합합니다."));
				await this.reconcileDeletions(baseline);
				const pushed = await ctx.pouch.replicatePushOnce();
				ctx.logger.info(t("원격 업로드: ↑{pushed} 문서", { pushed }));
			} else {
				const pulled = await ctx.pouch.replicatePullOnce();
				await this.reconcileDeletions(baseline);
				const pushed = await ctx.pouch.replicatePushOnce();
				ctx.logger.info(t("원격 동기화: ↑{pushed} ↓{pulled} 문서", { pushed, pulled }));
			}
		} catch (e) {
			ctx.logger.error(
				t("원격 동기화 실패: {err}", { err: e instanceof Error ? e.message : String(e) }),
				true,
			);
		}

		// 5) 로컬 DB(원격 반영분 포함) → vault (다운로드 방향에서만)
		if (direction === "down" || direction === "both") await this.download();

		// 6) 정합된 현재 상태를 새 기준선으로 기록(다음 동기화의 삭제 판정 근거).
		await this.writeManifestSnapshot();

		await ctx.core.flushPersist();
		ctx.logger.ok(t("전체 동기화 완료 ({direction}).", { direction }), true);
	}

	private async download(): Promise<void> {
		const ctx = this.ctx;
		let applied = 0;
		const notes = await ctx.pouch.allNotes();
		for (const doc of notes) {
			const fresh = await ctx.pouch.getWithConflicts<typeof doc>(doc._id);
			const res = await this.applier.applyDoc(fresh ?? doc);
			if (res === "applied") applied++;
		}
		// 첨부파일
		let assetCount = 0;
		if (ctx.settings.syncAssets) {
			const assets = await ctx.pouch.allAssets();
			assetCount = assets.length;
			for (const doc of assets) {
				const res = await this.applier.applyAsset(doc as any);
				if (res === "applied") applied++;
			}
		}
		ctx.logger.info(
			t("다운로드 정합: 문서 {notes} + 첨부 {assets} 중 {applied}개 적용.", {
				notes: notes.length,
				assets: assetCount,
				applied,
			}),
		);
	}

	private async upload(): Promise<void> {
		const ctx = this.ctx;
		let uploaded = 0;
		const files = this.localFiles();
		for (const file of files) {
			const res = await this.uploader.uploadPath(file.path);
			if (res === "uploaded") uploaded++;
		}
		ctx.logger.info(
			t("업로드 정합: {files}개 파일 중 {uploaded}개 업로드.", { files: files.length, uploaded }),
		);
	}

	/**
	 * 오프라인/비활성 중 로컬에서 삭제된 파일을 manifest 기준선과 비교해 tombstone으로 보정.
	 *
	 * 안전장치: 기준선이 없거나/비었거나/localRoot가 바뀌면 비활성(이번엔 새 기준선만 기록).
	 * rev가 기준선과 다른(=다른 기기가 그 사이 수정한) 문서는 보존. 후보가 임계치를 넘으면(대량 삭제 추정)
	 * tombstone 없이 경고만 — localRoot 오설정 등 사고 방지.
	 */
	private async reconcileDeletions(baseline: LinkManifestDoc | null): Promise<void> {
		const ctx = this.ctx;
		if (!baseline || Object.keys(baseline.paths).length === 0) {
			ctx.logger.info(t("삭제 정합 생략: 기준선 manifest 없음(첫 동기화/캐시 초기화 후)."));
			return;
		}
		if (baseline.localRoot !== ctx.localRoot) {
			ctx.logger.warn(
				t("삭제 정합 생략: 폴더가 ‘{old}’→‘{now}’로 바뀌어 기준선이 무효입니다.", {
					old: baseline.localRoot || "(root)",
					now: ctx.localRoot || "(root)",
				}),
				true,
			);
			return;
		}

		const existing = new Set<string>();
		for (const f of this.localFiles()) {
			const dbPath = ctx.toDbPath(f.path);
			if (dbPath != null) existing.add(dbPath);
		}
		const current = await this.currentDbByPath();

		const orphans = selectManifestOrphans(baseline.paths, existing, current);
		if (orphans.length === 0) return;

		if (exceedsBulkThreshold(orphans.length, Object.keys(baseline.paths).length, ctx.settings.deleteReconcileMax)) {
			ctx.logger.warn(
				t("삭제 정합 중단: 사라진 파일 {found}개가 한도를 넘었습니다(폴더 오설정 방지). 의도한 삭제면 설정 ‘삭제 정합 최대 건수’를 올리세요.", {
					found: orphans.length,
				}),
				true,
			);
			return;
		}

		let tombstoned = 0;
		for (const dbPath of orphans) {
			if ((await this.uploader.tombstonePath(dbPath)) === "tombstoned") tombstoned++;
		}
		ctx.logger.info(
			t("삭제 정합: 로컬에서 사라진 {found}개 중 {tombstoned}개 tombstone 처리.", {
				found: orphans.length,
				tombstoned,
			}),
			true,
		);
	}

	/** 현재 로컬 DB에서 미삭제로 존재하는 동기화 대상 문서의 dbPath→{rev,hash}. (제외 폴더는 뺀다.) */
	private async currentDbByPath(): Promise<Map<string, DocState>> {
		const ctx = this.ctx;
		const map = new Map<string, DocState>();
		const collect = (docs: Array<{ path: string; deleted: boolean; _rev?: string; contentHash?: string }>) => {
			for (const d of docs) {
				if (d.deleted || !d._rev || !d.contentHash) continue;
				if (ctx.isExcluded(ctx.toLocalPath(d.path))) continue;
				map.set(d.path, { rev: d._rev, hash: d.contentHash });
			}
		};
		collect((await ctx.pouch.allNotes()) as any);
		if (ctx.settings.syncAssets) collect((await ctx.pouch.allAssets()) as any);
		return map;
	}

	/**
	 * 정합된 현재 상태를 새 manifest 기준선으로 저장. 단, **로컬 파일 내용이 DB 문서와 실제로 일치하는**
	 * 항목만 기록한다(미적용/충돌/보류 상태가 "보유 이력"으로 잘못 남는 것을 막는다 — 2차 검토 P1).
	 */
	private async writeManifestSnapshot(): Promise<void> {
		const ctx = this.ctx;
		const paths: Record<string, ManifestEntry> = {};
		for (const f of this.localFiles()) {
			const dbPath = ctx.toDbPath(f.path);
			if (dbPath == null) continue;
			const entry = await this.verifiedEntry(dbPath, f.path);
			if (entry) paths[dbPath] = entry;
		}
		try {
			await saveManifest(ctx.pouch, { localRoot: ctx.localRoot, paths, updatedAt: Date.now() });
		} catch (e) {
			ctx.logger.error(
				t("manifest 기록 실패: {err}", { err: e instanceof Error ? e.message : String(e) }),
			);
		}
	}

	/**
	 * 한 파일이 manifest 기준선 자격을 갖추는지 검사하고, 자격이 되면 {rev,hash}를 반환.
	 * 자격: DB에 미삭제·무충돌로 존재하고, 로컬 파일 내용 해시가 DB contentHash와 정확히 일치.
	 */
	private async verifiedEntry(dbPath: string, localPath: string): Promise<ManifestEntry | null> {
		const ctx = this.ctx;
		const isMd = ctx.isMarkdown(dbPath);
		const id = isMd ? noteId(dbPath) : assetId(dbPath);
		const doc = await ctx.pouch.getWithConflicts<NoteDoc | AssetDoc>(id);
		if (!doc || doc.deleted || !doc._rev || !doc.contentHash) return null;
		if (doc._conflicts && doc._conflicts.length > 0) return null; // 미해소 충돌 → 보유 이력 아님
		let localHash: string | null;
		if (isMd) {
			const content = await ctx.readVaultFile(localPath);
			localHash = content == null ? null : await sha256(content);
		} else {
			// 업로드와 동일하게 크기 한도를 먼저 본다 — 큰 파일을 메모리에 읽지 않는다(모바일 보호).
			const size = ctx.getFile(localPath)?.stat.size ?? 0;
			if (exceedsAttachmentLimit(size, ctx.settings.maxAttachmentMB || 0)) return null;
			const bin = await ctx.readVaultBinary(localPath);
			localHash = bin == null ? null : await sha256(bin);
		}
		if (localHash == null || localHash !== doc.contentHash) return null; // 내용 불일치(보류/스킵/충돌 등)
		return { rev: doc._rev, hash: doc.contentHash };
	}

	/** localRoot 아래, excludeFolders 제외 동기화 대상 파일(markdown + 첨부). */
	private localFiles(): TFile[] {
		const ctx = this.ctx;
		const all = ctx.settings.syncAssets ? ctx.app.vault.getFiles() : ctx.app.vault.getMarkdownFiles();
		return all.filter((f) => {
			if (ctx.toDbPath(f.path) == null) return false; // localRoot 밖
			if (ctx.isExcluded(f.path)) return false;
			return true;
		});
	}
}
