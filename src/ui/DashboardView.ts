import { ItemView, WorkspaceLeaf } from "obsidian";
import { LinkStatus } from "../core/sync/MirrorContext";

export const DASHBOARD_VIEW_TYPE = "class-sync-dashboard";

export interface DashboardRow extends LinkStatus {
	studentName: string;
	studentId: string;
	remoteDb: string;
	localRoot: string;
	conflicts: number;
}

export interface DashboardHost {
	getDashboardRows(): Promise<DashboardRow[]>;
	openConflictModal(): void;
}

const STATE_LABEL: Record<LinkStatus["state"], string> = {
	syncing: "🟢 동기화 중",
	idle: "🟢 대기",
	offline: "⚪ 오프라인",
	error: "🔴 오류",
	disabled: "⚪ 꺼짐",
};

/** 교사용 학생 상태 대시보드. 기술문서 §12.6 / §21.4. */
export class DashboardView extends ItemView {
	private timer: number | null = null;

	constructor(leaf: WorkspaceLeaf, private host: DashboardHost) {
		super(leaf);
	}

	getViewType(): string {
		return DASHBOARD_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Class Sync 대시보드";
	}
	getIcon(): string {
		return "users";
	}

	async onOpen(): Promise<void> {
		await this.render();
		this.timer = window.setInterval(() => void this.render(), 3000);
	}

	async onClose(): Promise<void> {
		if (this.timer != null) window.clearInterval(this.timer);
		this.timer = null;
	}

	private async render(): Promise<void> {
		const container = this.contentEl;
		container.empty();
		container.addClass("class-sync-dashboard");

		const header = container.createDiv({ cls: "class-sync-dash-header" });
		header.createEl("h3", { text: "학생 동기화 상태" });
		const refresh = header.createEl("button", { text: "새로고침" });
		refresh.onclick = () => void this.render();

		let rows: DashboardRow[] = [];
		try {
			rows = await this.host.getDashboardRows();
		} catch (e) {
			container.createEl("p", { text: `상태를 불러오지 못했습니다: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}

		if (rows.length === 0) {
			container.createEl("p", { text: "표시할 학생이 없습니다. (교사: 설정에서 학생을 추가하세요)" });
			return;
		}

		const totalConflicts = rows.reduce((n, r) => n + r.conflicts, 0);
		const summary = container.createDiv({ cls: "class-sync-dash-summary" });
		summary.createSpan({ text: `학생 ${rows.length}명 · 충돌 ${totalConflicts}건` });
		if (totalConflicts > 0) {
			const b = summary.createEl("button", { text: "충돌 목록 열기" });
			b.onclick = () => this.host.openConflictModal();
		}

		const table = container.createEl("table", { cls: "class-sync-dash-table" });
		const thead = table.createEl("thead").createEl("tr");
		for (const h of ["학생", "Mirror DB", "폴더", "마지막 업로드", "마지막 수신", "충돌", "상태"]) {
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
