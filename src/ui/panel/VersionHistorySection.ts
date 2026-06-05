import { EventRef } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { VersionDoc, VersionKind } from "../../core/model/types";
import { t } from "../../i18n";

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

/**
 * 버전 기록 탭. 활성 마크다운 노트의 버전 스냅샷을 보여주고 복원한다(보고서 §1 P2).
 * 활성 파일이 바뀌면 다시 렌더한다(피드백 탭과 동일 패턴).
 */
export class VersionHistorySection implements PanelSection {
	private listEl: HTMLElement | null = null;
	private refs: EventRef[] = [];
	private expanded: string | null = null;
	private currentPath: string | null = null;
	private renderSeq = 0;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("class-sync-panel-section");
		container.addClass("class-sync-version");
		this.listEl = container.createDiv({ cls: "class-sync-version-list" });

		this.refs.push(this.host.app.workspace.on("active-leaf-change", () => void this.renderList()));
		this.refs.push(this.host.app.workspace.on("file-open", () => void this.renderList()));
		void this.renderList();
	}

	dispose(): void {
		for (const r of this.refs) this.host.app.workspace.offref(r);
		this.refs = [];
		this.listEl = null;
	}

	private async renderList(): Promise<void> {
		if (!this.listEl) return;
		const seq = ++this.renderSeq;
		const file = this.host.app.workspace.getActiveFile();
		this.currentPath = file?.path ?? null;

		const writeEmpty = (text: string): void => {
			if (seq !== this.renderSeq || !this.listEl) return;
			this.listEl.empty();
			this.listEl.createDiv({ cls: "class-sync-version-empty", text });
		};

		if (!file || file.extension !== "md") {
			writeEmpty(t("노트를 열면 버전 기록이 표시됩니다."));
			return;
		}

		let versions: VersionDoc[] = [];
		try {
			versions = await this.host.versionHistoryFor(file.path);
		} catch {
			writeEmpty(t("버전 기록을 불러오지 못했습니다."));
			return;
		}
		if (seq !== this.renderSeq || !this.listEl) return;
		this.listEl.empty();

		this.listEl.createDiv({ cls: "class-sync-version-target", text: file.path });
		if (versions.length === 0) {
			this.listEl.createDiv({
				cls: "class-sync-version-empty",
				text: t("저장된 버전이 없습니다. (편집·삭제·충돌 해소 시 기록됩니다.)"),
			});
			return;
		}
		for (const v of versions) this.renderRow(file.path, v);
	}

	private renderRow(localPath: string, v: VersionDoc): void {
		if (!this.listEl) return;
		const card = this.listEl.createDiv({ cls: "class-sync-version-card" });

		const head = card.createDiv({ cls: "class-sync-version-head" });
		head.createSpan({ cls: "class-sync-version-time", text: new Date(v.createdAtMs).toLocaleString() });
		head.createSpan({ cls: "class-sync-version-badge", text: kindLabel(v.kind) });

		const who = v.role === "teacher" ? t("교사") : t("학생");
		card.createDiv({
			cls: "class-sync-version-meta",
			text: t("{who} {by} · {device}", { who, by: v.createdBy, device: v.deviceId.slice(0, 6) }),
		});

		const actions = card.createDiv({ cls: "class-sync-version-actions" });
		panelButton(actions, this.expanded === v._id ? t("미리보기 닫기") : t("미리보기"), () => {
			this.expanded = this.expanded === v._id ? null : v._id;
			void this.renderList();
		});
		panelButton(actions, t("이 버전으로 복원"), () => this.restore(localPath, v, false), { cta: true });
		panelButton(actions, t("현재 백업 후 복원"), () => this.restore(localPath, v, true));

		if (this.expanded === v._id) {
			card.createEl("pre", { cls: "class-sync-version-preview", text: v.content });
		}
	}

	private async restore(localPath: string, v: VersionDoc, backupCurrent: boolean): Promise<void> {
		const res = await this.host.restoreVersion(localPath, v._id, { backupCurrent });
		if (res === "restored") {
			this.host.logger.ok(t("버전 복원됨: {when}", { when: new Date(v.createdAtMs).toLocaleString() }), true);
		}
		void this.renderList();
	}
}
