import { CoreServices } from "../../core/CoreServices";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { SyncDirection } from "../../core/sync/FullSync";
import { computeChildRoots } from "../../core/sync/childRoots";
import { ClassSyncMode } from "../ClassSyncMode";

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
		// 모든 링크의 localRoot(개인 학생 폴더 + 공유 폴더)로 겹침 제외 계산
		const roots = [...s.students.map((st) => st.localRoot), ...s.sharedSpaces.map((sp) => sp.folder)];

		const studentSyncs = s.students.map(
			(st) =>
				new MirrorSync(core, {
					studentId: st.studentId,
					studentName: st.studentName,
					localRoot: st.localRoot,
					remoteDb: st.remoteDb,
					childRoots: computeChildRoots(st.localRoot, roots),
				}),
		);
		const sharedSyncs = s.sharedSpaces.map(
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
	}

	async start(): Promise<void> {
		const s = this.core.settings;
		this.core.logger.ok(`Teacher Mode 시작 — 학생 ${s.students.length}명, 공유 ${s.sharedSpaces.length}개`, true);
		if (this.syncs.length === 0) {
			this.core.logger.warn("학생/공유 공간이 없습니다. 설정에서 추가하세요.");
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

	getSyncs(): MirrorSync[] {
		return this.syncs;
	}
}
