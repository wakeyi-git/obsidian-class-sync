import { describe, it, expect } from "vitest";
import { initI18n, t, currentLocale, currentLocaleTag, formatDate } from "./index";
import en from "./locales/en.json";
import ko from "./locales/ko.json";

describe("i18n 계층형 키 헬퍼", () => {
	it("계층형 키 중첩 조회 (en/ko)", () => {
		initI18n("en");
		expect(currentLocale()).toBe("en");
		expect(t("common.cancel")).toBe((en as any).common.cancel);
		initI18n("ko");
		expect(t("common.cancel")).toBe((ko as any).common.cancel);
	});

	it("{var} 보간 + 누락 변수 보존", () => {
		initI18n("en");
		const s = t("conflict.failed_to_load_list", { error: "boom" });
		expect(s).toContain("boom");
		expect(s).not.toContain("{error}");
		expect(t("conflict.failed_to_load_list")).toContain("{error}"); // vars 없으면 그대로
	});

	it("정의되지 않은 키는 키 문자열로 폴백", () => {
		expect(t("no.such.key" as any)).toBe("no.such.key");
	});

	it("en/ko 키 패리티(동일 키 집합)", () => {
		const flat = (o: any, p = ""): string[] =>
			Object.entries(o).flatMap(([k, v]) =>
				v && typeof v === "object" ? flat(v, p ? `${p}.${k}` : k) : [p ? `${p}.${k}` : k],
			);
		expect(new Set(flat(en))).toEqual(new Set(flat(ko)));
	});

	it("currentLocaleTag는 BCP47, formatDate는 로케일 기반", () => {
		initI18n("ko");
		expect(currentLocaleTag()).toBe("ko-KR");
		initI18n("en");
		expect(currentLocaleTag()).toBe("en-US");
		expect(typeof formatDate(0)).toBe("string"); // Intl 동작
	});
});
