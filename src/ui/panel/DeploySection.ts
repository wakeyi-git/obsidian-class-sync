import { Notice, Setting, TFile, TFolder } from "obsidian";
import { PanelHost, PanelSection, panelButton } from "./PanelSection";
import { ExistingPolicy, CopyResult, CopyPlan } from "../../modes/teacher/BulkCopy";
import { t } from "../../i18n";

/** 배포 탭(교사) — 경로 선택 복사(현재 파일/폴더 빠른 입력) + 공유 공간 배포. 기술문서 §20. */
export class DeploySection implements PanelSection {
	private container: HTMLElement | null = null;
	private sourcePath = "";
	private destPath = "";
	private policy: ExistingPolicy = "skip";
	private substitute = true;
	private selected = new Set<string>();
	private infoEl: HTMLElement | null = null;
	private lastPlan: CopyPlan | null = null;
	private lastResult: (CopyResult & { error?: string }) | null = null;

	constructor(private host: PanelHost) {
		for (const st of host.settings.students) if (st.studentId) this.selected.add(st.studentId);
	}

	render(container: HTMLElement): void {
		this.container = container;
		container.empty();
		container.addClass("class-sync-panel-section");

		this.renderCopy(container);
		this.renderShared(container);
	}

	dispose(): void {
		this.container = null;
		this.infoEl = null;
	}

	// --- 학생에게 복사 ---

	private renderCopy(container: HTMLElement): void {
		container.createDiv({ cls: "class-sync-panel-label", text: t("학생에게 복사") });

		const students = this.host.settings.students.filter((st) => st.studentId);
		if (students.length === 0) {
			container.createDiv({ cls: "class-sync-feedback-empty", text: t("설정에서 학생을 먼저 추가하세요.") });
			return;
		}

		new Setting(container)
			.setName(t("원본 경로"))
			.setDesc(t("복사할 파일 또는 폴더 경로"))
			.addText((txt) =>
				txt
					.setPlaceholder(t("예: 템플릿/오늘의_활동.md"))
					.setValue(this.sourcePath)
					.onChange((v) => {
						this.sourcePath = v.trim();
						this.updateInfo();
					}),
			);

		const quick = container.createDiv({ cls: "class-sync-panel-actions" });
		panelButton(quick, t("현재 파일"), () => this.fillCurrent("file"));
		panelButton(quick, t("현재 폴더"), () => this.fillCurrent("folder"));

		this.infoEl = container.createDiv({ cls: "class-sync-panel-hint" });
		this.updateInfo();

		const srcFile = this.host.app.vault.getAbstractFileByPath(this.sourcePath);
		new Setting(container)
			.setName(t("대상 경로 (비우면 원본 이름)"))
			.setDesc(t("각 학생 폴더 안의 경로. 폴더 복사 시 무시됩니다."))
			.addText((txt) =>
				txt
					.setPlaceholder(srcFile instanceof TFile ? srcFile.name : t("오늘의_활동.md"))
					.setValue(this.destPath)
					.onChange((v) => (this.destPath = v.trim())),
			);

		new Setting(container).setName(t("기존 파일 처리")).addDropdown((dd) =>
			dd
				.addOption("skip", t("건너뛰기"))
				.addOption("overwrite", t("덮어쓰기"))
				.addOption("rename", t("새 이름으로"))
				.setValue(this.policy)
				.onChange((v) => (this.policy = v as ExistingPolicy)),
		);

		new Setting(container)
			.setName(t("템플릿 변수 치환"))
			.setDesc(t("{{studentName}} {{studentId}} {{classId}} {{date}} 를 학생별로 치환"))
			.addToggle((tg) => tg.setValue(this.substitute).onChange((v) => (this.substitute = v)));

		const head = new Setting(container).setName(t("대상 학생 ({count}명)", { count: students.length }));
		head.addButton((b) => b.setButtonText(t("전체")).onClick(() => this.setAll(true)));
		head.addButton((b) => b.setButtonText(t("해제")).onClick(() => this.setAll(false)));
		for (const st of students) {
			new Setting(container)
				.setName(st.studentName || st.studentId)
				.setDesc(st.localRoot || "")
				.addToggle((tg) =>
					tg.setValue(this.selected.has(st.studentId)).onChange((v) => {
						if (v) this.selected.add(st.studentId);
						else this.selected.delete(st.studentId);
					}),
				);
		}

		const runRow = container.createDiv({ cls: "class-sync-panel-actions" });
		panelButton(runRow, t("미리보기"), () => this.runPreview());
		panelButton(runRow, t("학생에게 복사"), () => this.runCopy(), { cta: true });

		this.renderResult(container);
	}

