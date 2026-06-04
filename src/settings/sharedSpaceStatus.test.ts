import { describe, it, expect } from "vitest";
import { sharedSpaceStatus } from "./sharedSpaceStatus";

describe("sharedSpaceStatus", () => {
	it("미프로비저닝", () => {
		expect(sharedSpaceStatus({ members: ["a"] })).toBe("unprovisioned");
	});

	it("배포 후 멤버 동일 → deployed", () => {
		expect(sharedSpaceStatus({ provisioned: true, members: ["a", "b"], lastMemberSnapshot: ["b", "a"] })).toBe(
			"deployed",
		);
	});

	it("배포 후 멤버 변경 → needs-redeploy", () => {
		expect(sharedSpaceStatus({ provisioned: true, members: ["a", "c"], lastMemberSnapshot: ["a", "b"] })).toBe(
			"needs-redeploy",
		);
	});

	it("스냅샷 없으면(구버전) deployed로 본다", () => {
		expect(sharedSpaceStatus({ provisioned: true, members: ["a"] })).toBe("deployed");
	});
});
