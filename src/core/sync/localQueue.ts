// 링크 로컬 DB의 `_local/...` 문서에 작은 목록(큐)을 저장하는 헬퍼.
// `_local/`은 CouchDB 규칙상 원격에 복제되지 않으므로 기기-로컬 상태(되돌리기/충돌 큐) 보관에 적합하다.
import { PouchService } from "../couch/PouchService";

interface ListDoc<T> {
	_id: string;
	_rev?: string;
	entries: T[];
}

export async function loadEntries<T>(pouch: PouchService, id: string): Promise<T[]> {
	const doc = await pouch.get<ListDoc<T>>(id);
	return doc?.entries ?? [];
}

export async function saveEntries<T>(pouch: PouchService, id: string, entries: T[]): Promise<void> {
	await pouch.put<ListDoc<T>>({ _id: id, entries } as ListDoc<T>);
}