	/** 직전 미리보기/실행 결과를 패널에 유지해 보여준다. */
	private renderResult(container: HTMLElement): void {
		if (this.lastPlan) {
			const plan = this.lastPlan;
			container.createDiv({ cls: "class-sync-panel-label", text: t("미리보기") });
			const table = container.createEl("table", { cls: "class-sync-dash-table" });
			const tr = table.createEl("thead").createEl("tr");
			for (const h of [t("학생"), t("생성"), t("덮어씀"), t("건너뜀"), t("새 이름")]) tr.createEl("th", { text: h });
			const tb = table.createEl("tbody");
			for (const sp of plan.students) {
				const c = { create: 0, overwrite: 0, skip: 0, rename: 0 };
				for (const e of sp.entries) c[e.action]++;
				const row = tb.createEl("tr");
				row.createEl("td", { text: sp.studentName || sp.studentId });
				row.createEl("td", { text: String(c.create) });
				row.createEl("td", { text: String(c.overwrite) });
				row.createEl("td", { text: String(c.skip) });
				row.createEl("td", { text: String(c.rename) });
			}
			if (plan.sampleAfter !== undefined) {
				container.createDiv({ cls: "class-sync-panel-hint", text: t("치환 결과 미리보기(첫 학생):") });
				container.createEl("pre", { cls: "class-sync-deploy-sample", text: plan.sampleAfter });
			}
		}

		if (this.lastResult && !this.lastResult.error) {
			const res = this.lastResult;
			container.createDiv({ cls: "class-sync-panel-label", text: t("복사 결과") });
			const table = container.createEl("table", { cls: "class-sync-dash-table" });
			const tr = table.createEl("thead").createEl("tr");
			for (const h of [t("학생"), t("작성"), t("건너뜀"), t("결과")]) tr.createEl("th", { text: h });
			const tb = table.createEl("tbody");
			for (const d of res.details) {
				const row = tb.createEl("tr");
				row.createEl("td", { text: d.studentName || d.studentId });
				row.createEl("td", { text: String(d.written) });
				row.createEl("td", { text: String(d.skipped) });
				const note = row.createEl("td", { text: d.error ? t("실패") : "✓" });
				if (d.error) {
					note.addClass("class-sync-dash-conflict");
					note.setAttribute("title", d.error);
				}
			}
			const failed = res.details.filter((d) => d.error).map((d) => d.studentId);
			if (failed.length > 0) {
				const row = container.createDiv({ cls: "class-sync-panel-actions" });
				panelButton(row, t("실패한 {n}명만 재시도", { n: failed.length }), () => this.runCopy(failed), { warning: true });
			}
		}
	}

	private fillCurrent(kind: "file" | "folder"): void {
		const f = this.host.app.workspace.getActiveFile();
		if (!f) {
			new Notice(t("Class Sync: 열린 파일이 없습니다."));
			return;
		}
		// 원본만 채운다. 대상 경로는 비워두면 복사 시 원본 이름으로 자동 적용되므로,
		// 다시 눌러 다른 파일을 가리켜도 (이전 파일명이 남지 않고) 새 파일 이름이 쓰인다.
		this.sourcePath = kind === "file" ? f.path : f.parent?.path ?? "";
		if (this.container) this.render(this.container);
	}

	private updateInfo(): void {
		const el = this.infoEl;
		if (!el) return;
		if (!this.sourcePath) {
			el.setText(t("경로를 입력하거나 위 버튼으로 채우세요."));
			return;
		}
		const src = this.host.app.vault.getAbstractFileByPath(this.sourcePath);
		if (src instanceof TFolder) el.setText(t("폴더 — 하위 markdown 전체 복사"));
		else if (src instanceof TFile) el.setText(t("파일 — 대상 경로 비우면 ‘{name}’로 복사", { name: src.name }));
		else el.setText(t("경로를 찾을 수 없습니다: {path}", { path: this.sourcePath }));
	}

	private setAll(v: boolean): void {
		this.selected.clear();
		if (v) for (const st of this.host.settings.students) if (st.studentId) this.selected.add(st.studentId);
		if (this.container) this.render(this.container);
	}

	private opts() {
		return { destPath: this.destPath, policy: this.policy, substitute: this.substitute };
	}

	/** 선택/원본 검증 후 대상 학생 ID 반환(없으면 null + Notice). */
	private targetIds(override?: string[]): string[] | null {
		if (!this.sourcePath) {
			new Notice(t("Class Sync: 원본 경로를 입력하세요."));
			return null;
		}
		const ids = override ?? [...this.selected];
		if (ids.length === 0) {
			new Notice(t("Class Sync: 대상 학생을 선택하세요."));
			return null;
		}
		return ids;
	}

	private async runPreview(): Promise<void> {
		const ids = this.targetIds();
		if (!ids) return;
		const plan = await this.host.bulkCopyPreview(this.sourcePath, this.opts(), ids);
		if (plan.error) {
			new Notice(t("미리보기 실패: {error}", { error: plan.error }));
			return;
		}
		this.lastPlan = plan;
		this.lastResult = null;
		if (this.container) this.render(this.container);
	}

	private async runCopy(override?: string[]): Promise<void> {
		const ids = this.targetIds(override);
		if (!ids) return;
		const res = await this.host.bulkCopy(this.sourcePath, this.opts(), ids);
		this.lastResult = res;
		this.lastPlan = null;
		if (res.error) new Notice(t("복사 실패: {error}", { error: res.error }));
		else new Notice(t("복사 완료: {written}개 작성, {skipped}개 건너뜀", { written: res.written, skipped: res.skipped }));
		if (this.container) this.render(this.container);
	}

	// --- 공유 공간 배포 ---

	private renderShared(container: HTMLElement): void {
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
				if (this.container) this.render(this.container);
			});
		}
	}
}
