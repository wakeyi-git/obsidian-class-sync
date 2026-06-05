import { App, Modal, Setting } from "obsidian";
import { ConflictInfo, ResolveChoice } from "../core/sync/ConflictManager";
import { MirrorSync } from "../core/sync/MirrorSync";
import { lineDiff, diffStats } from "../core/diff/lineDiff";
import { t } from "../i18n";

export interface ConflictRow {
	sync: MirrorSync;
	info: ConflictInfo;
}

export interface ConflictHost {
	listConflicts(): Promise<ConflictRow[]>;
	resolveConflict(row: ConflictRow, choice: ResolveChoice): Promise<void>;
	openConflictFiles(row: ConflictRow): Promise<void>;
}

/** 충돌 목록 + 해소 UI. 기술문서 §21.5. */
export class ConflictModal extends Modal {
	private ignoreWhitespace = false;

	constructor(
		app: App,
		private host: ConflictHost,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("충돌 목록") });

		let rows: ConflictRow[] = [];
		try {
			rows = await this.host.listConflicts();
		} catch (e) {
			contentEl.createEl("p", {
				text: t("목록을 불러오지 못했습니다: {error}", { error: e instanceof Error ? e.message : String(e) }),
			});
			return;
		}

		if (rows.length === 0) {
			contentEl.createEl("p", { text: t("현재 충돌이 없습니다. 🎉") });
			return;
		}

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("양쪽이 같은 파일을 다르게 편집했습니다. 로컬은 현재 vault 내용, 원격은 _충돌/ 폴더의 사본입니다."),
		});

		for (const row of rows) {
			const card = contentEl.createDiv({ cls: "class-sync-conflict-card" });
			const isAsset = row.info.kind === "asset";
			new Setting(card)
				.setName(`${isAsset ? "📎 " : ""}${row.info.dbPath}`)
				.setDesc(
					t("학생 {studentId} · 원격 수정: {by}({role}) {at}", {
						studentId: row.info.studentId,
						by: row.info.remoteMeta.by,
						role: row.info.remoteMeta.role,
						at: row.info.remoteMeta.at,
					}),
				)
				.setHeading();

			if (isAsset) this.renderAssetInfo(card, row.info);
			else this.renderDiff(card, row.info);

			const actions = new Setting(card)
				.addButton((b) =>
					b.setButtonText(isAsset ? t("원격본 열기") : t("비교(열기)")).onClick(() => this.host.openConflictFiles(row)),
				)
				.addButton((b) => b.setButtonText(t("로컬 유지")).setCta().onClick(() => this.act(row, "local")))
				.addButton((b) => b.setButtonText(t("원격 적용")).onClick(() => this.act(row, "remote")));
			if (isAsset) {
				actions.addButton((b) => b.setButtonText(t("두 버전 보관")).onClick(() => this.act(row, "both")));
			} else {
				actions
					.addButton((b) => b.setButtonText(t("두 버전 보관(로컬 최종)")).onClick(() => this.act(row, "both")))
					.addButton((b) => b.setButtonText(t("두 버전 보관(원격 최종)")).onClick(() => this.act(row, "both-remote")));
			}
		}
	}

	/** 첨부 충돌: 미리보기가 어려우므로 종류·크기만 요약. */
	private renderAssetInfo(card: HTMLElement, info: ConflictInfo): void {
		const kb = info.size != null ? `${(info.size / 1024).toFixed(1)} KB` : t("크기 미상");
		card.createDiv({
			cls: "class-sync-conflict-assetmeta",
			text: t("첨부파일 · {mime} · {size} (로컬 유지/원격 적용 또는 두 버전 보관)", {
				mime: info.mime || t("형식 미상"),
				size: kb,
			}),
		});
	}

	/** 마크다운 충돌: 로컬↔원격 라인 diff(변경 줄 하이라이트). */
	private renderDiff(card: HTMLElement, info: ConflictInfo): void {
		const local = info.localContent ?? "";
		const remote = info.remoteContent ?? "";
		const lines = lineDiff(local, remote, { ignoreWhitespace: this.ignoreWhitespace });
		const stats = diffStats(lines);

		const bar = card.createDiv({ cls: "class-sync-diff-bar" });
		bar.createSpan({ cls: "class-sync-diff-stat", text: t("− 로컬에만 {removed} · ＋ 원격에만 {added}", stats) });
		const ws = bar.createEl("label", { cls: "class-sync-diff-ws" });
		const cb = ws.createEl("input", { type: "checkbox" });
		cb.checked = this.ignoreWhitespace;
		ws.createSpan({ text: t("공백 차이 무시") });
		cb.onchange = () => {
			this.ignoreWhitespace = cb.checked;
			void this.render();
		};

		const pre = card.createEl("pre", { cls: "class-sync-diff" });
		for (const l of lines) {
			const sign = l.type === "add" ? "＋" : l.type === "remove" ? "−" : " ";
			pre.createDiv({ cls: `class-sync-diff-line is-${l.type}`, text: `${sign} ${l.text}` });
		}
	}

	private async act(row: ConflictRow, choice: ResolveChoice): Promise<void> {
		try {
			await this.host.resolveConflict(row, choice);
		} catch (e) {
			this.contentEl.createEl("p", {
				text: t("해소 실패: {error}", { error: e instanceof Error ? e.message : String(e) }),
			});
		}
		await this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
