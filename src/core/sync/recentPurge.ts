// "최근 영구 삭제" 되돌리기. 보관 폴더(_삭제됨/)에서 삭제하면 즉시 purge(hard remove)되는데,
// 이벤트 기반이라 확인 모달이 어색하다. 대신 purge 직전 스냅샷을 capped 목록에 남겨 되돌릴 수 있게 한다.
import { PouchService } from "../couch/PouchService";
import { loadEntries, saveEntries } from "./localQueue";

export const RECENT_PURGE_ID = "_local/recent-purge";
export const PURGE_MAX_COUNT = 20;
/** 첨부 바이너리는 이 크기 이하만 스냅샷에 담는다(로컬 문서 비대 방지). */
export const PURGE_ASSET_CAP = 512 * 1024;

export interface PurgeSnapshot {
	id: string; // dbPath@rev (고유)
	dbPath: string;
	kind: "note" | "asset";
	mime?: string;
	purgedAt: number;
	purgedBy: string;
	content?: string; // note
	binaryB64?: string; // asset(cap 이하)
	recoverable: boolean;
}

/** 최신순 정렬 + 개수 캡(순수). */
export function trimPurges(entries: PurgeSnapshot[], maxCount = PURGE_MAX_COUNT): PurgeSnapshot[] {
	return [...entries].sort((a, b) => b.purgedAt - a.purgedAt).slice(0, maxCount);
}

export async function recordPurge(pouch: PouchService, snap: PurgeSnapshot): Promise<void> {
	const prev = (await loadEntries<PurgeSnapshot>(pouch, RECENT_PURGE_ID)).filter((e) => e.id !== snap.id);
	await saveEntries(pouch, RECENT_PURGE_ID, trimPurges([snap, ...prev]));
}

export async function listPurges(pouch: PouchService): Promise<PurgeSnapshot[]> {
	return trimPurges(await loadEntries<PurgeSnapshot>(pouch, RECENT_PURGE_ID));
}

export async function removePurge(pouch: PouchService, id: string): Promise<void> {
	const next = (await loadEntries<PurgeSnapshot>(pouch, RECENT_PURGE_ID)).filter((e) => e.id !== id);
	await saveEntries(pouch, RECENT_PURGE_ID, next);
}

// --- base64 (브라우저/Obsidian/Node 공통 btoa/atob) ---
export function abToB64(buf: ArrayBuffer): string {
	const bytes = new Uint8Array(buf);
	const chunk = 0x8000;
	let bin = "";
	for (let i = 0; i < bytes.length; i += chunk) {
		bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
	}
	return btoa(bin);
}

export function b64ToAb(b64: string): ArrayBuffer {
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out.buffer;
}
