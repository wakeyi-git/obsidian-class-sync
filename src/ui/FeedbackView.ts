import { App, ItemView, MarkdownView, Modal, Notice, Setting, WorkspaceLeaf } from "obsidian";
import { FeedbackStore } from "../core/feedback/FeedbackStore";
import { FeedbackDoc } from "../core/model/types";

export const FEEDBACK_VIEW_TYPE = "class-sync-feedback-view";

/** 활성 노트의 피드백 레이어(§19.5)를 보여주는 사이드 패널. 본문을 고치지 않고 앵커 기반 댓글을 단다. */
export class FeedbackView extends ItemView {
	private listEl: HTMLElement | null = null;
	private currentPath: string | null = null;
	private renderedPath: string | null = null; // 마지막으로 렌더한 파일(불필요한 재렌더 방지)
	private unsubscribe: (() => void) | null = null;
	private renderSeq = 0;

	constructor(leaf: WorkspaceLeaf, private store: FeedbackStore) {
		super(leaf);
	}

	getViewType(): string {
		return FEEDBACK_VIEW_TYPE;
	}
	getDisplayText(): string {
		return "Class Sync 피드백";
	}
	getIcon(): string {
		return "message-square";
	}

	async onOpen(): Promise<void> {
		const c = this.contentEl;
		c.empty();
		c.addClass("class-sync-feedback");

		const toolbar = c.createDiv({ cls: "class-sync-feedback-toolbar" });
		const addBtn = toolbar.createEl("button", { text: "＋ 피드백 추가" });
		// 패널 버튼 클릭 시 활성 리프가 이 패널이 되므로, 추적 중인 노트 경로를 넘겨 대상 에디터를 찾는다.
		addBtn.onclick = () => promptAddFeedback(this.app, this.store, this.currentPath);

		this.listEl = c.createDiv({ cls: "class-sync-feedback-list" });

		// 리프 변경 시 활성 파일이 실제로 바뀐 경우에만 재렌더(패널 포커스로 카드가 사라져 첫 클릭이 무시되던 문제 방지).
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.onLeafChange()));
		this.registerEvent(this.app.workspace.on("file-open", () => this.onLeafChange()));
		// 피드백 변경(추가/해결/삭제, 원격 동기화)은 현재 파일 그대로 강제 새로고침.
		this.unsubscribe = this.store.onChange(() => void this.render());

		await this.render();
	}

	async onClose(): Promise<void> {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** 리프 변경: 활성 파일이 실제로 바뀐 경우에만 재렌더(패널 포커스 등 동일 파일이면 건드리지 않음). */
	private onLeafChange(): void {
		const path = this.app.workspace.getActiveFile()?.path ?? null;
		if (path === this.renderedPath) return;
		void this.render();
	}

	private async render(): Promise<void> {
		if (!this.listEl) return;
		// 동시 호출(active-leaf-change + file-open + onChange) 시 마지막 렌더만 DOM에 반영(중복 방지).
		const seq = ++this.renderSeq;
		const file = this.app.workspace.getActiveFile();
		this.currentPath = file?.path ?? null;

		const writeEmpty = (text: string): void => {
			if (seq !== this.renderSeq || !this.listEl) return;
			this.listEl.empty();
			this.listEl.createDiv({ cls: "class-sync-feedback-empty", text });
			this.renderedPath = this.currentPath;
		};

		if (!this.currentPath || !file || file.extension !== "md") {
			writeEmpty("노트를 열면 피드백이 표시됩니다.");
			return;
		}
		if (!this.store.canAnnotate(this.currentPath)) {
			writeEmpty("이 노트는 동기화 대상이 아닙니다.");
			return;
		}

		const items = await this.store.listFor(this.currentPath);
		if (seq !== this.renderSeq || !this.listEl) return; // 더 최신 렌더가 시작됨 → 폐기
		this.listEl.empty();
		this.renderedPath = this.currentPath;
		if (items.length === 0) {
			this.listEl.createDiv({
				cls: "class-sync-feedback-empty",
				text: "피드백이 없습니다. 본문에서 텍스트를 선택하고 ‘＋ 피드백 추가’를 누르세요.",
			});
			return;
		}
		for (const doc of items) this.renderItem(doc);
	}

	private renderItem(doc: FeedbackDoc): void {
		if (!this.listEl) return;
		const path = this.currentPath!;
		const card = this.listEl.createDiv({ cls: `class-sync-feedback-card${doc.resolved ? " is-resolved" : ""}` });

		const head = card.createDiv({ cls: "class-sync-feedback-head" });
		const who = doc.createdByRole === "teacher" ? "교사" : "학생";
		head.createSpan({ cls: "class-sync-feedback-author", text: `${who} · ${doc.createdBy}` });
		head.createSpan({ cls: "class-sync-feedback-time", text: new Date(doc.createdAt).toLocaleString() });
		if (doc.resolved) head.createSpan({ cls: "class-sync-feedback-badge", text: "해결됨" });

		if (doc.anchor.textQuote) {
			const quote = card.createDiv({ cls: "class-sync-feedback-quote", text: `“${doc.anchor.textQuote}”` });
			quote.onclick = () => this.jumpTo(doc);
		}
		card.createDiv({ cls: "class-sync-feedback-content", text: doc.content });

		const actions = card.createDiv({ cls: "class-sync-feedback-actions" });
		const jump = actions.createEl("button", { text: "위치로" });
		jump.onclick = () => this.jumpTo(doc);
		const toggle = actions.createEl("button", { text: doc.resolved ? "되돌리기" : "해결" });
		toggle.onclick = async () => {
			await this.store.setResolved(path, doc, !doc.resolved);
		};
		const del = actions.createEl("button", { cls: "mod-warning", text: "삭제" });
		del.onclick = async () => {
			await this.store.remove(path, doc);
		};
	}

	/** 앵커 위치로 에디터 스크롤/선택. textQuote 재탐색 후 없으면 오프셋 폴백. */
	private async jumpTo(doc: FeedbackDoc): Promise<void> {
		// 패널 버튼 클릭 시 활성 리프가 패널이 되므로, 추적 중인 경로로 노트 리프를 찾는다.
		const view = resolveMarkdownView(this.app, this.currentPath);
		if (!view || !view.file || view.file.path !== this.currentPath) {
			new Notice("Class Sync: 해당 노트를 편집 모드로 열어 주세요.");
			return;
		}
		const editor = view.editor;
		const content = editor.getValue();
		let idx = doc.anchor.textQuote ? content.indexOf(doc.anchor.textQuote) : -1;
		if (idx < 0) idx = Math.min(doc.anchor.start, content.length);
		const len = doc.anchor.textQuote ? doc.anchor.textQuote.length : 0;
		const from = editor.offsetToPos(idx);
		const to = editor.offsetToPos(Math.min(idx + len, content.length));

		// 리프 활성화 + 라인 스크롤을 Obsidian 기본 동작(eState)으로 한 번에 처리(미측정 에디터에서도 신뢰성↑).
		await view.leaf.openFile(view.file, { active: true, eState: { line: from.line } });
		editor.focus();
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
	}
}

