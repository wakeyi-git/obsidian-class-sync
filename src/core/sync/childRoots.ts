import { normalizePath } from "../path/path";

/**
 * 한 링크(root=R) 아래에 중첩된 다른 링크들의 root를 구한다.
 * 그 경로들은 이 링크의 동기화에서 제외되어 이중 동기화(개인 미러 + 공유 폴더)를 막는다.
 *
 * 예) R="" (학생 개인, vault 전체), allRoots=["", "모둠1"] → ["모둠1"]
 *     R="모둠1", allRoots=["", "모둠1"] → []  (자기 자신/상위는 제외)
 */
export function computeChildRoots(root: string, allRoots: string[]): string[] {
	const r = normalizePath(root);
	const out: string[] = [];
	for (const other of allRoots) {
		const o = normalizePath(other);
		if (o === r || o === "") continue;
		if (r === "" || o.startsWith(r + "/")) out.push(o);
	}
	return out;
}
