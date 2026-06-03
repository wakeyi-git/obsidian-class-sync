import { describe, it, expect } from "vitest";
import { exceedsAttachmentLimit } from "./attachment";

describe("exceedsAttachmentLimit", () => {
	it("maxMB<=0이면 무제한(항상 false)", () => {
		expect(exceedsAttachmentLimit(999 * 1024 * 1024, 0)).toBe(false);
		expect(exceedsAttachmentLimit(10, -1)).toBe(false);
	});

	it("한도 초과면 true, 이하면 false", () => {
		const mb = 1024 * 1024;
		expect(exceedsAttachmentLimit(5 * mb, 10)).toBe(false);
		expect(exceedsAttachmentLimit(10 * mb, 10)).toBe(false); // 정확히 한도는 허용
		expect(exceedsAttachmentLimit(10 * mb + 1, 10)).toBe(true);
	});
});
