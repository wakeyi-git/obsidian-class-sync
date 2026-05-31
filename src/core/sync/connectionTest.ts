import { CoreServices } from "../CoreServices";

/**
 * 현재 설정으로 새 PouchService를 만들어 연결/권한을 테스트한다. 기술문서 §22.3.
 * 실행 중인 엔진의 (이미 만들어진) 연결이 아니라 항상 최신 설정으로 검사하므로,
 * 설정을 바꾼 직후에도 정확하다. HTTP 상태를 신뢰의 기준으로 삼는다.
 */
export async function testConnection(core: CoreServices): Promise<void> {
	const log = core.logger;
	const s = core.settings;
	if (!s.couchdbUrl) {
		log.warn("CouchDB URL이 비어 있습니다. 설정을 먼저 입력하세요.", true);
		return;
	}
	log.info(`연결 테스트: ${s.couchdbUrl} / ${s.remoteDb}`);

	const pouch = core.createPouch();
	try {
		let raw: { status: number; length: number; snippet: string };
		try {
			raw = await pouch.rawInfo();
		} catch (e) {
			log.error(`연결 실패: 서버 도달 불가 — ${e instanceof Error ? e.message : String(e)}`, true);
			return;
		}
		if (raw.status === 401 || raw.status === 403) {
			log.error(`연결 실패: 인증 오류 (HTTP ${raw.status}). 아이디/비밀번호를 확인하세요.`, true);
			return;
		}
		if (raw.status >= 400) {
			log.error(`연결 실패: HTTP ${raw.status} — ${raw.snippet}`, true);
			return;
		}
		const res = await pouch.ping();
		if (res.ok) log.ok(`연결 성공: ${s.remoteDb} (docs=${res.info?.doc_count ?? "?"})`, true);
		else log.error(`연결 실패: ${res.error}`, true);
	} finally {
		await pouch.close();
	}
}
