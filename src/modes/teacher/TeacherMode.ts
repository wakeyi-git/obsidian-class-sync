import { CoreServices } from "../../core/CoreServices";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { ClassSyncMode } from "../ClassSyncMode";

/**
 * Teacher Mode (Phase 1). 기술문서 §12.
 * 학생 폴더(localRoot) 1개 ↔ 해당 학생 mirror DB를 양방향 동기화한다.
 * Phase 2에서 다중 학생(MirrorSync 다수)으로 확장된다.
 */
export class TeacherMode implements ClassSyncMode {
	readonly role = "teacher" as const;
	readonly sync: MirrorSync;

	constructor(private core: CoreServices) {
		this.sync = new MirrorSync(core, core.settings.userId, core.settings.localRoot);
	}

	async start(): Promise<void> {
		const s = this.core.settings;
		const rootLabel = s.localRoot || "(미지정 — 학생 폴더를 설정하세요)";
		this.core.logger.ok(`Teacher Mode 시작 — 학생 폴더=${rootLabel}, mirror=${s.remoteDb}`, true);
		if (!s.localRoot) {
			this.core.logger.warn("Teacher Mode는 학생 폴더(localRoot)가 필요합니다. 설정에서 지정하세요. (예: 학생A)");
		}
		await this.sync.start();
	}

	async stop(): Promise<void> {
		await this.sync.stop();
		this.core.logger.info("Teacher Mode 정지.");
	}
}
