import { CoreServices } from "../../core/CoreServices";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { SyncDirection } from "../../core/sync/FullSync";
import { ClassSyncMode } from "../ClassSyncMode";

/**
 * Teacher Mode (Phase 2). 기술문서 §12.
 * 학생 목록(students[])의 각 학생 폴더 ↔ 해당 mirror DB를 동시에 양방향 동기화한다.
 * 교사 자격증명은 서버 admin이라 모든 학생 DB에 접근한다(§13.2).
 */
export class TeacherMode implements ClassSyncMode {
	readonly role = "teacher" as const;
	private readonly syncs: MirrorSync[];

	constructor(private core: CoreServices) {
		this.syncs = core.settings.students.map(
			(st) => new MirrorSync(core, st.studentId, st.localRoot, st.remoteDb),
		);
	}

	async start(): Promise<void> {
		const n = this.syncs.length;
		this.core.logger.ok(`Teacher Mode 시작 — 학생 ${n}명`, true);
		if (n === 0) {
			this.core.logger.warn("학생이 없습니다. 설정에서 '학생 추가'로 학급을 구성하세요.");
			return;
		}
		for (const sync of this.syncs) await sync.start();
	}

	async stop(): Promise<void> {
		for (const sync of this.syncs) await sync.stop();
		this.core.logger.info("Teacher Mode 정지.");
	}

	async fullSync(direction: SyncDirection): Promise<void> {
		for (const sync of this.syncs) await sync.fullSync(direction);
	}
}
