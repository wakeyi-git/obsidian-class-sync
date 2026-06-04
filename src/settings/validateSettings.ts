import { ClassSyncSettings } from "./types";
import { foldersOverlap } from "../core/path/path";

export type IssueCode =
	| "dup-studentId"
	| "dup-username"
	| "dup-remoteDb"
	| "folder-overlap"
	| "couch-url"
	| "yjs-wss"
	| "rt-no-url"
	| "rt-no-token";

export interface SettingsIssue {
	level: "error" | "warn";
	code: IssueCode;
	params?: Record<string, string | number>;
}

function duplicates(values: string[]): string[] {
	const seen = new Set<string>();
	const dup = new Set<string>();
	for (const v of values) (seen.has(v) ? dup.add(v) : seen.add(v));
	return [...dup];
}

/**
 * 설정의 위험/모순 상태를 코드로 반환(순수 함수, i18n은 UI에서). 초대/배포 전 막는 데 쓴다.
 * error=데이터 무결성 위험(중복 식별자), warn=권장 위반(겹침/URL/실시간 누락).
 */
export function validateSettings(s: ClassSyncSettings): SettingsIssue[] {
	const issues: SettingsIssue[] = [];

	if (s.role === "teacher") {
		const st = s.students;
		for (const id of duplicates(st.map((x) => x.studentId).filter((v): v is string => !!v)))
			issues.push({ level: "error", code: "dup-studentId", params: { value: id } });
		for (const u of duplicates(st.map((x) => x.username).filter((v): v is string => !!v)))
			issues.push({ level: "error", code: "dup-username", params: { value: u } });
		for (const db of duplicates(st.map((x) => x.remoteDb).filter((v): v is string => !!v)))
			issues.push({ level: "error", code: "dup-remoteDb", params: { value: db } });

		// 학생 폴더 간 + 학생↔공유 폴더 겹침(이중 동기화 혼란 방지)
		const folders = [
			...st.map((x) => ({ label: x.studentName || x.studentId, path: x.localRoot })),
			...s.sharedSpaces.map((sp) => ({ label: sp.name || sp.id, path: sp.folder })),
		].filter((f) => f.path);
		for (let i = 0; i < folders.length; i++)
			for (let j = i + 1; j < folders.length; j++)
				if (foldersOverlap(folders[i].path, folders[j].path))
					issues.push({ level: "warn", code: "folder-overlap", params: { a: folders[i].label, b: folders[j].label } });
	}

	if (s.couchdbUrl && !/^https?:\/\//i.test(s.couchdbUrl))
		issues.push({ level: "warn", code: "couch-url" });

	if (s.yjsServerUrl && !/^wss:\/\//i.test(s.yjsServerUrl)) issues.push({ level: "warn", code: "yjs-wss" });

	if (s.realtimeEnabled) {
		if (!s.yjsServerUrl) issues.push({ level: "warn", code: "rt-no-url" });
		// 비밀값은 평문 또는 Secret Storage(yjs*Set 마커)로 설정될 수 있다.
		else if (!s.yjsToken && !s.yjsSecret && !s.yjsTokenSet && !s.yjsSecretSet)
			issues.push({ level: "warn", code: "rt-no-token" });
	}

	return issues;
}
