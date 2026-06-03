import { describe, it, expect } from "vitest";
import { computeChildRoots } from "./childRoots";

describe("computeChildRoots", () => {
	it("root 아래 중첩된 다른 root만 반환한다", () => {
		const all = ["학생A", "학생A/모둠1", "학생B"];
		expect(computeChildRoots("학생A", all)).toEqual(["학생A/모둠1"]);
	});

	it("자기 자신은 제외한다", () => {
		expect(computeChildRoots("학생A", ["학생A"])).toEqual([]);
	});

	it("형제 폴더(접두 일부만 일치)는 중첩으로 보지 않는다", () => {
		// '학생A2'는 '학생A/' 접두가 아니므로 중첩 아님
		expect(computeChildRoots("학생A", ["학생A2"])).toEqual([]);
	});

	it("빈 root는 모든 비어있지 않은 root를 자식으로 본다(vault 루트)", () => {
		expect(computeChildRoots("", ["a", "b"])).toEqual(["a", "b"]);
	});

	it("중첩이 없으면 빈 배열", () => {
		expect(computeChildRoots("학생A", ["학생B", "학생C"])).toEqual([]);
	});
});
