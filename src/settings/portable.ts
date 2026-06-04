import { ClassSyncSettings } from "./types";
import { t } from "../i18n";

/** 내보낼 때 제외할 자격증명/기기 고유 키. 기술문서 §22.4. */
const SECRET_KEYS: Array<keyof ClassSyncSettings> = ["password", "yjsToken", "yjsSecret"];
// 비밀값은 Secret Storage에 있고 이전 여부(*Set) 마커는 기기별 상태이므로 내보내지 않는다.
const DEVICE_KEYS: Array<keyof ClassSyncSettings> = ["deviceId", "lastSeqByDb", "yjsSecretSet", "yjsTokenSet"];

/** 가져올 때 구조/옵션으로 병합할 키(현재 기기의 secret·device·role은 보존). */
const IMPORT_KEYS: Array<keyof ClassSyncSettings> = [
	"classId",
	"displayName",
	"couchdbUrl",
	"username",
	"remoteDb",
	"localRoot",
	"students",
	"sharedSpaces",
	"excludeFolders",
	"archiveFolder",
	"conflictFolder",
	"autoSync",
	"syncAssets",
	"maxAttachmentMB",
	"debounceMs",
	"mobileDebounceMs",
	"pauseWhenHidden",
	"conflictPolicy",
	"deletePolicy",
	"realtimeEnabled",
	"yjsServerUrl",
	"realtimeSnapshotSec",
];

export interface PortablePayload {
	_meta: { app: "class-sync"; version: number; exportedAt: string };
	settings: Partial<ClassSyncSettings>;
}

/**
 * 설정을 자격증명·기기 고유값을 제외하고 직렬화(JSON 문자열). 기술문서 §22.4.
 * password·yjsToken·deviceId·lastSeqByDb 제거, students[].password 제거.
 */
export function exportSettings(s: ClassSyncSettings): string {
	const copy: any = JSON.parse(JSON.stringify(s));
	for (const k of [...SECRET_KEYS, ...DEVICE_KEYS]) delete copy[k];
	if (Array.isArray(copy.students)) {
		for (const st of copy.students) delete st.password; // 학생 비밀번호는 내보내지 않음
	}
	if (Array.isArray(copy.sharedSpaces)) {
		for (const sp of copy.sharedSpaces) delete sp.token; // 공간 실시간 토큰(베어러)도 내보내지 않음
	}
	const payload: PortablePayload = {
		_meta: { app: "class-sync", version: 1, exportedAt: new Date().toISOString() },
		settings: copy,
	};
	return JSON.stringify(payload, null, 2);
}

/**
 * 가져온 JSON을 현재 설정에 병합한 새 설정을 반환. 구조/옵션만 반영하고
 * 현재 기기의 secret(password·yjsToken·students[].password)·device(deviceId·lastSeqByDb)·role·setupComplete는 보존.
 */
export function importSettings(
	current: ClassSyncSettings,
	json: string,
): { ok: true; settings: ClassSyncSettings } | { ok: false; error: string } {
	let payload: PortablePayload;
	try {
		payload = JSON.parse(json);
	} catch {
		return { ok: false, error: t("JSON 형식이 아닙니다.") };
	}
	if (!payload || payload._meta?.app !== "class-sync" || typeof payload.settings !== "object") {
		return { ok: false, error: t("Class Sync 설정 백업이 아닙니다.") };
	}

	const merged: ClassSyncSettings = { ...current };
	const incoming = payload.settings as any;
	for (const k of IMPORT_KEYS) {
		if (incoming[k] !== undefined) (merged as any)[k] = incoming[k];
	}
	// 가져온 학생의 password는 비움(이 기기에서 재초대 필요). 다른 secret/device/role은 current 그대로 유지.
	if (Array.isArray(merged.students)) {
		merged.students = merged.students.map((st) => ({ ...st, password: undefined }));
	}
	return { ok: true, settings: merged };
}
