import en from "./locales/en.json";
import ko from "./locales/ko.json";

/** 언어 설정값: 자동(Obsidian 따름) / 한국어 / English. */
export type LangSetting = "auto" | "ko" | "en";

/** en.json(기준)에서 추론한 계층형 키 타입. 오타·미정의 키는 컴파일 에러. */
type PathsToFields<T, P extends string = ""> = T extends object
	? { [K in keyof T]: PathsToFields<T[K], P extends "" ? `${K & string}` : `${P}.${K & string}`> }[keyof T]
	: P;
export type I18nKey = PathsToFields<typeof en>;

const locales: Record<string, unknown> = { en, ko };

let locale: "ko" | "en" = "ko";

/** Obsidian UI 언어 또는 설정값으로 로케일 확정. main.onload에서 가장 먼저 호출. */
export function initI18n(setting: LangSetting): void {
	locale = resolveLocale(setting);
}

export function currentLocale(): "ko" | "en" {
	return locale;
}

/** Intl용 BCP 47 태그. 날짜·숫자 포맷에 사용. */
export function currentLocaleTag(): string {
	return locale === "ko" ? "ko-KR" : "en-US";
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

/** 중첩 키(`ns.leaf`) 조회. */
function lookup(obj: unknown, key: string): unknown {
	return key.split(".").reduce<unknown>((o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]), obj);
}

/**
 * 번역(타입안전 계층형 키). 활성 로케일 → 없으면 다른 로케일 → 키 문자열 순으로 폴백.
 * `{name}` 자리표시자는 vars로 보간한다.
 */
export function t(key: I18nKey, vars?: Record<string, string | number | boolean>): string {
	const k = key as string;
	const raw = lookup(locales[locale], k) ?? lookup(locales.en, k) ?? lookup(locales.ko, k);
	if (typeof raw !== "string") return k; // 어느 로케일에도 없음 → 키 노출(개발 중 발견용)
	if (!vars) return raw;
	return raw.replace(/\{(\w+)\}/g, (_, n: string) => (n in vars ? String(vars[n]) : `{${n}}`));
}

/**
 * 활성 로케일(BCP 47) 기준 날짜 포맷(Intl). 기본: 날짜 + 시:분.
 * 기본 옵션은 ES2018 DateTimeFormatOptions에 존재하는 필드만 써서 lib 버전에 무관하게 타입 안전하다
 * (dateStyle/timeStyle는 ES2020+ 타입이라 회피).
 */
export function formatDate(value: number | Date, opts?: Intl.DateTimeFormatOptions): string {
	const fallback: Intl.DateTimeFormatOptions = {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	};
	return new Intl.DateTimeFormat(currentLocaleTag(), opts ?? fallback).format(value);
}

/** 활성 로케일(BCP 47) 기준 숫자 포맷(Intl). */
export function formatNumber(value: number, opts?: Intl.NumberFormatOptions): string {
	return new Intl.NumberFormat(currentLocaleTag(), opts).format(value);
}
