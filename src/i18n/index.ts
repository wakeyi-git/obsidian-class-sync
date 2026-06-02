import { EN } from "./en";

/** 언어 설정값: 자동(Obsidian 따름) / 한국어 / English. */
export type LangSetting = "auto" | "ko" | "en";

let locale: "ko" | "en" = "ko";

/** Obsidian UI 언어 또는 설정값으로 로케일 확정. main.onload에서 가장 먼저 호출. */
export function initI18n(setting: LangSetting): void {
	locale = resolveLocale(setting);
}

export function currentLocale(): "ko" | "en" {
	return locale;
}

function resolveLocale(setting: LangSetting): "ko" | "en" {
	if (setting === "ko" || setting === "en") return setting;
	// Obsidian은 UI 언어를 localStorage["language"]에 저장(영어 기본은 비어있을 수 있음).
	let lang = "";
	try {
		lang = window.localStorage.getItem("language") || "";
	} catch {
		/* 접근 불가 시 기본 */
	}
	return lang.toLowerCase().startsWith("ko") ? "ko" : "en";
}

/**
 * 번역. 한국어 원문을 키로 사용 — ko면 원문 그대로, en이면 EN 맵의 번역(없으면 한국어 폴백).
 * `{name}` 자리표시자는 vars로 보간한다.
 */
export function t(ko: string, vars?: Record<string, string | number | boolean>): string {
	const s = locale === "en" ? EN[ko] ?? ko : ko;
	if (!vars) return s;
	return s.replace(/\{(\w+)\}/g, (_, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}
