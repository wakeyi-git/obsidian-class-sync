// 마크다운 충돌 비교용 라인 단위 diff(순수, obsidian-free → 단위 테스트 가능).
// LCS 기반 unified diff. equal/add(원격에만)/remove(로컬에만) 라인을 순서대로 반환한다.

export type DiffType = "equal" | "add" | "remove";

export interface DiffLine {
	type: DiffType;
	text: string;
}

export interface DiffOptions {
	/** 공백·들여쓰기 차이를 무시하고 비교(표시 텍스트는 원본 유지). */
	ignoreWhitespace?: boolean;
}

/**
 * 로컬(a) 대비 원격(b)의 라인 diff.
 * - remove: 로컬에만 있는 줄
 * - add: 원격에만 있는 줄
 * - equal: 양쪽 동일
 */
export function lineDiff(localText: string, remoteText: string, opts: DiffOptions = {}): DiffLine[] {
	const A = localText.split("\n");
	const B = remoteText.split("\n");
	const norm = (s: string): string => (opts.ignoreWhitespace ? s.replace(/\s+/g, " ").trim() : s);
	const n = A.length;
	const m = B.length;

	// LCS 길이 DP(뒤에서 채움).
	const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			dp[i][j] = norm(A[i]) === norm(B[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (norm(A[i]) === norm(B[j])) {
			out.push({ type: "equal", text: A[i] });
			i++;
			j++;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ type: "remove", text: A[i] });
			i++;
		} else {
			out.push({ type: "add", text: B[j] });
			j++;
		}
	}
	while (i < n) out.push({ type: "remove", text: A[i++] });
	while (j < m) out.push({ type: "add", text: B[j++] });
	return out;
}

/** diff 요약(변경 줄 수). 배지/요약 표시용. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const l of lines) {
		if (l.type === "add") added++;
		else if (l.type === "remove") removed++;
	}
	return { added, removed };
}
