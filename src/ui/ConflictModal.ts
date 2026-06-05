import { App, Modal, Setting } from "obsidian";
import { ConflictInfo, ResolveChoice } from "../core/sync/ConflictManager";
import { MirrorSync } from "../core/sync/MirrorSync";
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
			new Setting(card)
				.setName(row.info.dbPath)
				.setDesc(
					t("학생 {studentId} · 원격 수정: {by}({role}) {at}", {
						studentId: row.info.studentId,
						by: row.info.remoteMeta.by,
						role: row.info.remoteMeta.role,
						at: row.info.remoteMeta.at,
					}),
				)
				.setHeading();

			new Setting(card)
				.addButton((b) => b.setButtonText(t("비교(열기)")).onClick(() => this.host.openConflictFiles(row)))
				.addButton((b) => b.setButtonText(t("로컬 유지")).setCta().onClick(() => this.act(row, "local")))
				.addButton((b) => b.setButtonText(t("원격 적용")).onClick(() => this.act(row, "remote")))
				.addButton((b) => b.setButtonText(t("두 버전 보관(로컬 최종)")).onClick(() => this.act(row, "both")))
				.addButton((b) => b.setButtonText(t("두 버전 보관(원격 최종)")).onClick(() => this.act(row, "both-remote")));
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
