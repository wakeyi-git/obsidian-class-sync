import { describe, it, expect } from "vitest";
import { selectManifestOrphans, exceedsBulkThreshold, ManifestEntry, DocState } from "./LinkManifest";

function manifestOf(map: Record<string, [rev: string, hash: string]>): Record<string, ManifestEntry> {
	const out: Record<string, ManifestEntry> = {};
	for (const [k, [rev, hash]] of Object.entries(map)) out[k] = { rev, hash };
	return out;
}
function dbOf(map: Record<string, [rev: string, hash: string]>): Map<string, DocState> {
	const m = new Map<string, DocState>();
	for (const [k, [rev, hash]] of Object.entries(map)) m.set(k, { rev, hash });
	return m;
}

describe("selectManifestOrphans", () => {
	it("기준선에 있고 로컬에 없으며 rev·hash가 그대로면 삭제 후보", () => {
		const manifest = manifestOf({ "a.md": ["1-x", "ha"], "b.md": ["1-y", "hb"] });
		const existing = new Set(["a.md"]); // b만 사라짐
		const db = dbOf({ "a.md": ["1-x", "ha"], "b.md": ["1-y", "hb"] });
		expect(selectManifestOrphans(manifest, existing, db)).toEqual(["b.md"]);
	});

	it("rev가 기준선과 다르면(다른 기기 수정) 보존", () => {
		const manifest = manifestOf({ "b.md": ["1-y", "hb"] });
		const db = dbOf({ "b.md": ["2-z", "hb"] }); // rev 바뀜
		expect(selectManifestOrphans(manifest, new Set(), db)).toEqual([]);
	});

	it("hash가 기준선과 다르면 보존", () => {
		const manifest = manifestOf({ "b.md": ["1-y", "hb"] });
		const db = dbOf({ "b.md": ["1-y", "DIFFERENT"] }); // 내용 바뀜
		expect(selectManifestOrphans(manifest, new Set(), db)).toEqual([]);
	});

	it("DB에 없으면(이미 tombstone/삭제) 제외", () => {
		const manifest = manifestOf({ "b.md": ["1-y", "hb"] });
		expect(selectManifestOrphans(manifest, new Set(), new Map())).toEqual([]);
	});

	it("아직 로컬에 있으면 제외", () => {
		const manifest = manifestOf({ "a.md": ["1-x", "ha"] });
		const db = dbOf({ "a.md": ["1-x", "ha"] });
		expect(selectManifestOrphans(manifest, new Set(["a.md"]), db)).toEqual([]);
	});

	it("빈 manifest면 빈 결과", () => {
		expect(selectManifestOrphans({}, new Set(), new Map())).toEqual([]);
	});
});

describe("exceedsBulkThreshold", () => {
	it("작은 manifest는 floor(5)까지 허용", () => {
		expect(exceedsBulkThreshold(5, 10)).toBe(false); // max(5, 5)=5, 5>5 거짓
		expect(exceedsBulkThreshold(6, 10)).toBe(true); // 6>5
	});

	it("큰 manifest는 50%로 판정", () => {
		expect(exceedsBulkThreshold(50, 100)).toBe(false); // 50>max(5,50)=50 거짓
		expect(exceedsBulkThreshold(51, 100)).toBe(true);
	});

	it("아주 작은 manifest에서도 floor가 우선", () => {
		expect(exceedsBulkThreshold(4, 4)).toBe(false); // max(5,2)=5, 4>5 거짓
		expect(exceedsBulkThreshold(6, 4)).toBe(true);
	});

	it("configuredMax>0이면 절대값 임계 사용", () => {
		expect(exceedsBulkThreshold(10, 4, 20)).toBe(false); // 10>20 거짓 → 허용
		expect(exceedsBulkThreshold(21, 4, 20)).toBe(true);
		expect(exceedsBulkThreshold(3, 100, 2)).toBe(true); // 사용자가 작게 잡으면 더 엄격
	});

	it("configuredMax 0/미설정이면 자동 휴리스틱", () => {
		expect(exceedsBulkThreshold(6, 4, 0)).toBe(true); // floor 5
		expect(exceedsBulkThreshold(6, 4, undefined)).toBe(true);
	});
});
