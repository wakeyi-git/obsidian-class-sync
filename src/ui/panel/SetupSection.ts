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
				title: t("panel.1_server_connection"),
				desc: t("panel.enter_the_couchdb_server_address_and"),
				done: !!(s.couchdbUrl && s.username && s.password),
				actions: [
					{ label: t("panel.open_settings"), run: () => this.host.openSettings(), cta: true },
					{ label: t("settings.connection_test"), run: () => this.host.testConnection() },
				],
			},
			{
				title: t("panel.2_class_info"),
				desc: t("panel.set_the_class_id_and_teacher"),
				done: !!s.classId,
				actions: [{ label: t("panel.open_settings"), run: () => this.host.openSettings() }],
			},
			{
				title: t("panel.3_add_students"),
				desc: t("panel.add_students_add_student_in_the"),
				done: studentsWithId.length > 0,
				actions: [{ label: t("panel.open_settings"), run: () => this.host.openSettings(), cta: studentsWithId.length === 0 }],
			},
			{
				title: t("panel.4_invite_students"),
				desc: t("panel.use_invite_on_a_student_card", {
					n: provisioned,
				}),
				done: provisioned > 0,
				actions: [{ label: t("panel.open_settings"), run: () => this.host.openSettings() }],
			},
			{
				title: t("panel.5_first_sync_test"),
				desc: t("panel.run_a_full_sync_once_to"),
				done: synced,
				actions: [{ label: t("panel.full_sync"), run: () => this.host.fullSync("both"), cta: !synced }],
			},
		];
	}

	private draw(): void {
		const c = this.container;
		if (!c) return;
		c.empty();

		const steps = this.steps();
		const doneCount = steps.filter((x) => x.done).length;

		c.createDiv({ cls: "class-sync-panel-label", text: t("panel.teacher_setup") });
		c.createDiv({
			cls: "class-sync-panel-hint",
			text: t("panel.steps_done_follow_them_in_order", {
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
			doneCount === steps.length ? t("panel.finish_dashboard") : t("panel.do_it_later_dashboard"),
			async () => {
				await this.host.completeOnboarding();
				new Notice(t("panel.class_sync_closed_the_setup_guide"));
				await this.host.activatePanel("sync");
			},
			{ cta: doneCount === steps.length },
		);
	}
}
