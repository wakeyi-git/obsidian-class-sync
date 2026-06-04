import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { ExcalidrawBinding as YExcalidrawBinding } from "y-excalidraw";
import { PresenceChips } from "./presenceChips";

/** Excalidraw imperative API 중 우리가 쓰는 부분(obsidian-excalidraw-plugin의 getExcalidrawAPI() 반환). */
export interface ExcalidrawImperativeApi {
	onChange(cb: (elements: readonly any[], appState: any, files: any) => void): () => void;
	updateScene(scene: any): void;
	getSceneElements(): readonly any[];
	getAppState?(): any;
	addFiles?(files: any[]): void;
}

interface BindOpts {
	awareness?: Awareness;
	containerEl?: HTMLElement;
}

/**
 * Yjs ↔ Excalidraw 바인딩. 요소 reconciliation·이미지 asset·collaborators 커서는 y-excalidraw가 처리한다.
 * 커서는 imperative API에 연속 포인터 이벤트가 없어, 캔버스 pointermove → 씬 좌표 → binding.onPointerUpdate로 먹인다.
 * 독립 뷰포트: 각자 줌/스크롤은 자유, 요소·커서는 씬 좌표로 공유.
 */
export class ExcalidrawBinding {
	private inner: YExcalidrawBinding;
	private awareness: Awareness | null;
	private containerEl: HTMLElement | null;
	private onPointerMove: ((e: PointerEvent) => void) | null = null;
	private lastSent = 0;
	private chips: PresenceChips | null = null;

	constructor(
		yElements: Y.Array<Y.Map<any>>,
		yAssets: Y.Map<any>,
		private api: ExcalidrawImperativeApi,
		opts?: BindOpts,
	) {
		this.awareness = opts?.awareness ?? null;
		this.containerEl = opts?.containerEl ?? null;

		// undo/redo 통합(undoConfig)은 생략한다 — y-excalidraw의 setupUndoRedo가 Obsidian DOM에서
		// undo 버튼을 querySelector로 찾는데 없어서 addEventListener(null)로 크래시하기 때문.
		// 생성자는 yElements를 씬에 적용한다(updateScene). 시더(빈 yElements)면 씬이 비워지므로,
		// 생성 직전 씬을 캡처해 두었다가 다시 적용해 시드한다.
		const sceneBefore = this.api.getSceneElements();
		this.inner = new YExcalidrawBinding(yElements, yAssets, this.api as any, this.awareness ?? undefined, undefined);
		if (sceneBefore.length > 0 && yElements.length === 0) {
			this.api.updateScene({ elements: [...sceneBefore] }); // onChange → y-excalidraw가 yElements로 캡처
		}

		// 로컬 포인터 → 커서(awareness) 브로드캐스트. y-excalidraw가 원격 collaborators로 렌더(이름·색).
		if (this.awareness && this.containerEl) {
			this.onPointerMove = (e: PointerEvent) => {
				const now = Date.now();
				if (now - this.lastSent < 40) return;
				this.lastSent = now;
				const pt = this.toScene(e.clientX, e.clientY);
				if (!pt) return;
				this.inner.onPointerUpdate({ pointer: { x: pt.x, y: pt.y, tool: "pointer" }, button: "up" });
			};
			this.containerEl.addEventListener("pointermove", this.onPointerMove);
		}

		// 참가자 칩 오버레이: 포인터(커서)에 의존하지 않고 현재 편집자 이름을 항상 표시.
		// 터치 기기(태블릿/모바일)는 손을 떼면 커서 라벨이 사라지므로, 모서리에 상시 목록을 띄운다.
		if (this.awareness && this.containerEl) {
			this.chips = new PresenceChips(this.containerEl, this.awareness);
		}
	}

	/** viewport(client) → scene 좌표. 캔버스 실제 위치(rect) + appState(scroll/zoom) 사용. */
	private toScene(clientX: number, clientY: number): { x: number; y: number } | null {
		const st = this.api.getAppState?.();
		if (!st) return null;
		const zoom = st.zoom?.value ?? 1;
		const el = this.containerEl?.querySelector("canvas") ?? this.containerEl;
		const rect = el?.getBoundingClientRect();
		if (!rect) return null;
		return {
			x: (clientX - rect.left) / zoom - (st.scrollX ?? 0),
			y: (clientY - rect.top) / zoom - (st.scrollY ?? 0),
		};
	}

	destroy(): void {
		if (this.onPointerMove && this.containerEl) {
			this.containerEl.removeEventListener("pointermove", this.onPointerMove);
		}
		this.chips?.destroy();
		try {
			this.inner.destroy();
		} catch {
			/* noop */
		}
		this.onPointerMove = null;
		this.chips = null;
	}
}
