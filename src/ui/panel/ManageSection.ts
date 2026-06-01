import { PanelHost, PanelSection, panelButton } from "./PanelSection";

/** 관리 탭 — 연결/진단/캐시/실시간 점검 + (교사) 서버 초기화 / (학생) 공유 새로고침. */
export class ManageSection implements PanelSection {
	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("class-sync-panel-section");
		const actions = container.createDiv({ cls: "class-sync-panel-actions" });

		panelButton(actions, "연결/권한 테스트", () => this.host.testConnection());
		panelButton(actions, "종합 진단 실행", () => this.host.runDiagnostics());
		panelButton(actions, "실시간 상태 점검", () => this.host.realtimeStatus());
		panelButton(actions, "로컬 캐시 초기화", () => this.host.resetLocalCache());

		if (this.host.settings.role === "teacher") {
			panelButton(actions, "서버 데이터 초기화…", () => this.host.openResetModal(), { warning: true });
		} else {
			panelButton(actions, "공유 공간 새로고침", () => this.host.refreshShares());
		}
	}

	dispose(): void {
		/* 구독 없음 */
	}
}
