import { describe, it, expect } from "vitest";
import { mergeDeleteModify, DeleteModifyItem } from "./deleteModifyQueue";
import { selectDeleteModifyConflicts } from "./LinkManifest";
import { trimPurges, PurgeSnapshot } from "./recentPurge";

const item = (dbPath: string, recordedAt = 1): DeleteModifyItem => ({ dbPath, kind: "note", recordedAt });

describe("mergeDeleteModify", () => {
	it("중복 dbPath는 기존 항목 유지(recordedAt 보존)", () => {
		const merged = mergeDeleteModify([item("a.md", 100)], [item("a.md", 999), item("b.md", 5)]);
		expect(merged).toHaveLength(2);
		expect(merged.find((e) => e.dbPath === "a.md")?.recordedAt).toBe(100);
		expect(merged.find((e) => e.dbPath === "b.md")?.recordedAt).toBe(5);
	});
});

describe("selectDeleteModifyConflicts", () => {
	const baseline = { "a.md": { rev: "1-x", hash: "h1" }, "b.md": { rev: "1-y", hash: "h2" } };
	it("로컬 삭제 + DB rev/hash 변경된 것만 충돌로 선택", () => {
		const existing = new Set<string>(); // 둘 다 로컬에서 사라짐
		const current = new Map([
			["a.md", { rev: "2-x", hash: "h1-new" }], // 원격이 수정 → 충돌
			["b.md", { rev: "1-y", hash: "h2" }], // 그대로 → 충돌 아님(정상 삭제 후보)
		]);
		expect(selectDeleteModifyConflicts(baseline, existing, current)).toEqual(["a.md"]);
	});
	it("아직 vault에 있으면 제외", () => {
		const existing = new Set(["a.md"]);
		const current = new Map([["a.md", { rev: "2-x", hash: "h1-new" }]]);
		expect(selectDeleteModifyConflicts(baseline, existing, current)).toEqual([]);
	});
});

describe("trimPurges", () => {
	const snap = (id: string, at: number): PurgeSnapshot => ({
		id,
		dbPath: id,
		kind: "note",
		purgedAt: at,
		purgedBy: "u",
		recoverable: true,
	});
	it("최신순 정렬 + 개수 캡", () => {
		const out = trimPurges([snap("a", 1), snap("b", 3), snap("c", 2)], 2);
		expect(out.map((e) => e.id)).toEqual(["b", "c"]);
	});
});
