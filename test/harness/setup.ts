// pouchdb-browser는 import 시 전역 `self`를 참조한다(브라우저 번들). node/vitest에는 없으므로 폴리필.
// setupFiles는 각 테스트 모듈의 import보다 먼저 실행되어 정적 import도 안전하다.
if (typeof (globalThis as any).self === "undefined") {
	(globalThis as any).self = globalThis;
}
