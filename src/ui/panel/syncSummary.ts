import { DashboardRow } from "./PanelSection";
import { ClassSyncSettings } from "../../settings/types";

export type SyncOverall = "ok" | "attention" | "offline" | "autosync-off" | "empty";

export interface SyncSummary {
	overall: SyncOverall;
	students: number; // 교사: 학생 수 (학생: 링크 수)
	invited: number; // 프로비저닝 완료 수
	notInvited: number; // 초대(프로비저닝) 안 된 학생 수
	shared: number; // 공유 공간 수
	conflicts: number; // 충돌 총합
	problems: number; // offline+error 링크 수
	realtimeTokenMissing: boolean;
	autoSyncOff: boolean;
	lastSyncAt: number; // 마지막 업/다운로드 시각(없으면 0)
}

/** 대시보드 상단 요약 + 조치 카드용 모델 계산(순수 함수, 테스트 가능). */
export function computeSyncSummary(rows: DashboardRow[], s: ClassSyncSettings): SyncSummary {
	const teacher = s.role === "teacher";
	const students = teacher ? s.students.length : rows.length;
	const invited = teacher ? s.students.filter((st) => st.provisioned).length : rows.length;
	const notInvited = teacher ? s.students.filter((st) => st.studentId && !st.provisioned).length : 0;
	const shared = s.sharedSpaces.length;
	const conflicts = rows.reduce((n, r) => n + (r.conflicts || 0), 0);
	const errorCount = rows.filter((r) => r.state === "error").length;
	const offlineCount = rows.filter((r) => r.state === "offline").length;
	const problems = errorCount + offlineCount;

	const realtimeTokenMissing =
		!!s.realtimeEnabled &&
		!!s.yjsServerUrl &&
		shared > 0 &&
		!s.yjsToken &&
		s.sharedSpaces.some((sp) => !sp.token);

	const autoSyncOff = !s.autoSync;

	let lastSyncAt = 0;
	for (const r of rows) lastSyncAt = Math.max(lastSyncAt, r.lastUploadAt ?? 0, r.lastDownloadAt ?? 0);

	let overall: SyncOverall;
	if (students === 0) overall = "empty";
	else if (errorCount > 0 || conflicts > 0) overall = "attention";
	else if (offlineCount > 0) overall = "offline";
	else if (autoSyncOff) overall = "autosync-off";
	else overall = "ok";

	return {
		overall,
		students,
		invited,
		notInvited,
		shared,
		conflicts,
		problems,
		realtimeTokenMissing,
		autoSyncOff,
		lastSyncAt,
	};
}
