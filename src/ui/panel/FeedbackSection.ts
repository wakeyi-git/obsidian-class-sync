import { App, EventRef, Notice } from "obsidian";
import { FeedbackStore } from "../../core/feedback/FeedbackStore";
import { FeedbackDoc } from "../../core/model/types";
import { PanelSection } from "./PanelSection";
import { promptAddFeedback, resolveMarkdownView } from "../FeedbackView";

/** 피드백 탭 — 활성 노트의 앵커 댓글(§19.5). (구 FeedbackView 본문) */
export class FeedbackSection implements PanelSection {
	private listEl: HTMLElement | null = null;
	private currentPath: string | null = null;
	private renderedPath: string | null = null;
	private unsubscribe: (() => void) | null = null;
	private refs: EventRef[] = [];
	private renderSeq = 0;

	constructor(private app: App, private store: FeedbackStore) {}

	render(container: HTMLElement): void {
		container.addClass("class-sync-feedback");

		const toolbar = container.createDiv({ cls: "class-sync-feedback-toolbar" });
		const addBtn = toolbar.createEl("button", { text: "＋ 피드백 추가" });
		addBtn.onclick = () => promptAddFeedback(this.app, this.store, this.currentPath);

		this.listEl = container.createDiv({ cls: "class-sync-feedback-list" });

		this.refs.push(this.app.workspace.on("active-leaf-change", () => this.onLeafChange()));
		this.refs.push(this.app.workspace.on("file-open", () => this.onLeafChange()));
		this.unsubscribe = this.store.onChange(() => void this.renderList());

		void this.renderList();
	}

	dispose(): void {
		this.unsubscribe?.();
		this.unsubscribe = null;
		for (const r of this.refs) this.app.workspace.offref(r);
		this.refs = [];
		this.listEl = null;
		this.renderedPath = null;
	}

	/** 활성 파일이 실제로 바뀐 경우에만 재렌더(패널 포커스 등 동일 파일이면 건드리지 않음). */
	private onLeafChange(): void {
		const path = this.app.workspace.getActiveFile()?.path ?? null;
		if (path === this.renderedPath) return;
		void this.renderList();
	}

	private async renderList(): Promise<void> {
		if (!this.listEl) return;
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
		if (seq !== this.renderSeq || !this.listEl) return;
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
			quote.onclick = () => void this.jumpTo(doc);
		}
		card.createDiv({ cls: "class-sync-feedback-content", text: doc.content });

		const actions = card.createDiv({ cls: "class-sync-feedback-actions" });
		actions.createEl("button", { text: "위치로" }).onclick = () => void this.jumpTo(doc);
		actions.createEl("button", { text: doc.resolved ? "되돌리기" : "해결" }).onclick = async () => {
			await this.store.setResolved(path, doc, !doc.resolved);
		};
		const del = actions.createEl("button", { cls: "mod-warning", text: "삭제" });
		del.onclick = async () => {
			await this.store.remove(path, doc);
		};
	}

	/** 앵커 위치로 에디터 스크롤/선택. textQuote 재탐색 후 없으면 오프셋 폴백. */
	private async jumpTo(doc: FeedbackDoc): Promise<void> {
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

		await view.leaf.openFile(view.file, { active: true, eState: { line: from.line } });
		editor.focus();
		editor.setSelection(from, to);
		editor.scrollIntoView({ from, to }, true);
	}
}
