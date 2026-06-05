import { App, Modal, Notice, Setting } from "obsidian";
import { VersionDoc, VersionKind } from "../core/model/types";
import { t } from "../i18n";

/** 버전 히스토리가 의존하는 호스트 동작. ClassSyncPlugin이 구현. */
export interface VersionHistoryHost {
	versionHistoryFor(localPath: string): Promise<VersionDoc[]>;
	restoreVersion(localPath: string, versionDocId: string, opts: { backupCurrent?: boolean }): Promise<"restored" | "missing">;
}

function kindLabel(kind: VersionKind): string {
	switch (kind) {
		case "modify":
			return t("수정");
		case "delete":
			return t("삭제 직전");
		case "conflict":
			return t("충돌 해소 직전");
		case "restore":
			return t("복구");
	}
}

/** 활성 파일의 버전 목록 + 미리보기 + 복원. 보고서 §1 P2. */
export class VersionHistoryModal extends Modal {
	private expanded: string | null = null;

	constructor(
		app: App,
		private host: VersionHistoryHost,
		private localPath: string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: t("버전 기록") });
		contentEl.createEl("p", { cls: "setting-item-description", text: this.localPath });

		let versions: VersionDoc[] = [];
		try {
			versions = await this.host.versionHistoryFor(this.localPath);
		} catch (e) {
			contentEl.createEl("p", { text: t("목록을 불러오지 못했습니다: {error}", { error: e instanceof Error ? e.message : String(e) }) });
			return;
		}

		if (versions.length === 0) {
			contentEl.createEl("p", { text: t("저장된 버전이 없습니다. (편집·삭제·충돌 해소 시 기록됩니다.)") });
			return;
		}

		const list = contentEl.createDiv({ cls: "class-sync-version-list" });
		for (const v of versions) {
			const card = list.createDiv({ cls: "class-sync-version-card" });
			const who = v.role === "teacher" ? t("교사") : t("학생");
			new Setting(card)
				.setName(new Date(v.createdAtMs).toLocaleString())
				.setDesc(t("{kind} · {who} {by} · {device}", { kind: kindLabel(v.kind), who, by: v.createdBy, device: v.deviceId.slice(0, 6) }))
				.addButton((b) =>
					b.setButtonText(this.expanded === v._id ? t("미리보기 닫기") : t("미리보기")).onClick(() => {
						this.expanded = this.expanded === v._id ? null : v._id;
						void this.render();
					}),
				)
				.addButton((b) => b.setButtonText(t("이 버전으로 복원")).setCta().onClick(() => this.restore(v, false)))
				.addButton((b) => b.setButtonText(t("현재 백업 후 복원")).onClick(() => this.restore(v, true)));

			if (this.expanded === v._id) {
				card.createEl("pre", { cls: "class-sync-version-preview", text: v.content });
			}
		}
	}

	private async restore(v: VersionDoc, backupCurrent: boolean): Promise<void> {
		const res = await this.host.restoreVersion(this.localPath, v._id, { backupCurrent });
		if (res === "restored") new Notice(t("버전 복원됨: {when}", { when: new Date(v.createdAtMs).toLocaleString() }));
		else new Notice(t("복원할 수 없습니다."));
		await this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
