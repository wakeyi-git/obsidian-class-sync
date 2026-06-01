import { LinkStatus } from "../../core/sync/MirrorContext";
import { DashboardRow, PanelHost, PanelSection, panelButton } from "./PanelSection";

const STATE_LABEL: Record<LinkStatus["state"], string> = {
	syncing: "🟢 동기화 중",
	idle: "🟢 대기",
	offline: "⚪ 오프라인",
	error: "🔴 오류",
	disabled: "⚪ 꺼짐",
};

/** 동기화 상태 탭 — 링크별 상태 표(3초 갱신) + 동기화/자동동기화/충돌 액션. (구 DashboardView 본문 + 버튼) */
export class SyncStatusSection implements PanelSection {
	private timer: number | null = null;
	private tableWrap: HTMLElement | null = null;
	private autoBtn: HTMLButtonElement | null = null;

	constructor(private host: PanelHost) {}

	render(container: HTMLElement): void {
		container.addClass("class-sync-dashboard");

		const actions = container.createDiv({ cls: "class-sync-panel-actions" });
		panelButton(actions, "전체 동기화", () => this.host.fullSync("both"), { cta: true });
		panelButton(actions, "업로드만", () => this.host.fullSync("up"));
		panelButton(actions, "다운로드만", () => this.host.fullSync("down"));
		this.autoBtn = panelButton(actions, this.autoLabel(), async () => {
			await this.host.toggleAutoSync();
			this.autoBtn?.setText(this.autoLabel());
		});
		panelButton(actions, "충돌 목록", () => this.host.openConflictModal());

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
		return `자동 동기화: ${this.host.settings.autoSync ? "켜짐" : "꺼짐"}`;
	}

	private async renderTable(): Promise<void> {
		const wrap = this.tableWrap;
		if (!wrap) return;
		let rows: DashboardRow[] = [];
		try {
			rows = await this.host.getDashboardRows();
		} catch (e) {
			wrap.empty();
			wrap.createEl("p", { text: `상태를 불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		if (!this.tableWrap) return; // 그 사이 dispose됨
		wrap.empty();

		if (rows.length === 0) {
			wrap.createEl("p", { text: "표시할 링크가 없습니다. (교사: 학생을 초대하세요)" });
			return;
		}

		const totalConflicts = rows.reduce((n, r) => n + r.conflicts, 0);
		wrap.createDiv({ cls: "class-sync-dash-summary", text: `링크 ${rows.length}개 · 충돌 ${totalConflicts}건` });

		const table = wrap.createEl("table", { cls: "class-sync-dash-table" });
		const thead = table.createEl("thead").createEl("tr");
		for (const h of ["대상", "Mirror DB", "폴더", "마지막 업로드", "마지막 수신", "충돌", "상태"]) {
			thead.createEl("th", { text: h });
		}
		const tbody = table.createEl("tbody");
		for (const r of rows) {
			const tr = tbody.createEl("tr");
			tr.createEl("td", { text: r.studentName || r.studentId || "—" });
			tr.createEl("td", { text: r.remoteDb });
			tr.createEl("td", { text: r.localRoot || "(root)" });
			tr.createEl("td", { text: fmtTime(r.lastUploadAt) });
			tr.createEl("td", { text: fmtTime(r.lastDownloadAt) });
			const cTd = tr.createEl("td", { text: String(r.conflicts) });
			if (r.conflicts > 0) cTd.addClass("class-sync-dash-conflict");
			const sTd = tr.createEl("td", { text: STATE_LABEL[r.state] });
			if (r.state === "error" && r.lastError) sTd.setAttribute("title", r.lastError);
		}
	}
}

function fmtTime(ts?: number): string {
	if (!ts) return "—";
	const d = new Date(ts);
	const diff = Date.now() - ts;
	if (diff < 60_000) return "방금";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}분 전`;
	return d.toLocaleTimeString();
}
