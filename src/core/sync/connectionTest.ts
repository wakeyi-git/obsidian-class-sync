import { CoreServices } from "../CoreServices";
import { t } from "../../i18n";

/**
 * 현재 설정으로 새 PouchService를 만들어 연결/권한을 테스트한다. 기술문서 §22.3.
 * 실행 중인 엔진의 (이미 만들어진) 연결이 아니라 항상 최신 설정으로 검사하므로,
 * 설정을 바꾼 직후에도 정확하다. HTTP 상태를 신뢰의 기준으로 삼는다.
 */
export async function testConnection(core: CoreServices, dbName?: string): Promise<void> {
	const log = core.logger;
	const s = core.settings;
	if (!s.couchdbUrl) {
		log.warn(t("CouchDB URL이 비어 있습니다. 설정을 먼저 입력하세요."), true);
		return;
	}
	const db = dbName ?? s.remoteDb;
	log.info(t("연결 테스트: {url} / {db}", { url: s.couchdbUrl, db }));

	const pouch = core.createPouch(db);
	try {
		let raw: { status: number; length: number; snippet: string };
		try {
			raw = await pouch.rawInfo();
		} catch (e) {
			log.error(
				t("연결 실패: 서버 도달 불가 — {err}", { err: e instanceof Error ? e.message : String(e) }),
				true,
			);
			return;
		}
		if (raw.status === 401) {
			log.error(t("연결 실패: 인증 오류 (HTTP 401). 아이디/비밀번호를 확인하세요."), true);
			return;
		}
		if (raw.status === 403) {
			log.warn(
				t("권한 없음 (HTTP 403): '{db}'에 이 계정은 접근할 수 없습니다. (다른 학생 DB라면 권한 격리가 정상 동작하는 것)", {
					db,
				}),
				true,
			);
			return;
		}
		if (raw.status >= 400) {
			log.error(t("연결 실패: HTTP {status} — {snippet}", { status: raw.status, snippet: raw.snippet }), true);
			return;
		}
		const res = await pouch.ping();
		if (res.ok) log.ok(t("연결 성공: {db} (docs={count})", { db, count: res.info?.doc_count ?? "?" }), true);
		else log.error(t("연결 실패: {err}", { err: res.error ?? "" }), true);
	} finally {
		await pouch.close();
	}
}
