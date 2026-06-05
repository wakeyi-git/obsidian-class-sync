import { describe, it, expect } from "vitest";
import { isRecoverable, restoreTargetPath } from "./restoreAction";

describe("isRecoverable", () => {
	it("노트는 content가 보존돼 있으면 복구 가능", () => {
		expect(isRecoverable("note", { hasContent: true, hasArchiveCopy: false })).toBe(true);
		expect(isRecoverable("note", { hasContent: false, hasArchiveCopy: false })).toBe(false);
	});
	it("첨부는 archive 사본이 있어야 복구 가능(tombstone은 바이너리 없음)", () => {
		expect(isRecoverable("asset", { hasContent: true, hasArchiveCopy: false })).toBe(false);
		expect(isRecoverable("asset", { hasContent: false, hasArchiveCopy: true })).toBe(true);
	});
});

describe("restoreTargetPath", () => {
	it("대상이 없으면 원래 경로", () => {
		expect(restoreTargetPath("notes/a.md", false, "skip")).toBe("notes/a.md");
		expect(restoreTargetPath("notes/a.md", false, "keep-both")).toBe("notes/a.md");
	});
	it("대상이 있으면 정책대로", () => {
		expect(restoreTargetPath("notes/a.md", true, "skip")).toBeNull();
		expect(restoreTargetPath("notes/a.md", true, "overwrite")).toBe("notes/a.md");
		expect(restoreTargetPath("notes/a.md", true, "keep-both")).toBe("notes/a.복구본.md");
	});
	it("확장자 없는 경로의 keep-both", () => {
		expect(restoreTargetPath("notes/README", true, "keep-both")).toBe("notes/README.복구본");
	});
});
