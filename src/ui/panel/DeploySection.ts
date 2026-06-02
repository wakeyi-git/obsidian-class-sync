import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { t } from "../../i18n";

/** 배포 탭(교사) — 파일/폴더 복사 + 공유 공간 배포. */
export class DeploySection implements PanelSection {
	private container: HTMLElement | null = null;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		this.container = container;
		container.empty();
		container.addClass("class-sync-panel-section");

		const copy = container.createDiv({ cls: "class-sync-panel-actions" });
		panelButton(copy, t("현재 파일을 학생에게 복사"), () => this.host.openBulkCopy("file"), { cta: true });
		panelButton(copy, t("현재 폴더를 학생에게 복사"), () => this.host.openBulkCopy("folder"));

		container.createDiv({ cls: "class-sync-panel-label", text: t("공유 공간") });
		const spaces = this.host.settings.sharedSpaces;
		if (spaces.length === 0) {
			container.createDiv({ cls: "class-sync-feedback-empty", text: t("설정에서 공유 공간을 추가하세요.") });
			return;
		}
		for (const sp of spaces) {
			const row = container.createDiv({ cls: "class-sync-panel-row" });
			row.createSpan({
				text: t("{name} · {db}{status}", {
					name: sp.name || sp.id,
					db: sp.remoteDb,
					status: sp.provisioned ? " ✓" : t(" (미배포)"),
				}),
			});
			panelButton(row, sp.provisioned ? t("재배포") : t("배포"), async () => {
				await this.host.deployShared(sp);
				this.render(container); // 배포 후 상태 갱신
			});
		}
	}

	dispose(): void {
		this.container = null;
	}
}
