import { App, MarkdownView, Modal, Notice, Setting } from "obsidian";
import { FeedbackStore } from "../core/feedback/FeedbackStore";
import { t } from "../i18n";

/**
 * 피드백 레이어(§19.5) 공용 헬퍼. UI 본문은 통합 패널의 FeedbackSection이 담당하며,
 * 여기서는 피드백 추가 흐름과 대상 에디터 해석을 명령·패널이 함께 쓰도록 제공한다.
 */

/**
 * 대상 markdown 뷰 해석. 활성 뷰가 노트면 그걸 쓰고, (패널 버튼처럼) 활성이 노트가 아니면
 * preferredPath와 일치하는 열린 markdown 리프를 찾는다.
 */
export function resolveMarkdownView(app: App, preferredPath?: string | null): MarkdownView | null {
	const active = app.workspace.getActiveViewOfType(MarkdownView);
	if (active?.file && (!preferredPath || active.file.path === preferredPath)) return active;
	if (preferredPath) {
		for (const leaf of app.workspace.getLeavesOfType("markdown")) {
			const v = leaf.view;
			if (v instanceof MarkdownView && v.file?.path === preferredPath) return v;
		}
	}
	return active ?? null;
}

/** 활성 에디터의 선택 영역으로 피드백을 추가하는 공용 흐름(패널 버튼 + 명령에서 재사용). */
export function promptAddFeedback(app: App, store: FeedbackStore, preferredPath?: string | null): void {
	const view = resolveMarkdownView(app, preferredPath);
	if (!view || !view.file) {
		new Notice(t("Class Sync: 피드백을 달 노트를 먼저 여세요."));
		return;
	}
	const path = view.file.path;
	if (!store.canAnnotate(path)) {
		new Notice(t("Class Sync: 이 노트는 동기화 대상이 아니라 피드백을 저장할 수 없습니다."));
		return;
	}
	const editor = view.editor;
	const sel = editor.getSelection();
	if (!sel) {
		new Notice(t("Class Sync: 본문에서 피드백 대상 텍스트를 선택하세요."));
		return;
	}
	const start = editor.posToOffset(editor.getCursor("from"));
	const end = start + sel.length;
	new FeedbackInputModal(app, sel, async (content) => {
		const ok = await store.add(path, { textQuote: sel, start, end }, content);
		if (ok) new Notice(t("Class Sync: 피드백을 추가했습니다."));
	}).open();
}

/** 피드백 내용 입력 모달. */
class FeedbackInputModal extends Modal {
	private value = "";
	constructor(app: App, private quote: string, private onSubmit: (content: string) => void | Promise<void>) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: t("피드백 추가") });
		contentEl.createDiv({ cls: "class-sync-feedback-quote", text: `“${this.quote}”` });

		const ta = contentEl.createEl("textarea", { cls: "class-sync-feedback-input" });
		ta.rows = 4;
		ta.placeholder = t("피드백 내용을 입력하세요.");
		ta.oninput = () => (this.value = ta.value);
		window.setTimeout(() => ta.focus(), 0);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText(t("취소")).onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText(t("추가"))
					.setCta()
					.onClick(async () => {
						const v = this.value.trim();
						if (!v) {
							new Notice(t("Class Sync: 내용을 입력하세요."));
							return;
						}
						this.close();
						await this.onSubmit(v);
					}),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
