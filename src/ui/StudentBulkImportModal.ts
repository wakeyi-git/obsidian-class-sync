import { App, Modal, Notice, Setting } from "obsidian";
import { StudentConfig } from "../settings/types";
import { parseStudentRoster, finalizeRoster, RosterEntry } from "../settings/studentRoster";
import { t } from "../i18n";

/** 학생 명단 붙여넣기 → 미리보기(중복/조정 표시) → 일괄 추가. */
export class StudentBulkImportModal extends Modal {
	private text = "";
	private previewEl: HTMLElement | null = null;

	constructor(
		app: App,
		private existingIds: string[],
		private onConfirm: (students: StudentConfig[]) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("학생 명단 일괄 추가") });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: t("한 줄에 한 명: ‘이름,ID’ 또는 ‘이름 ID’ 또는 ‘이름’만(ID 자동 생성). ‘#’로 시작하는 줄은 주석."),
		});

		const ta = contentEl.createEl("textarea", { cls: "class-sync-backup-input" });
		ta.rows = 8;
		ta.placeholder = "홍길동,hong\n김학생 kim_student\n이영희";
		ta.addEventListener("input", () => {
			this.text = ta.value;
			this.renderPreview();
		});
		window.setTimeout(() => ta.focus(), 0);

		this.previewEl = contentEl.createDiv({ cls: "class-sync-bulk-preview" });
		this.renderPreview();

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("취소")).onClick(() => this.close()))
			.addButton((b) => b.setButtonText(t("추가")).setCta().onClick(() => void this.confirm()));
	}

	private entries(): RosterEntry[] {
		return finalizeRoster(parseStudentRoster(this.text), this.existingIds);
	}

	private renderPreview(): void {
		const el = this.previewEl;
		if (!el) return;
		el.empty();
		const list = this.entries();
		const valid = list.filter((e) => !e.emptyName);
		el.createDiv({ cls: "class-sync-panel-hint", text: t("미리보기: {n}명 추가 예정", { n: valid.length }) });
		if (list.length === 0) return;

		const table = el.createEl("table", { cls: "class-sync-dash-table" });
		const tr = table.createEl("thead").createEl("tr");
		for (const h of [t("이름"), t("학생 ID"), t("Mirror DB"), t("비고")]) tr.createEl("th", { text: h });
		const tb = table.createEl("tbody");
		for (const e of list) {
			const row = tb.createEl("tr");
			row.createEl("td", { text: e.name || "—" });
			row.createEl("td", { text: e.id });
			row.createEl("td", { text: e.remoteDb });
			const note = e.emptyName ? t("이름 없음(제외)") : e.adjusted ? t("ID 조정됨") : "";
			const n = row.createEl("td", { text: note });
			if (e.emptyName) n.addClass("class-sync-dash-conflict");
		}
	}

	private async confirm(): Promise<void> {
		const students: StudentConfig[] = this.entries()
			.filter((e) => !e.emptyName)
			.map((e) => ({ studentId: e.id, studentName: e.name, remoteDb: e.remoteDb, localRoot: "", username: "" }));
		if (students.length === 0) {
			new Notice(t("Class Sync: 추가할 학생이 없습니다."));
			return;
		}
		this.close();
		await this.onConfirm(students);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
