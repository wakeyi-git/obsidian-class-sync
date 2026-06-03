import { CoreServices } from "../../core/CoreServices";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { SyncDirection } from "../../core/sync/FullSync";
import { computeChildRoots } from "../../core/sync/childRoots";
import { ClassSyncMode } from "../ClassSyncMode";
import { t } from "../../i18n";

/**
 * Teacher Mode (Phase 2 + 6a). 기술문서 §12.
 * 학생 폴더 1:1 미러 + 공유 공간(모둠/학급) 링크를 동시에 동기화한다.
 * 교사 자격증명은 서버 admin이라 모든 DB에 접근한다.
 */
export class TeacherMode implements ClassSyncMode {
	readonly role = "teacher" as const;
	private readonly syncs: MirrorSync[];

	constructor(private core: CoreServices) {
		const s = core.settings;
		// 프로비저닝된(서버에 DB/계정이 존재하는) 항목만 동기화. 미초대·초기화된 항목은 제외
		// → 빈 학생으로 잘못된 링크가 생기거나, 삭제된 DB로 replication이 무한 재시도되는 것을 막는다.
		const students = s.students.filter((st) => st.provisioned && st.studentId && st.remoteDb && st.localRoot);
		const shared = s.sharedSpaces.filter((sp) => sp.provisioned && sp.remoteDb && sp.folder);

		// 모든 링크의 localRoot(개인 학생 폴더 + 공유 폴더)로 겹침 제외 계산
		const roots = [...students.map((st) => st.localRoot), ...shared.map((sp) => sp.folder)];

		const studentSyncs = students.map(
			(st) =>
				new MirrorSync(core, {
					studentId: st.studentId,
					studentName: st.studentName,
					localRoot: st.localRoot,
					remoteDb: st.remoteDb,
					childRoots: computeChildRoots(st.localRoot, roots),
				}),
		);
		const sharedSyncs = shared.map(
			(sp) =>
				new MirrorSync(core, {
					studentId: `(공유)${sp.name}`,
					studentName: sp.name,
					localRoot: sp.folder,
					remoteDb: sp.remoteDb,
					childRoots: computeChildRoots(sp.folder, roots),
				}),
		);
		this.syncs = [...studentSyncs, ...sharedSyncs];
		// 실시간(RealtimeManager)이 참조할 공유 폴더 목록
		core.sharedSpaces = shared.map((sp) => ({ id: sp.id, folder: sp.folder, token: sp.token }));
	}

	async start(): Promise<void> {
		const s = this.core.settings;
		this.core.logger.ok(
			t("Teacher Mode 시작 — 학생 {students}명, 공유 {shared}개", {
				students: s.students.length,
				shared: s.sharedSpaces.length,
			}),
			true,
		);
		if (this.syncs.length === 0) {
			this.core.logger.warn(t("학생/공유 공간이 없습니다. 설정에서 추가하세요."));
			return;
		}
		for (const sync of this.syncs) await sync.start();
	}

	async stop(): Promise<void> {
		for (const sync of this.syncs) await sync.stop();
		this.core.logger.info(t("Teacher Mode 정지."));
	}

	async fullSync(direction: SyncDirection): Promise<void> {
		for (const sync of this.syncs) await sync.fullSync(direction);
	}

	getSyncs(): MirrorSync[] {
		return this.syncs;
	}
}
