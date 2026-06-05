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

	// 1) Obsidian UI 언어(명시 설정). 데스크톱은 보통 여기에 저장된다.
	let obsidianLang = "";
	try {
		obsidianLang = window.localStorage.getItem("language") || "";
	} catch {
		/* 접근 불가 */
	}
	if (obsidianLang) return obsidianLang.toLowerCase().startsWith("ko") ? "ko" : "en";

	// 2) 모바일 등에서 localStorage["language"]가 비어/읽히지 않으면 기기·앱 언어로 폴백.
	//    (명시 설정이 있으면 1)에서 이미 반환하므로, 영어를 고른 사용자를 덮어쓰지 않는다.)
	const fallbacks: string[] = [];
	try {
		const m = (window as unknown as { moment?: { locale?: () => string } }).moment?.locale?.();
		if (m) fallbacks.push(m); // Obsidian이 UI 언어에 맞춰 설정하는 moment 로케일
	} catch {
		/* noop */
	}
	try {
		if (navigator?.language) fallbacks.push(navigator.language);
		if (Array.isArray(navigator?.languages)) fallbacks.push(...navigator.languages);
	} catch {
		/* noop */
	}
	return fallbacks.some((l) => l?.toLowerCase().startsWith("ko")) ? "ko" : "en";
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
