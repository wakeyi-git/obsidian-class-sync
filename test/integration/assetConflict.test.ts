// Phase 2: 첨부(asset) 충돌이 충돌 목록에 노출되고 해소되는지 — 실제 replication 충돌로 검증.
import { describe, it, expect, afterEach } from "vitest";
import { Cluster } from "../harness/env";
import { assetId } from "../../src/core/model/types";

function buf(s: string): ArrayBuffer {
	return new TextEncoder().encode(s).buffer;
}
function bytes(b: ArrayBuffer | null): number[] {
	return b ? Array.from(new Uint8Array(b)) : [];
}

describe("첨부 충돌 (asset conflict)", () => {
	let cluster: Cluster;
	afterEach(() => cluster?.dispose());

	async function makeConflict() {
		cluster = new Cluster();
		const a = cluster.device({ deviceId: "a", role: "teacher", remoteDb: "mirror_s1" });
		const b = cluster.device({ deviceId: "b", role: "student", remoteDb: "mirror_s1" });

		a.vault.seedBinary("img/p.png", buf("BASE"));
		await a.uploader.uploadPath("img/p.png");
		await a.push();
		await b.pull();

		// b: 1회 수정(gen2)
		b.vault.seedBinary("img/p.png", buf("B-edit"));
		await b.uploader.uploadPath("img/p.png");

		// a: 2회 수정(gen3)으로 승자를 a로 결정적으로
		a.vault.seedBinary("img/p.png", buf("A1"));
		await a.uploader.uploadPath("img/p.png");
		a.vault.seedBinary("img/p.png", buf("A2-final"));
		await a.uploader.uploadPath("img/p.png");
		await a.push();

		await b.pull();
		// 충돌 적용 → _충돌/에 원격본 materialize
		const doc = await b.ctx.pouch.getWithConflicts<any>(assetId("img/p.png"));
		expect(doc?._conflicts?.length).toBeGreaterThan(0);
		await b.applier.applyAsset(doc);
		return { a, b };
	}

	it("첨부 충돌이 충돌 목록에 kind=asset으로 표시된다", async () => {
		const { b } = await makeConflict();
		const list = await b.conflicts.list();
		const item = list.find((i) => i.dbPath === "img/p.png");
		expect(item?.kind).toBe("asset");
		expect(item?.mime).toBe("image/png");
		expect(item?.size).toBeGreaterThan(0);
	});

	it("원격 적용: 라이브 바이너리가 원격본으로 갱신되고 충돌 collapse", async () => {
		const { b } = await makeConflict();
		await b.conflicts.resolve("img/p.png", "remote");
		// 라이브 = 원격본(A2-final)
		expect(bytes(await b.ctx.readVaultBinary("img/p.png"))).toEqual(bytes(buf("A2-final")));
		// _conflicts collapse
		const after = await b.ctx.pouch.getWithConflicts<any>(assetId("img/p.png"));
		expect(after?._conflicts ?? []).toHaveLength(0);
	});

	it("로컬 유지: 라이브는 로컬 유지하고 충돌 collapse", async () => {
		const { b } = await makeConflict();
		await b.conflicts.resolve("img/p.png", "local");
		expect(bytes(await b.ctx.readVaultBinary("img/p.png"))).toEqual(bytes(buf("B-edit")));
		const after = await b.ctx.pouch.getWithConflicts<any>(assetId("img/p.png"));
		expect(after?._conflicts ?? []).toHaveLength(0);
	});
});
