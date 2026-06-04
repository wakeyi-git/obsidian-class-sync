import { App, SecretStorage } from "obsidian";

/**
 * Obsidian SecretStorage(@since 1.11.4) 래퍼. 비밀값을 vault별 로컬 스토리지에 저장해 data.json 평문 노출을 막는다.
 * 고정 id로 직접 다뤄 동작을 결정적으로 한다(SecretComponent 위젯 미사용).
 * 모바일 등 secretStorage 미지원 환경을 대비해 항상 런타임 가드 + 평문 폴백을 둔다.
 */

export const YJS_SECRET_ID = "class-sync-yjs-secret";
export const YJS_TOKEN_ID = "class-sync-yjs-token";

function store(app: App): SecretStorage | undefined {
	return app.secretStorage as SecretStorage | undefined;
}

/** secretStorage에 값이 있으면 그것을, 없으면 평문 fallback을 반환. */
export function getSecretValue(app: App, id: string, fallback: string | undefined): string {
	const ss = store(app);
	if (ss) {
		try {
			const v = ss.getSecret(id);
			if (v != null && v !== "") return v;
		} catch {
			/* 미지원/오류 → 폴백 */
		}
	}
	return fallback ?? "";
}

/** secretStorage에 값을 저장(가능할 때). 저장 성공 여부 반환. */
export function setSecretValue(app: App, id: string, secret: string): boolean {
	const ss = store(app);
	if (!ss) return false;
	try {
		ss.setSecret(id, secret);
		return true;
	} catch {
		return false;
	}
}

/** secretStorage 지원 여부. */
export function hasSecretStorage(app: App): boolean {
	return !!store(app);
}
