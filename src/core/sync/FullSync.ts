import { TFile } from "obsidian";
import { MirrorContext } from "./MirrorContext";
import { MirrorApplier } from "./MirrorApplier";
import { Uploader } from "./Uploader";

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
		ctx.logger.info(`전체 동기화 시작 (${direction}) — ${ctx.remoteDb}`);

		// 1) vault → 로컬 DB
		if (direction === "up" || direction === "both") await this.upload();

		// 2) 로컬 ↔ 원격 1회 동기화 (자동 동기화가 꺼져 있어도 원격까지 반영)
		try {
			const r = await ctx.pouch.replicateOnce();
			ctx.logger.info(`원격 동기화: ↑${r.pushed} ↓${r.pulled} 문서`);
		} catch (e) {
			ctx.logger.error(`원격 동기화 실패: ${e instanceof Error ? e.message : String(e)}`, true);
		}

		// 3) 로컬 DB(원격 반영분 포함) → vault
		if (direction === "down" || direction === "both") await this.download();

		await ctx.core.flushPersist();
		ctx.logger.ok(`전체 동기화 완료 (${direction}).`, true);
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
		ctx.logger.info(`다운로드 정합: 문서 ${notes.length} + 첨부 ${assetCount} 중 ${applied}개 적용.`);
	}

	private async upload(): Promise<void> {
		const ctx = this.ctx;
		let uploaded = 0;
		const files = this.localFiles();
		for (const file of files) {
			const res = await this.uploader.uploadPath(file.path);
			if (res === "uploaded") uploaded++;
		}
		ctx.logger.info(`업로드 정합: ${files.length}개 파일 중 ${uploaded}개 업로드.`);
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
