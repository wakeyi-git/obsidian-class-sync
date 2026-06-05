import { App } from "obsidian";
import { Logger } from "../../core/log/Logger";
import { FeedbackStore } from "../../core/feedback/FeedbackStore";
import { ClassSyncSettings, SharedSpace } from "../../settings/types";
import { LinkStatus } from "../../core/sync/MirrorContext";
import { DeletedItem, RestoreResult, RestoreOptions, DeleteModifyChoice } from "../../core/sync/RestoreManager";
import { PurgeSnapshot } from "../../core/sync/recentPurge";
import { DeleteModifyItem } from "../../core/sync/deleteModifyQueue";
import { CopyOptions, CopyResult, CopyPlan } from "../../modes/teacher/BulkCopy";

/** 통합 패널 탭 식별자. */
export type PanelTab = "setup" | "feedback" | "deploy" | "sync" | "manage" | "recovery" | "log";

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
	/** 플러그인 설정 탭 열기(대시보드 조치 카드 CTA용). */
	openSettings(): void;
	/** 통합 패널의 특정 탭 열기(마법사 → 대시보드 등). */
	activatePanel(tab?: PanelTab): Promise<void>;
	/** 교사 온보딩 완료 표시(마법사 자동 노출 중단). */
	completeOnboarding(): Promise<void>;
	/** 원본 경로(파일/폴더)를 선택 학생들에게 복사. 기술문서 §20. */
	bulkCopy(sourcePath: string, opts: CopyOptions, studentIds: string[]): Promise<CopyResult & { error?: string }>;
	/** 배포 미리보기(dry-run). */
	bulkCopyPreview(sourcePath: string, opts: CopyOptions, studentIds: string[]): Promise<CopyPlan & { error?: string }>;
	deployShared(space: SharedSpace): Promise<void>;
	/** 모든 링크의 삭제된(tombstone) 파일 목록. 복구 패널용(보고서 §2 P1). */
	listDeletedFiles(): Promise<DeletedItem[]>;
	/** 삭제 파일 복구(remoteDb로 담당 링크 라우팅). */
	restoreDeleted(remoteDb: string, dbPath: string, opts?: RestoreOptions): Promise<RestoreResult>;
	/** 삭제 파일 영구 삭제(purge). */
	purgeDeleted(remoteDb: string, dbPath: string): Promise<"purged" | "skipped">;
	// 삭제/수정 충돌 큐 + 최근 영구 삭제 되돌리기 (보고서 §2 P2)
	listDeleteModify(): Promise<DeleteModifyRow[]>;
	resolveDeleteModify(remoteDb: string, dbPath: string, choice: DeleteModifyChoice): Promise<void>;
	listRecentPurges(): Promise<PurgeRow[]>;
	undoPurge(remoteDb: string, id: string): Promise<RestoreResult>;
	clearPurge(remoteDb: string, id: string): Promise<void>;
}

/** 링크 라벨이 붙은 삭제/수정 충돌 항목. */
export interface DeleteModifyRow extends DeleteModifyItem {
	remoteDb: string;
	studentName: string;
}

/** 링크 라벨이 붙은 최근 영구 삭제 스냅샷. */
export interface PurgeRow extends PurgeSnapshot {
	remoteDb: string;
	studentName: string;
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
