import { describe, it, expect } from "vitest";
import { selectVersionsToPrune, DAY_MS } from "./versionRetention";

const v = (id: string, ageDays: number, now: number) => ({ id, createdAtMs: now - ageDays * DAY_MS });

describe("selectVersionsToPrune", () => {
	const now = 1_000_000_000_000;

	it("최근 N개는 나이와 무관하게 유지", () => {
		const entries = [v("a", 100, now), v("b", 200, now), v("c", 300, now)];
		// maxCount=2, maxAge=1일 → 최신 2개(a,b) 유지, c 정리
		expect(selectVersionsToPrune(entries, { maxCount: 2, maxAgeMs: DAY_MS, now })).toEqual(["c"]);
	});

	it("최근 N일 안이면 개수를 넘어도 유지", () => {
		const entries = [v("a", 1, now), v("b", 2, now), v("c", 3, now)];
		// maxCount=1, maxAge=10일 → 모두 10일 내라 유지
		expect(selectVersionsToPrune(entries, { maxCount: 1, maxAgeMs: 10 * DAY_MS, now })).toEqual([]);
	});

	it("개수도 나이도 벗어난 것만 정리", () => {
		const entries = [v("a", 1, now), v("b", 40, now), v("c", 50, now)];
		// maxCount=1, maxAge=30일 → a 유지(최근1개), b·c는 개수밖+30일밖 → 정리
		expect(selectVersionsToPrune(entries, { maxCount: 1, maxAgeMs: 30 * DAY_MS, now }).sort()).toEqual(["b", "c"]);
	});
});
