import { Notice, TFile } from "obsidian";
import { PanelHost, PanelSection, panelButton, DeleteModifyRow, PurgeRow } from "./PanelSection";
import { DeletedItem } from "../../core/sync/RestoreManager";
import { ConfirmModal } from "../ConfirmModal";
import { t } from "../../i18n";

/**
 * 삭제 파일 복구 탭(보고서 §2 P1). 모든 링크의 tombstone을 모아 보여주고,
 * 원래 위치로 복구하거나 영구 삭제(purge)할 수 있게 한다. `_삭제됨/` 폴더를 직접 뒤지지 않아도 된다.
 */
export class DeletedRecoverySection implements PanelSection {
	private listEl: HTMLElement | null = null;
	private renderSeq = 0;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("class-sync-panel-section");
		container.addClass("class-sync-recovery");

		const toolbar = container.createDiv({ cls: "class-sync-recovery-toolbar" });
		panelButton(toolbar, t("새로고침"), () => void this.renderList());
		toolbar.createDiv({
			cls: "class-sync-panel-hint",
			text: t("삭제된 파일을 원래 위치로 되돌리거나 영구 삭제합니다. 같은 이름이 있으면 ‘(복구본)’으로 복구됩니다."),
		});

		this.listEl = container.createDiv({ cls: "class-sync-recovery-list" });
		void this.renderList();
	}

	dispose(): void {
		this.listEl = null;
	}

	private async renderList(): Promise<void> {
		if (!this.listEl) return;
		const seq = ++this.renderSeq;
		const [items, conflicts, purges] = await Promise.all([
			this.host.listDeletedFiles(),
			this.host.listDeleteModify(),
			this.host.listRecentPurges(),
		]);
		if (seq !== this.renderSeq || !this.listEl) return;
		this.listEl.empty();

		// 1) 삭제/수정 충돌(있을 때만, 가장 위 — 사용자 판단 필요).
		if (conflicts.length > 0) {
			this.listEl.createDiv({ cls: "class-sync-recovery-group is-conflict", text: t("삭제/수정 충돌") });
			for (const c of conflicts) this.renderConflictRow(c);
		}

		// 2) 삭제된 파일.
		this.listEl.createDiv({ cls: "class-sync-recovery-group", text: t("삭제된 파일") });
		if (items.length === 0) {
			this.listEl.createDiv({ cls: "class-sync-recovery-empty", text: t("삭제된 파일이 없습니다.") });
		} else {
			for (const it of items) this.renderRow(it);
		}

		// 3) 최근 영구 삭제(되돌리기).
		if (purges.length > 0) {
			this.listEl.createDiv({ cls: "class-sync-recovery-group", text: t("최근 영구 삭제") });
			for (const p of purges) this.renderPurgeRow(p);
		}
	}

	private renderConflictRow(c: DeleteModifyRow): void {
		if (!this.listEl) return;
		const card = this.listEl.createDiv({ cls: "class-sync-recovery-card is-conflict" });
		card.createDiv({ cls: "class-sync-recovery-path", text: c.dbPath });
		card.createDiv({
			cls: "class-sync-recovery-meta",
			text: t("내가 삭제했지만 다른 기기가 수정했습니다. 어떻게 처리할까요?"),
		});
		const actions = card.createDiv({ cls: "class-sync-recovery-actions" });
		panelButton(actions, t("원격 수정 유지"), () => this.resolveConflict(c, "keep-remote"), { cta: true });
		panelButton(actions, t("수정본 보관 후 삭제"), () => this.resolveConflict(c, "keep-both"));
		panelButton(actions, t("내 삭제 적용"), () => this.resolveConflict(c, "delete"), { warning: true });
	}

	private async resolveConflict(c: DeleteModifyRow, choice: "delete" | "keep-remote" | "keep-both"): Promise<void> {
		await this.host.resolveDeleteModify(c.remoteDb, c.dbPath, choice);
		void this.renderList();
	}

	private renderPurgeRow(p: PurgeRow): void {
		if (!this.listEl) return;
		const card = this.listEl.createDiv({ cls: "class-sync-recovery-card" });
		card.createDiv({ cls: "class-sync-recovery-path", text: p.dbPath });
		card.createDiv({
			cls: "class-sync-recovery-meta",
			text: t("영구 삭제 · {when}", { when: new Date(p.purgedAt).toLocaleString() }),
		});
		const actions = card.createDiv({ cls: "class-sync-recovery-actions" });
		if (p.recoverable) {
			panelButton(actions, t("되돌리기"), () => this.undoPurge(p), { cta: true });
		} else {
			card.createDiv({ cls: "class-sync-recovery-note", text: t("되돌릴 내용이 없습니다(첨부 원본 미보존).") });
		}
		panelButton(actions, t("목록에서 지우기"), async () => {
			await this.host.clearPurge(p.remoteDb, p.id);
			void this.renderList();
		});
	}

	private async undoPurge(p: PurgeRow): Promise<void> {
		const res = await this.host.undoPurge(p.remoteDb, p.id);
		if (res === "restored") new Notice(t("되돌림: {path}", { path: p.dbPath }));
		else new Notice(t("되돌릴 수 없습니다: {path}", { path: p.dbPath }));
		void this.renderList();
	}

	private renderRow(it: DeletedItem): void {
		if (!this.listEl) return;
		const card = this.listEl.createDiv({ cls: "class-sync-recovery-card" });

		const head = card.createDiv({ cls: "class-sync-recovery-head" });
		head.createSpan({ cls: "class-sync-recovery-path", text: it.dbPath });
		head.createSpan({
			cls: `class-sync-recovery-badge${it.recoverable ? " is-ok" : " is-warn"}`,
			text: it.kind === "asset" ? t("첨부") : t("노트"),
		});

		const who = it.deletedByRole === "teacher" ? t("교사") : t("학생");
		const when = it.deletedAt ? new Date(it.deletedAt).toLocaleString() : t("(시각 미상)");
		card.createDiv({
			cls: "class-sync-recovery-meta",
			text: t("{who} {by} 삭제 · {when}", { who, by: it.deletedBy ?? "", when }),
		});

		const actions = card.createDiv({ cls: "class-sync-recovery-actions" });
		if (it.recoverable) {
			panelButton(actions, t("원래 위치로 복구"), () => this.restore(it), { cta: true });
		} else {
			card.createDiv({
				cls: "class-sync-recovery-note",
				text:
					it.kind === "asset"
						? t("첨부 원본이 없어 복구 불가(‘_삭제됨/’ 사본이 있는 기기에서 복구하세요).")
						: t("복구할 내용이 없습니다."),
			});
		}
		panelButton(actions, t("영구 삭제"), () => this.confirmPurge(it), { warning: true });
		if (it.recoverable && it.kind === "note") {
			panelButton(actions, t("내용 열기"), () => this.preview(it));
		}
	}

	private async restore(it: DeletedItem): Promise<void> {
		const res = await this.host.restoreDeleted(it.remoteDb, it.dbPath, { collision: "keep-both" });
		if (res === "restored") new Notice(t("복구됨: {path}", { path: it.dbPath }));
		else if (res === "unrecoverable") new Notice(t("복구할 수 없습니다: {path}", { path: it.dbPath }));
		else if (res === "skipped-exists") new Notice(t("이미 같은 파일이 있어 건너뜀: {path}", { path: it.dbPath }));
		void this.renderList();
	}

	private confirmPurge(it: DeletedItem): void {
		new ConfirmModal(this.host.app, {
			title: t("영구 삭제: {path}", { path: it.dbPath }),
			message: t("서버 DB에서 이 문서를 완전히 제거합니다. 되돌릴 수 없습니다."),
			confirmText: t("영구 삭제"),
			warning: true,
			onConfirm: async () => {
				await this.host.purgeDeleted(it.remoteDb, it.dbPath);
				new Notice(t("영구 삭제됨: {path}", { path: it.dbPath }));
				void this.renderList();
			},
		}).open();
	}

	/** 복구 전 내용 미리보기: 복구하면 생길 위치에 임시로 보지 않고, 이미 vault에 사본이 있으면 연다. */
	private async preview(it: DeletedItem): Promise<void> {
		const file = this.host.app.vault.getAbstractFileByPath(it.localPath);
		if (file instanceof TFile) {
			await this.host.app.workspace.getLeaf(false).openFile(file);
		} else {
			new Notice(t("미리볼 사본이 없습니다. ‘원래 위치로 복구’ 후 확인하세요."));
		}
	}
}
