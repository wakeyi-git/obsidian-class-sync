// 버전 히스토리 보존 정책(순수, obsidian-free → 단위 테스트 가능).
// "최근 N개 또는 최근 N일" 합집합으로 유지하고, 둘 다 벗어난 항목만 정리한다.

export interface VersionMeta {
	id: string;
	createdAtMs: number;
}

export interface RetentionOptions {
	maxCount: number;
	maxAgeMs: number;
	now: number;
}

/**
 * 정리(삭제) 대상 버전 id 목록.
 * 유지 조건: 최신순 인덱스가 maxCount 미만(최근 N개) **또는** 나이가 maxAge 이하(최근 N일).
 * 둘 다 아니면 정리 대상.
 */
export function selectVersionsToPrune(entries: VersionMeta[], opts: RetentionOptions): string[] {
	const sorted = [...entries].sort((a, b) => b.createdAtMs - a.createdAtMs);
	const remove: string[] = [];
	sorted.forEach((e, i) => {
		const withinCount = i < opts.maxCount;
		const withinAge = opts.now - e.createdAtMs <= opts.maxAgeMs;
		if (!withinCount && !withinAge) remove.push(e.id);
	});
	return remove;
}

export const DAY_MS = 24 * 60 * 60 * 1000;
