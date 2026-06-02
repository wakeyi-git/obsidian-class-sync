import { CoreServices } from "../CoreServices";
import { t } from "../../i18n";

/** 진단 대상 DB. label은 학생/공유 식별. */
export interface DiagTarget {
	db: string;
	label: string;
}

/**
 * 종합 연결 진단. 기술문서 §22.3 / §24.6.
 * 서버 도달 + 각 mirror/share DB의 읽기·쓰기 권한을 한 번에 점검해 로그 패널에 정리한다.
 * 다른 학생 DB의 403은 권한 격리가 정상 동작하는 신호로 표기한다.
 */
export async function runDiagnostics(core: CoreServices, targets: DiagTarget[]): Promise<void> {
	const log = core.logger;
	const s = core.settings;

	log.info(t("───────── 종합 진단 시작 ─────────"), true);
	log.info(
		t(
			"설정 — 역할={role}, 학급={classId}, URL={url}, 자동동기화={autoSync}, 첨부={syncAssets}(최대 {maxMB}MB), 백그라운드정지={pauseWhenHidden}, 실시간={realtimeEnabled}",
			{
				role: s.role,
				classId: s.classId,
				url: s.couchdbUrl ? t("설정됨") : t("없음"),
				autoSync: String(s.autoSync),
				syncAssets: String(s.syncAssets),
				maxMB: s.maxAttachmentMB,
				pauseWhenHidden: String(s.pauseWhenHidden),
				realtimeEnabled: String(s.realtimeEnabled),
			},
		),
	);

	if (!s.couchdbUrl) {
		log.warn(t("CouchDB URL이 없습니다. 설정을 먼저 입력하세요."), true);
		return;
	}
	if (targets.length === 0) {
		log.warn(t("진단할 DB가 없습니다. (교사: 학생/공유 공간을 추가하세요)"), true);
		return;
	}

	let okCount = 0;
	let failCount = 0;

	for (const { db, label } of targets) {
		const pouch = core.createPouch(db);
		try {
			// 읽기(도달 + 권한)
			let status = 0;
			try {
				const raw = await pouch.rawInfo();
				status = raw.status;
			} catch (e) {
				log.error(
					t("✗ {label} ({db}) — 서버 도달 불가: {err}", {
						label,
						db,
						err: e instanceof Error ? e.message : String(e),
					}),
				);
				failCount++;
				continue;
			}
			if (status === 401) {
				log.error(t("✗ {label} ({db}) — 인증 오류(401). 아이디/비밀번호 확인.", { label, db }));
				failCount++;
				continue;
			}
			if (status === 403) {
				log.warn(t("• {label} ({db}) — 접근 불가(403). 다른 학생 DB라면 권한 격리가 정상입니다.", { label, db }));
				continue;
			}
			if (status >= 400) {
				log.error(t("✗ {label} ({db}) — HTTP {status}.", { label, db, status }));
				failCount++;
				continue;
			}

			// 쓰기 권한
			const w = await pouch.probeWrite();
			if (w.ok) {
				log.ok(t("✓ {label} ({db}) — 읽기 OK · 쓰기 OK", { label, db }));
				okCount++;
			} else if (w.status === 401 || w.status === 403) {
				log.warn(t("• {label} ({db}) — 읽기 OK · 쓰기 권한 없음({status}).", { label, db, status: w.status }));
			} else {
				log.error(t("✗ {label} ({db}) — 읽기 OK · 쓰기 실패: {err}", { label, db, err: w.error ?? "" }));
				failCount++;
			}
		} finally {
			await pouch.close();
		}
	}

	log.info(t("───────── 진단 완료 — 정상 {ok} · 실패 {fail} ─────────", { ok: okCount, fail: failCount }), true);
}
