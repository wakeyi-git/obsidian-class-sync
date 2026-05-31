/**
 * 경로 매핑 규칙. 기술문서 §9.
 *
 * DB path는 항상 학생 vault 기준 상대 경로(POSIX, 슬래시 구분)다.
 * - Student Mode: localPath = join(localRoot, dbPath)
 * - Teacher Mode: localPath = join(student.localRoot, dbPath)
 */

/** 슬래시 정규화 + 앞뒤 슬래시 제거. */
export function normalizePath(p: string): string {
	return p
		.replace(/\\/g, "/")
		.replace(/\/+/g, "/")
		.replace(/^\/+/, "")
		.replace(/\/+$/, "");
}

/**
 * DB path 유효성 검사 (기술문서 §9.1 금지 목록).
 * 상위 경로 탈출(..), 절대 경로, 드라이브 경로, 플러그인 내부 경로를 거부한다.
 */
export function validateVaultPath(dbPath: string): boolean {
	if (!dbPath) return false;
	const p = dbPath.replace(/\\/g, "/");
	if (p.startsWith("/")) return false; // 절대 경로
	if (/^[a-zA-Z]:/.test(p)) return false; // C:\...
	if (p.split("/").some((seg) => seg === "..")) return false; // 상위 탈출
	if (p.startsWith(".obsidian/")) return false; // 플러그인 내부
	return true;
}

/** 경로 세그먼트 안전 결합. 빈 root는 무시. */
export function safeJoin(...parts: string[]): string {
	return normalizePath(parts.filter((x) => x && x.length > 0).join("/"));
}

/** DB path → local vault path (localRoot 아래로 매핑). */
export function dbPathToLocal(localRoot: string, dbPath: string): string {
	return safeJoin(localRoot, dbPath);
}

/**
 * local vault path → DB path (localRoot 접두 제거).
 * localRoot 밖의 경로면 null (기술문서 §9.4 폴더 밖 변경 무시).
 */
export function localPathToDb(localRoot: string, localPath: string): string | null {
	const root = normalizePath(localRoot);
	const local = normalizePath(localPath);
	if (root === "") return local;
	if (local === root) return "";
	if (local.startsWith(root + "/")) return local.slice(root.length + 1);
	return null;
}
