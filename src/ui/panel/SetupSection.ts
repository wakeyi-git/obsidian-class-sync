import { Notice } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { t } from "../../i18n";

interface Step {
	title: string;
	desc: string;
	done: boolean;
	/** 보조 액션 버튼들. */
	actions: Array<{ label: string; run: () => void | Promise<void>; cta?: boolean }>;
}

/**
 * 교사 온보딩 마법사(체크리스트). 설정에서 각 단계 완료 여부를 파생 계산하고, 다음 행동을 버튼으로 안내한다.
 * 중간에 닫아도 설정 상태로 진행 상황이 유지되며, 2초마다 새로고침해 설정 변경을 반영한다.
 */
export class SetupSection implements PanelSection {
	private container: HTMLElement | null = null;
	private timer: number | null = null;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		this.container = container;
		container.addClass("class-sync-panel-section");
		this.draw();
		this.timer = window.setInterval(() => this.draw(), 2000);
	}

	dispose(): void {
		if (this.timer != null) window.clearInterval(this.timer);
		this.timer = null;
		this.container = null;
	}

	private steps(): Step[] {
		const s = this.host.settings;
		const studentsWithId = s.students.filter((st) => st.studentId);
		const provisioned = s.students.filter((st) => st.provisioned).length;
		const synced = Object.keys(s.lastSeqByDb ?? {}).length > 0;
		return [
			{
				title: t("1. 서버 연결"),
				desc: t("CouchDB 서버 주소와 관리자 계정을 입력하고 연결을 확인합니다."),
				done: !!(s.couchdbUrl && s.username && s.password),
				actions: [
					{ label: t("설정 열기"), run: () => this.host.openSettings(), cta: true },
					{ label: t("연결 테스트"), run: () => this.host.testConnection() },
				],
			},
			{
				title: t("2. 학급 정보"),
				desc: t("학급 ID와 교사 표시 이름을 정합니다."),
				done: !!s.classId,
				actions: [{ label: t("설정 열기"), run: () => this.host.openSettings() }],
			},
			{
				title: t("3. 학생 등록"),
				desc: t("학생을 추가합니다(설정의 학생 목록에서 ‘+ 학생 추가’)."),
				done: studentsWithId.length > 0,
				actions: [{ label: t("설정 열기"), run: () => this.host.openSettings(), cta: studentsWithId.length === 0 }],
			},
			{
				title: t("4. 학생 초대"),
				desc: t("학생 카드의 ‘초대’로 계정/DB/권한을 만들고 QR·코드를 전달합니다. ({n}명 완료)", {
					n: provisioned,
				}),
				done: provisioned > 0,
				actions: [{ label: t("설정 열기"), run: () => this.host.openSettings() }],
			},
			{
				title: t("5. 첫 동기화 테스트"),
				desc: t("전체 동기화를 한 번 실행해 서버까지 왕복을 확인합니다."),
				done: synced,
				actions: [{ label: t("전체 동기화"), run: () => this.host.fullSync("both"), cta: !synced }],
			},
		];
	}

	private draw(): void {
		const c = this.container;
		if (!c) return;
		c.empty();

		const steps = this.steps();
		const doneCount = steps.filter((x) => x.done).length;

		c.createDiv({ cls: "class-sync-panel-label", text: t("교사 시작하기") });
		c.createDiv({
			cls: "class-sync-panel-hint",
			text: t("{done}/{total} 단계 완료 — 순서대로 따라 하면 첫 설정이 끝납니다.", {
				done: doneCount,
				total: steps.length,
			}),
		});

		for (const step of steps) {
			const card = c.createDiv({ cls: `class-sync-setup-step${step.done ? " is-done" : ""}` });
			const head = card.createDiv({ cls: "class-sync-setup-head" });
			head.createSpan({ cls: "class-sync-setup-check", text: step.done ? "✓" : "○" });
			head.createSpan({ cls: "class-sync-setup-title", text: step.title });
			card.createDiv({ cls: "class-sync-panel-hint", text: step.desc });
			if (!step.done) {
				const actions = card.createDiv({ cls: "class-sync-panel-actions" });
				for (const a of step.actions) panelButton(actions, a.label, a.run, { cta: a.cta });
			}
		}

		// 완료/닫기
		const footer = c.createDiv({ cls: "class-sync-panel-actions" });
		panelButton(
			footer,
			doneCount === steps.length ? t("마치고 대시보드로") : t("나중에 하기 (대시보드로)"),
			async () => {
				await this.host.completeOnboarding();
				new Notice(t("Class Sync: 시작하기를 닫았습니다. ‘시작하기’ 탭에서 다시 볼 수 있어요."));
				await this.host.activatePanel("sync");
			},
			{ cta: doneCount === steps.length },
		);
	}
}
