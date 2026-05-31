import { App, Modal, Notice, Setting, TFile, TFolder } from "obsidian";
import { StudentConfig } from "../settings/types";
import { CopyOptions, CopyResult, ExistingPolicy } from "../modes/teacher/BulkCopy";

export interface BulkCopyRunner {
	students: StudentConfig[];
	run(targets: StudentConfig[], opts: CopyOptions): Promise<CopyResult>;
}

/** 교사 → 학생 복사 옵션 모달. 기술문서 §20. */
export class BulkCopyModal extends Modal {
	private selected = new Set<string>();
	private destPath: string;
	private policy: ExistingPolicy = "skip";
	private substitute = true;

	constructor(
		app: App,
		private source: TFile | TFolder,
		private runner: BulkCopyRunner,
	) {
		super(app);
		this.destPath = source instanceof TFile ? source.name : "";
		for (const st of runner.students) this.selected.add(st.studentId);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const isFolder = this.source instanceof TFolder;
		contentEl.createEl("h2", { text: isFolder ? "폴더를 학생에게 복사" : "파일을 학생에게 복사" });
		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: `원본: ${this.source.path}${isFolder ? " (하위 markdown 전체)" : ""}`,
		});

		if (!isFolder) {
			new Setting(contentEl)
				.setName("대상 경로")
				.setDesc("각 학생 폴더 안의 경로. 예: 오늘의_활동.md, 수업/1차시.md")
				.addText((t) => t.setValue(this.destPath).onChange((v) => (this.destPath = v.trim())));
		}

		new Setting(contentEl)
			.setName("기존 파일 처리")
			.setDesc("대상에 같은 파일이 있을 때. 기본: 건너뛰기 (기술문서 §20.3)")
			.addDropdown((dd) =>
				dd
					.addOption("skip", "건너뛰기")
					.addOption("overwrite", "덮어쓰기")
					.addOption("rename", "새 이름으로")
					.setValue(this.policy)
					.onChange((v) => (this.policy = v as ExistingPolicy)),
			);

		new Setting(contentEl)
			.setName("템플릿 변수 치환")
			.setDesc("{{studentName}} {{studentId}} {{classId}} {{date}} 를 학생별로 치환 (기술문서 §20.4)")
			.addToggle((t) => t.setValue(this.substitute).onChange((v) => (this.substitute = v)));

		// 대상 학생
		contentEl.createEl("h3", { text: "대상 학생" });
		const head = new Setting(contentEl).setName(`${this.runner.students.length}명`);
		head.addButton((b) => b.setButtonText("전체").onClick(() => this.setAll(true)));
		head.addButton((b) => b.setButtonText("전체 해제").onClick(() => this.setAll(false)));

		for (const st of this.runner.students) {
			new Setting(contentEl).setName(st.studentName || st.studentId).setDesc(st.localRoot).addToggle((t) =>
				t.setValue(this.selected.has(st.studentId)).onChange((v) => {
					if (v) this.selected.add(st.studentId);
					else this.selected.delete(st.studentId);
				}),
			);
		}

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("복사")
				.setCta()
				.onClick(() => void this.execute()),
		);
	}

	private setAll(v: boolean): void {
		this.selected.clear();
		if (v) for (const st of this.runner.students) this.selected.add(st.studentId);
		this.onOpen(); // 재렌더
	}

	private async execute(): Promise<void> {
		const targets = this.runner.students.filter((st) => this.selected.has(st.studentId));
		if (targets.length === 0) {
			new Notice("대상 학생을 선택하세요.");
			return;
		}
		if (!(this.source instanceof TFolder) && !this.destPath) {
			new Notice("대상 경로를 입력하세요.");
			return;
		}
		try {
			const res = await this.runner.run(targets, {
				destPath: this.destPath,
				policy: this.policy,
				substitute: this.substitute,
			});
			new Notice(`복사 완료: ${res.written}개 작성, ${res.skipped}개 건너뜀`);
			this.close();
		} catch (e) {
			new Notice(`복사 실패: ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
