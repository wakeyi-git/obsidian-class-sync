export type Role = "student" | "teacher";

export type ConflictPolicy = "preserve-local";

/** 삭제/이름변경 시 상대 vault 처리. 기술문서 §15. */
export type DeletePolicy = "archive" | "propagate-delete" | "ignore-delete";

/** 교사가 관리하는 학생 1명. 기술문서 §12.1. */
export interface StudentConfig {
	studentId: string;
	studentName: string;
	remoteDb: string; // 기본 mirror_<studentId>
	localRoot: string; // 교사 vault 내 학생 폴더 (예: 학생A)
	username: string; // 학생 CouchDB 계정명. 기본 studentId
	password?: string; // 프로비저닝 시 생성 (교사 기기 한정 비밀)
	provisioned?: boolean; // CouchDB 계정/DB/권한 생성 완료 여부
}

/**
 * Class Sync 설정. 기술문서 §5.1 / §11.1 / §12.1.
 * Phase 1(단일 학생 양방향 미러)에 필요한 필드. Teacher의 다중 학생 배열(§12.1 students[])은
 * Phase 2에서 추가하며, Phase 1은 localRoot 1건으로 동작한다.
 */
export interface ClassSyncSettings {
	/** 최초 1회 역할 선택 완료 여부. true면 역할이 잠긴다(기술문서 §5.4 보강). */
	setupComplete: boolean;

	role: Role;
	classId: string;
	userId: string;
	displayName: string;
	deviceId: string;

	couchdbUrl: string;
	/** Teacher: 관리자 계정 / Student: 초대로 받은 학생 계정. */
	username: string;
	password: string;
	/** Student 전용: 자기 mirror DB. Teacher는 students[]가 구동. */
	remoteDb: string;

	/**
	 * Student Mode: vault root 기준 동기화 root ("" = vault 전체)
	 * Teacher Mode는 미사용(students[].localRoot 사용)
	 */
	localRoot: string;

	/** Teacher Mode: 관리 학생 목록. 기술문서 §12.1. */
	students: StudentConfig[];

	/** 동기화 root 밖으로 취급해 제외할 폴더 (기술문서 §11.1). */
	excludeFolders: string[];

	/**
	 * 삭제 보관 폴더(보이는 폴더). 점(.)으로 시작하면 Obsidian이 추적하지 않으므로 보이는 이름을 쓴다.
	 * deletePolicy=archive일 때 삭제 파일이 여기로 이동하고, 이 폴더에서 지우면 DB에서도 purge된다.
	 */
	archiveFolder: string;

	/** 자동 동기화(로컬 watch + 원격 구독) 활성 여부. */
	autoSync: boolean;

	/** 편집 중 업로드 debounce(ms). 기술문서 §11.3. */
	debounceMs: number;

	/** mirror DB별 로컬 changes 체크포인트(local seq). vault 적용 증분 재개에 사용. */
	lastSeqByDb: Record<string, string>;

	/** 충돌 정책. Phase 1은 preserve-local 고정(정식 처리는 Phase 3). */
	conflictPolicy: ConflictPolicy;

	/** 삭제/이름변경 시 상대 vault 처리 정책. 기술문서 §15. 기본 archive. */
	deletePolicy: DeletePolicy;
}

export const DEFAULT_SETTINGS: ClassSyncSettings = {
	setupComplete: false,

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
	students: [],

	excludeFolders: [".obsidian", ".trash"],
	archiveFolder: "_삭제됨",
	autoSync: true,
	debounceMs: 2000,
	lastSeqByDb: {},
	conflictPolicy: "preserve-local",
	deletePolicy: "archive",
};

/** 기기별 고유 ID. 기술문서 §16.3 deviceId 기반 무시에 사용. */
export function generateDeviceId(): string {
	const rand = Math.random().toString(36).slice(2, 8);
	return `device_${Date.now().toString(36)}_${rand}`;
}
