import { describe, it, expect } from "vitest";
import { lineDiff, diffStats } from "./lineDiff";

describe("lineDiff", () => {
	it("동일 텍스트는 모두 equal", () => {
		const d = lineDiff("a\nb\nc", "a\nb\nc");
		expect(d.every((l) => l.type === "equal")).toBe(true);
		expect(d).toHaveLength(3);
	});

	it("원격에 추가된 줄은 add, 로컬에만 있는 줄은 remove", () => {
		const d = lineDiff("a\nb", "a\nb\nc");
		expect(d).toEqual([
			{ type: "equal", text: "a" },
			{ type: "equal", text: "b" },
			{ type: "add", text: "c" },
		]);
		const d2 = lineDiff("a\nb\nc", "a\nc");
		expect(d2).toEqual([
			{ type: "equal", text: "a" },
			{ type: "remove", text: "b" },
			{ type: "equal", text: "c" },
		]);
	});

	it("한 줄 수정은 remove + add 쌍으로", () => {
		const d = lineDiff("hello world", "hello there");
		expect(diffStats(d)).toEqual({ added: 1, removed: 1 });
	});

	it("ignoreWhitespace: 공백만 다르면 equal", () => {
		const a = "  hello   world ";
		const b = "hello world";
		expect(lineDiff(a, b).some((l) => l.type !== "equal")).toBe(true); // 기본은 다름
		const d = lineDiff(a, b, { ignoreWhitespace: true });
		expect(d.every((l) => l.type === "equal")).toBe(true);
		// 표시 텍스트는 원본(로컬) 유지
		expect(d[0].text).toBe(a);
	});

	it("diffStats 집계", () => {
		const d = lineDiff("a\nb\nc", "a\nx\ny\nc");
		const s = diffStats(d);
		expect(s.removed).toBe(1); // b
		expect(s.added).toBe(2); // x, y
	});
});
