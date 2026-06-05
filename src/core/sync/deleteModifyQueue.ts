// 삭제/수정 충돌 큐. 오프라인 삭제 정합에서 "기준선 이후 원격이 수정해 보존된" 파일을
// 조용히 버리지 않고 사용자에게 보여, 내 삭제를 적용할지/원격 수정을 유지할지 선택하게 한다.
import { PouchService } from "../couch/PouchService";
import { loadEntries, saveEntries } from "./localQueue";

export const DELETE_MODIFY_ID = "_local/delete-modify";

export interface DeleteModifyItem {
	dbPath: string;
	kind: "note" | "asset";
	recordedAt: number;
}

/** 기존 + 신규를 dbPath 기준으로 병합(중복 제거, 기존 recordedAt 유지). 순수. */
export function mergeDeleteModify(existing: DeleteModifyItem[], found: DeleteModifyItem[]): DeleteModifyItem[] {
	const byPath = new Map<string, DeleteModifyItem>();
	for (const e of existing) byPath.set(e.dbPath, e);
	for (const f of found) if (!byPath.has(f.dbPath)) byPath.set(f.dbPath, f);
	return [...byPath.values()];
}

export async function recordDeleteModify(pouch: PouchService, found: DeleteModifyItem[]): Promise<void> {
	if (found.length === 0) return;
	const prev = await loadEntries<DeleteModifyItem>(pouch, DELETE_MODIFY_ID);
	await saveEntries(pouch, DELETE_MODIFY_ID, mergeDeleteModify(prev, found));
}

export async function listDeleteModify(pouch: PouchService): Promise<DeleteModifyItem[]> {
	return loadEntries<DeleteModifyItem>(pouch, DELETE_MODIFY_ID);
}

export async function removeDeleteModify(pouch: PouchService, dbPath: string): Promise<void> {
	const next = (await loadEntries<DeleteModifyItem>(pouch, DELETE_MODIFY_ID)).filter((e) => e.dbPath !== dbPath);
	await saveEntries(pouch, DELETE_MODIFY_ID, next);
}
