/** PouchDB/CouchDB 문서 공통 베이스. */
export interface PouchDocBase {
	_id: string;
	_rev?: string;
}

/** note 문서. 기술문서 §8.1 / 삭제 시 tombstone(§8.3). */
export interface NoteDoc extends PouchDocBase {
	type: "note";
	schemaVersion: number;
	classId: string;
	studentId: string;
	path: string; // 학생 vault 기준 상대 경로 (DB path)
	content: string;
	contentHash: string;
	mtime: number;
	deleted: boolean;
	version: number;
	lastModifiedBy: string;
	lastModifiedRole: "student" | "teacher";
	lastModifiedDeviceId: string;
	updatedAt: string;

	// tombstone 메타데이터 (deleted=true일 때, 기술문서 §8.3)
	deletedAt?: string;
	deletedBy?: string;
	deletedByRole?: "student" | "teacher";
	deleteMode?: "archive" | "propagate-delete" | "ignore-delete";
}

export function noteId(dbPath: string): string {
	return `note:${dbPath}`;
}

/** asset(첨부파일) 문서. 바이너리는 PouchDB attachment("data")로 저장. 기술문서 §8.2. */
export interface AssetDoc extends PouchDocBase {
	type: "asset";
	schemaVersion: number;
	classId: string;
	studentId: string;
	path: string; // 학생 vault 기준 상대 경로 (DB path)
	mime: string;
	size: number;
	contentHash: string;
	mtime: number;
	deleted: boolean;
	version: number;
	lastModifiedBy: string;
	lastModifiedRole: "student" | "teacher";
	lastModifiedDeviceId: string;
	updatedAt: string;

	// tombstone (deleted=true일 때)
	deletedAt?: string;
	deletedBy?: string;
	deletedByRole?: "student" | "teacher";
	deleteMode?: "archive" | "propagate-delete" | "ignore-delete";
}

export function assetId(dbPath: string): string {
	return `asset:${dbPath}`;
}

/** 학생이 속한 공유 공간 목록. 교사가 학생 개인 mirror DB에 기록 → 학생이 자동으로 공유 링크 생성. */
export interface SharesDoc extends PouchDocBase {
	type: "shares";
	spaces: Array<{ id: string; name: string; remoteDb: string; folder: string }>;
}

export const SHARES_DOC_ID = "shares";

/** 실시간(Yjs) 서버 설정. 교사가 학생 mirror DB에 기록 → 학생이 자동 수신. */
export interface RtConfigDoc extends PouchDocBase {
	type: "rtconfig";
	enabled: boolean;
	url: string;
	token: string;
	/** 실시간 세션 중 CouchDB 스냅샷 주기(초). 0/미설정=끔(§19.2). */
	snapshotSec?: number;
}

export const RTCONFIG_DOC_ID = "rtconfig";

/**
 * 피드백 레이어 문서. 기술문서 §19.5. 본문을 직접 고치지 않고 앵커(인용구+오프셋) 기반 댓글을 남긴다.
 * 대상 노트가 사는 DB(mirror_<id> 또는 share_<id>)에 함께 저장되어 기존 replication으로 동기화된다.
 * 파일이 아니라 메타데이터이므로 vault에는 쓰지 않는다(FeedbackStore만 처리).
 */
export interface FeedbackDoc extends PouchDocBase {
	type: "feedback";
	schemaVersion: number;
	classId: string;
	studentId: string; // 대상 노트가 속한 링크의 studentId(공유 공간은 spaceId 대용)
	targetPath: string; // 대상 노트의 dbPath (해당 DB 기준 상대경로)
	content: string;
	anchor: { textQuote: string; start: number; end: number };
	createdBy: string; // userId
	createdByRole: "student" | "teacher";
	createdAt: string;
	updatedAt: string;
	resolved: boolean;
	deleted?: boolean;
}

export const FEEDBACK_ID_PREFIX = "feedback:";

/** 피드백 문서 _id: feedback:<dbPath>:<uid>. dbPath 기준으로 노트별 prefix 조회 가능. */
export function feedbackId(dbPath: string, uid: string): string {
	return `${FEEDBACK_ID_PREFIX}${dbPath}:${uid}`;
}
