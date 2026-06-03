import { App } from "obsidian";
import { Logger } from "../../core/log/Logger";
import { FeedbackStore } from "../../core/feedback/FeedbackStore";
import { ClassSyncSettings, SharedSpace } from "../../settings/types";
import { LinkStatus } from "../../core/sync/MirrorContext";
import { CopyOptions, CopyResult } from "../../modes/teacher/BulkCopy";

/** 통합 패널 탭 식별자. */
export type PanelTab = "feedback" | "deploy" | "sync" | "manage" | "log";

/** 동기화 상태 표 한 행(링크별). */
export interface DashboardRow extends LinkStatus {
	studentName: string;
	studentId: string;
	remoteDb: string;
	localRoot: string;
	conflicts: number;
}

/**
 * 패널 섹션이 플러그인에 요구하는 동작 모음. ClassSyncPlugin이 구현한다.
 * 명령(cmd+P)과 패널 버튼이 같은 메서드를 공유한다.
 */
export interface PanelHost {
	app: App;
	settings: ClassSyncSettings;
	logger: Logger;
	feedbackStore: FeedbackStore;
	getDashboardRows(): Promise<DashboardRow[]>;
	openConflictModal(): void;
	fullSync(dir: "both" | "up" | "down"): Promise<void>;
	toggleAutoSync(): Promise<void>;
	testConnection(): Promise<void>;
	runDiagnostics(): Promise<void>;
	resetLocalCache(): Promise<void>;
	realtimeStatus(): Promise<void>;
	openResetModal(): void;
	refreshShares(): Promise<void>;
	/** 원본 경로(파일/폴더)를 선택 학생들에게 복사. 기술문서 §20. */
	bulkCopy(sourcePath: string, opts: CopyOptions, studentIds: string[]): Promise<CopyResult & { error?: string }>;
	deployShared(space: SharedSpace): Promise<void>;
}

/** 탭 콘텐츠 렌더러. 탭 전환 시 render→dispose 로 교체된다(구독·interval은 dispose에서 해제). */
export interface PanelSection {
	render(container: HTMLElement): void | Promise<void>;
	dispose(): void;
}

/** 패널 액션 버튼 헬퍼. */
export function panelButton(
	parent: HTMLElement,
	label: string,
	onClick: () => void | Promise<void>,
	opts?: { warning?: boolean; cta?: boolean },
): HTMLButtonElement {
	const b = parent.createEl("button", { text: label });
	if (opts?.warning) b.addClass("mod-warning");
	if (opts?.cta) b.addClass("mod-cta");
	b.onclick = () => void onClick();
	return b;
}
