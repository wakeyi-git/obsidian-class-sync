export type Role = "student" | "teacher";

/**
 * Phase 0 POC 설정.
 * 기술문서 §5.1 / §11.1 / §12.1 의 필드 중 POC 검증에 필요한 최소 집합만 둔다.
 * Teacher Mode의 다중 학생 배열(§12.1 students[])은 POC에서 localRoot 1건으로 단순화한다.
 */
export interface ClassSyncSettings {
	role: Role;
	classId: string;
	userId: string;
	displayName: string;
	deviceId: string;

	couchdbUrl: string;
	username: string;
	password: string;
	remoteDb: string;

	/**
	 * Student Mode: vault root 기준 동기화 root ("" = vault 전체)
	 * Teacher Mode: 검증 대상 학생 폴더 (예: "학생A")
	 */
	localRoot: string;
}

export const DEFAULT_SETTINGS: ClassSyncSettings = {
	role: "student",
	classId: "class_2026_1",
	userId: "student_a",
	displayName: "학생A",
	deviceId: generateDeviceId(),

	couchdbUrl: "",
	username: "",
	password: "",
	remoteDb: "mirror_student_a",

	localRoot: "",
};

/** 기기별 고유 ID. 기술문서 §16.3 deviceId 기반 무시에 사용. */
export function generateDeviceId(): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `device_${Date.now().toString(36)}_${rand}`;
}
