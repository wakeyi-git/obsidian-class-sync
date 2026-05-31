/** PouchDB/CouchDB 문서 공통 베이스. */
export interface PouchDocBase {
	_id: string;
	_rev?: string;
}

/** note 문서. 기술문서 §8.1 (POC 필수 필드만). */
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
}

export function noteId(dbPath: string): string {
	return `note:${dbPath}`;
}
