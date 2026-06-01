import { Compartment, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

/**
 * Obsidian(CodeMirror6) 에디터에 Yjs 바인딩을 동적으로 붙였다 뗐다 한다.
 *
 * 전역 editor extension으로 Compartment 하나를 등록해 두고(빈 확장),
 * 특정 EditorView에 대해 compartment를 yCollab으로 reconfigure하면 그 에디터만 실시간 바인딩된다.
 */
const rtCompartment = new Compartment();

/** plugin.registerEditorExtension(...)에 넘길 전역 확장. 처음엔 빈 상태. */
export function realtimeEditorExtension(): Extension {
	return rtCompartment.of([]);
}

/** 해당 뷰에 Y.Text ↔ 에디터 실시간 바인딩 부착. */
export function bindView(view: EditorView, ytext: Y.Text, awareness: Awareness): void {
	view.dispatch({ effects: rtCompartment.reconfigure(yCollab(ytext, awareness)) });
}

/** 해당 뷰의 실시간 바인딩 해제. */
export function unbindView(view: EditorView): void {
	view.dispatch({ effects: rtCompartment.reconfigure([]) });
}
