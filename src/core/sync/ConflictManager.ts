import { MirrorContext } from "./MirrorContext";
import { NoteDoc, noteId } from "../model/types";
import { sha256 } from "../hash/hash";
import { t } from "../../i18n";

// both = 두 버전 보관(로컬 최종), both-remote = 두 버전 보관(원격 최종).
export type ResolveChoice = "local" | "remote" | "both" | "both-remote";

export interface ConflictInfo {
	remoteDb: string;
	studentId: string;
	dbPath: string;
	localPath: string;
	conflictPath: string; // _충돌/... 원격본 경로
	localContent: string | null;
	remoteContent: string;
	remoteMeta: { by: string; role: string; at: string };
}

/**
 * 충돌(_conflicts) 해소. 기술문서 §14.3 / §21.5.
 *
 * 충돌은 2개 이상의 리프 리비전으로 존재하고, preserve-local로 live 파일=로컬 내용이 유지된다.
 * 원격 버전을 보이는 _충돌/ 폴더로 꺼내 비교 가능하게 하고, 선택으로 PouchDB 충돌을 collapse한다.
 */
export class ConflictManager {
	constructor(private ctx: MirrorContext) {}

	/** 충돌 감지 시: 원격(=라이브와 다른) 리프 내용을 _충돌/ 폴더에 기록. */
	async materialize(doc: NoteDoc & { _conflicts?: string[] }): Promise<void> {
		const ctx = this.ctx;
		const dbPath = doc.path;
		const remote = await this.pickRemoteLeaf(dbPath, doc, doc._conflicts ?? []);
		if (!remote) return;
		const path = ctx.conflictLocalPath(dbPath);
		try {
			await ctx.writeVaultFile(path, remote.content);
		} catch (e) {
			ctx.logger.error(
				t("충돌본 기록 실패: {path} — {err}", { path, err: e instanceof Error ? e.message : String(e) }),
			);
		}
	}

	/** 현재 충돌 목록. */
	async list(): Promise<ConflictInfo[]> {
		const ctx = this.ctx;
		const items = await ctx.pouch.listConflicts();
		const out: ConflictInfo[] = [];
		for (const { doc, conflictRevs } of items) {
			const dbPath = doc.path;
			const localPath = ctx.toLocalPath(dbPath);
			const local = await ctx.readVaultFile(localPath);
			const remote = await this.pickRemoteLeaf(dbPath, doc, conflictRevs);
			if (!remote) continue;
			out.push({
				remoteDb: ctx.remoteDb,
				studentId: ctx.studentId,
				dbPath,
				localPath,
				conflictPath: ctx.conflictLocalPath(dbPath),
				localContent: local,
				remoteContent: remote.content,
				remoteMeta: { by: remote.lastModifiedBy, role: remote.lastModifiedRole, at: remote.updatedAt },
			});
		}
		return out;
	}

	/** 선택대로 해소: 내용 확정(winner 위 새 리비전) + 나머지 리프 제거 + 충돌본 삭제. */
	async resolve(dbPath: string, choice: ResolveChoice): Promise<void> {
		const ctx = this.ctx;
		const id = noteId(dbPath);
		const winner = await ctx.pouch.getWithConflicts<NoteDoc>(id);
		if (!winner || !winner._conflicts || winner._conflicts.length === 0) {
			ctx.logger.info(t("이미 해소된 충돌: {path}", { path: dbPath }));
			await this.removeConflictCopy(dbPath);
			return;
		}
		const conflictRevs = winner._conflicts;
		const localPath = ctx.toLocalPath(dbPath);
		const live = await ctx.readVaultFile(localPath);
		const remote = await this.pickRemoteLeaf(dbPath, winner, conflictRevs);

		// "두 버전 보관": 최종이 아닌 쪽을 별도 파일로 저장(동기화됨).
		// both=로컬 최종(원격을 사본으로), both-remote=원격 최종(로컬을 사본으로).
		if ((choice === "both" || choice === "both-remote") && remote) {
			const keepContent = choice === "both-remote" ? (live ?? winner.content) : remote.content;
			const keepPath = ctx.toLocalPath(dbPath.replace(/\.md$/i, ` ${t("(충돌본)")}.md`));
			await ctx.writeVaultFile(keepPath, keepContent);
			ctx.logger.ok(t("충돌 두 버전 보관: {path}", { path: keepPath }));
		}

		// 확정할 내용(최종본)
		const chosen = (choice === "remote" || choice === "both-remote") && remote ? remote.content : (live ?? winner.content);

		// live vault 갱신 (원격 적용 시 내용이 바뀌므로 guard로 에코 차단)
		ctx.guard.mark(localPath, await sha256(chosen));
		await ctx.writeVaultFile(localPath, chosen);
		ctx.guard.releaseAfterDelay(localPath);

		// DB collapse: 선택 내용을 winner 위에 새 리비전으로 + 나머지 리프 제거
		const doc = await ctx.buildNoteDoc(dbPath, chosen, winner.version);
		await ctx.pouch.put(doc);
		for (const rev of conflictRevs) {
			try {
				await ctx.pouch.removeRev(id, rev);
			} catch {
				/* 이미 제거됨 등 무시 */
			}
		}

		await this.removeConflictCopy(dbPath);
		ctx.logger.ok(t("충돌 해소({choice}): {path}", { choice, path: dbPath }), true);
	}

	// --- 내부 ---

	/** winner + conflict 리프 중 라이브 파일과 내용이 다른(원격) 리프를 고른다. */
	private async pickRemoteLeaf(
		dbPath: string,
		winner: NoteDoc,
		conflictRevs: string[],
	): Promise<NoteDoc | null> {
		const ctx = this.ctx;
		const id = noteId(dbPath);
		const live = await ctx.readVaultFile(ctx.toLocalPath(dbPath));
		const liveHash = live == null ? null : await sha256(live);

		const leaves: NoteDoc[] = [winner];
		for (const rev of conflictRevs) {
			const d = await ctx.pouch.getRev<NoteDoc>(id, rev);
			if (d) leaves.push(d);
		}
		for (const leaf of leaves) {
			if ((await sha256(leaf.content)) !== liveHash) return leaf;
		}
		// 모든 리프가 라이브와 동일 → 보여줄 원격본 없음
		return null;
	}

	/** 이 경로에 충돌 원격본이 존재하는가(= 충돌이 있었던 경로인가). */
	hadConflict(dbPath: string): boolean {
		return this.ctx.getFile(this.ctx.conflictLocalPath(dbPath)) != null;
	}

	/** 상대가 충돌을 해소해 내 편집이 덮일 때, 내 버전을 _충돌/<base>.내편집.md에 보존. */
	async preserveLocal(dbPath: string, content: string): Promise<void> {
		const path = this.ctx.localBackupPath(dbPath);
		try {
			await this.ctx.writeVaultFile(path, content);
		} catch (e) {
			this.ctx.logger.error(
				t("내 편집 보존 실패: {path} — {err}", { path, err: e instanceof Error ? e.message : String(e) }),
			);
		}
	}

	/** 해소되어 더는 필요 없는 _충돌/ 원격본을 정리(반대편 전파 후 호출). */
	async cleanupCopy(dbPath: string): Promise<void> {
		await this.removeConflictCopy(dbPath);
	}

	private async removeConflictCopy(dbPath: string): Promise<void> {
		const path = this.ctx.conflictLocalPath(dbPath);
		const file = this.ctx.getFile(path);
		if (file) {
			this.ctx.suppressStructural(path);
			await this.ctx.deleteVaultFile(file);
		}
	}
}
