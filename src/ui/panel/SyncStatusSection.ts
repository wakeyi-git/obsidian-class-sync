import { LinkStatus } from "../../core/sync/MirrorContext";
import { DashboardRow, PanelHost, PanelSection, panelButton } from "./PanelSection";
import { t } from "../../i18n";

function stateLabel(state: LinkStatus["state"]): string {
	switch (state) {
		case "syncing":
			return t("🟢 동기화 중");
		case "idle":
			return t("🟢 대기");
		case "offline":
			return t("⚪ 오프라인");
		case "error":
			return t("🔴 오류");
		case "disabled":
			return t("⚪ 꺼짐");
	}
}

/** 동기화 상태 탭 — 링크별 상태 표(3초 갱신) + 동기화/자동동기화/충돌 액션. (구 DashboardView 본문 + 버튼) */
export class SyncStatusSection implements PanelSection {
	private timer: number | null = null;
	private tableWrap: HTMLElement | null = null;
	private autoBtn: HTMLButtonElement | null = null;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("class-sync-dashboard");

		const actions = container.createDiv({ cls: "class-sync-panel-actions" });
		panelButton(actions, t("전체 동기화"), () => this.host.fullSync("both"), { cta: true });
		panelButton(actions, t("업로드만"), () => this.host.fullSync("up"));
		panelButton(actions, t("다운로드만"), () => this.host.fullSync("down"));
		this.autoBtn = panelButton(actions, this.autoLabel(), async () => {
			await this.host.toggleAutoSync();
			this.autoBtn?.setText(this.autoLabel());
		});
		panelButton(actions, t("충돌 목록"), () => this.host.openConflictModal());

		this.tableWrap = container.createDiv();
		void this.renderTable();
		this.timer = window.setInterval(() => void this.renderTable(), 3000);
	}

	dispose(): void {
		if (this.timer != null) window.clearInterval(this.timer);
		this.timer = null;
		this.tableWrap = null;
		this.autoBtn = null;
	}

	private autoLabel(): string {
		return t("자동 동기화: {state}", { state: this.host.settings.autoSync ? t("켜짐") : t("꺼짐") });
	}

	private async renderTable(): Promise<void> {
		const wrap = this.tableWrap;
		if (!wrap) return;
		let rows: DashboardRow[] = [];
		try {
			rows = await this.host.getDashboardRows();
		} catch (e) {
			wrap.empty();
			wrap.createEl("p", {
				text: t("상태를 불러오지 못했습니다: {error}", { error: e instanceof Error ? e.message : String(e) }),
			});
			return;
		}
		if (!this.tableWrap) return; // 그 사이 dispose됨
		wrap.empty();

		if (rows.length === 0) {
			wrap.createEl("p", { text: t("표시할 링크가 없습니다. (교사: 학생을 초대하세요)") });
			return;
		}

		const totalConflicts = rows.reduce((n, r) => n + r.conflicts, 0);
		wrap.createDiv({
			cls: "class-sync-dash-summary",
			text: t("링크 {links}개 · 충돌 {conflicts}건", { links: rows.length, conflicts: totalConflicts }),
		});

		const table = wrap.createEl("table", { cls: "class-sync-dash-table" });
		const thead = table.createEl("thead").createEl("tr");
		for (const h of [
			t("대상"),
			t("Mirror DB"),
			t("폴더"),
			t("마지막 업로드"),
			t("마지막 수신"),
			t("충돌"),
			t("상태"),
		]) {
			thead.createEl("th", { text: h });
		}
		const tbody = table.createEl("tbody");
		for (const r of rows) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: r.studentName || r.studentId || "—" });
			tr.createEl("td", { text: r.remoteDb });
			tr.createEl("td", { text: r.localRoot || t("(root)") });
			tr.createEl("td", { text: fmtTime(r.lastUploadAt) });
			tr.createEl("td", { text: fmtTime(r.lastDownloadAt) });
			const cTd = tr.createEl("td", { text: String(r.conflicts) });
			if (r.conflicts > 0) cTd.addClass("class-sync-dash-conflict");
			const sTd = tr.createEl("td", { text: stateLabel(r.state) });
			if (r.state === "error" && r.lastError) sTd.setAttribute("title", r.lastError);
		}
	}
}

function fmtTime(ts?: number): string {
	if (!ts) return "—";
	const d = new Date(ts);
	const diff = Date.now() - ts;
	if (diff < 60_000) return t("방금");
	if (diff < 3_600_000) return t("{min}분 전", { min: Math.floor(diff / 60_000) });
	return d.toLocaleTimeString();
}
