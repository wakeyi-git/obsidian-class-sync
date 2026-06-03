import { describe, it, expect } from "vitest";
import { mintSpaceToken, verifySpaceToken } from "./spaceToken";

const SECRET = "test-secret-key";
const NOW = 1_700_000_000;

describe("spaceToken", () => {
	it("발급한 토큰은 같은 secret·classId·spaceId로 검증된다", async () => {
		const tok = await mintSpaceToken(SECRET, { classId: "c1", spaceId: "s1" });
		expect(await verifySpaceToken(SECRET, tok, "c1", "s1", NOW)).toBe(true);
	});

	it("다른 spaceId면 거부(공간 간 격리)", async () => {
		const tok = await mintSpaceToken(SECRET, { classId: "c1", spaceId: "s1" });
		expect(await verifySpaceToken(SECRET, tok, "c1", "s2", NOW)).toBe(false);
	});

	it("다른 classId면 거부", async () => {
		const tok = await mintSpaceToken(SECRET, { classId: "c1", spaceId: "s1" });
		expect(await verifySpaceToken(SECRET, tok, "c2", "s1", NOW)).toBe(false);
	});

	it("다른 secret이면 거부", async () => {
		const tok = await mintSpaceToken(SECRET, { classId: "c1", spaceId: "s1" });
		expect(await verifySpaceToken("wrong-secret", tok, "c1", "s1", NOW)).toBe(false);
	});

	it("서명/payload 변조 시 거부", async () => {
		const tok = await mintSpaceToken(SECRET, { classId: "c1", spaceId: "s1" });
		const tampered = tok.slice(0, -2) + (tok.endsWith("aa") ? "bb" : "aa");
		expect(await verifySpaceToken(SECRET, tampered, "c1", "s1", NOW)).toBe(false);
	});

	it("exp 지난 토큰은 거부, 유효 기간 내면 통과", async () => {
		const tok = await mintSpaceToken(SECRET, { classId: "c1", spaceId: "s1", exp: NOW + 100 });
		expect(await verifySpaceToken(SECRET, tok, "c1", "s1", NOW + 50)).toBe(true);
		expect(await verifySpaceToken(SECRET, tok, "c1", "s1", NOW + 200)).toBe(false);
	});

	it("형식이 잘못된 토큰은 거부", async () => {
		expect(await verifySpaceToken(SECRET, "no-dot-here", "c1", "s1", NOW)).toBe(false);
		expect(await verifySpaceToken(SECRET, "", "c1", "s1", NOW)).toBe(false);
	});
});
