import { CoreServices } from "../../core/CoreServices";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { SyncDirection } from "../../core/sync/FullSync";
import { ClassSyncMode } from "../ClassSyncMode";

/**
 * Student Mode (Phase 2). 기술문서 §11.
 * vault root(또는 지정 localRoot) ↔ 자기 mirror DB를 양방향 동기화한다.
 * 자격증명은 교사 초대로 받은 학생 전용 계정(최소 권한).
 */
export class StudentMode implements ClassSyncMode {
	readonly role = "student" as const;
	private readonly sync: MirrorSync;

	constructor(private core: CoreServices) {
		const s = core.settings;
		this.sync = new MirrorSync(core, s.userId, s.localRoot, s.remoteDb);
	}

	async start(): Promise<void> {
		const s = this.core.settings;
		this.core.logger.ok(
			`Student Mode 시작 — localRoot=${s.localRoot || "(vault root)"}, mirror=${s.remoteDb}`,
			true,
		);
		await this.sync.start();
	}

	async stop(): Promise<void> {
		await this.sync.stop();
		this.core.logger.info("Student Mode 정지.");
	}

	fullSync(direction: SyncDirection): Promise<void> {
		return this.sync.fullSync(direction);
	}
}
