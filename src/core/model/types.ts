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
