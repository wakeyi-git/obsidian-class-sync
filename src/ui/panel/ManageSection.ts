import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { t } from "../../i18n";

/** 관리 탭 — 연결/진단/캐시/실시간 점검 + (교사) 서버 초기화 / (학생) 공유 새로고침. */
export class ManageSection implements PanelSection {
	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("class-sync-panel-section");

		const item = (
			label: string,
			desc: string,
			onClick: () => void | Promise<void>,
			opts?: { warning?: boolean },
		) => {
			const row = container.createDiv({ cls: "class-sync-manage-item" });
			panelButton(row, label, onClick, opts);
			row.createDiv({ cls: "class-sync-panel-hint", text: desc });
		};

		item(t("연결/권한 테스트"), t("CouchDB 서버 연결과 DB 읽기/쓰기 권한을 확인합니다."), () => this.host.testConnection());
		item(t("종합 진단 실행"), t("서버 도달·링크별 권한·실시간 상태를 한 번에 점검합니다."), () => this.host.runDiagnostics());
		item(t("실시간 상태 점검"), t("현재 파일의 실시간 세션·접속자·토큰 상태를 로그에 출력합니다."), () => this.host.realtimeStatus());
		item(t("로컬 캐시 초기화"), t("로컬 PouchDB를 비우고 서버에서 다시 받습니다(서버 데이터는 그대로)."), () => this.host.resetLocalCache());

		if (this.host.settings.role === "teacher") {
			item(t("서버 데이터 초기화…"), t("서버의 학생·공유 DB를 삭제합니다(파괴적 — 확인 단어 입력 필요)."), () => this.host.openResetModal(), { warning: true });
		} else {
			item(t("공유 공간 새로고침"), t("교사가 배포한 공유 공간 목록을 서버에서 다시 받습니다."), () => this.host.refreshShares());
		}
	}

	dispose(): void {
		/* 구독 없음 */
	}
}