/**
 * 대상 markdown 뷰 해석. 활성 뷰가 노트면 그걸 쓰고, (패널 버튼처럼) 활성이 노트가 아니면
 * preferredPath와 일치하는 열린 markdown 리프를 찾는다.
 */
function resolveMarkdownView(app: App, preferredPath?: string | null): MarkdownView | null {
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
		new Notice("Class Sync: 피드백을 달 노트를 먼저 여세요.");
		return;
	}
	const path = view.file.path;
	if (!store.canAnnotate(path)) {
		new Notice("Class Sync: 이 노트는 동기화 대상이 아니라 피드백을 저장할 수 없습니다.");
		return;
	}
	const editor = view.editor;
	const sel = editor.getSelection();
	if (!sel) {
		new Notice("Class Sync: 본문에서 피드백 대상 텍스트를 선택하세요.");
		return;
	}
	const start = editor.posToOffset(editor.getCursor("from"));
	const end = start + sel.length;
	new FeedbackInputModal(app, sel, async (content) => {
		const ok = await store.add(path, { textQuote: sel, start, end }, content);
		if (ok) new Notice("Class Sync: 피드백을 추가했습니다.");
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
		contentEl.createEl("h3", { text: "피드백 추가" });
		contentEl.createDiv({ cls: "class-sync-feedback-quote", text: `“${this.quote}”` });

		const ta = contentEl.createEl("textarea", { cls: "class-sync-feedback-input" });
		ta.rows = 4;
		ta.placeholder = "피드백 내용을 입력하세요.";
		ta.oninput = () => (this.value = ta.value);
		window.setTimeout(() => ta.focus(), 0);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("취소").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("추가")
					.setCta()
					.onClick(async () => {
						const v = this.value.trim();
						if (!v) {
							new Notice("Class Sync: 내용을 입력하세요.");
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
