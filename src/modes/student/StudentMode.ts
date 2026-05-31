import { CoreServices } from "../../core/CoreServices";
import { MirrorSync } from "../../core/sync/MirrorSync";
import { ClassSyncMode } from "../ClassSyncMode";

/**
 * Student Mode (Phase 1). 기술문서 §11.
 * vault root(또는 지정 localRoot) ↔ 자기 mirror DB를 양방향 동기화한다.
 */
export class StudentMode implements ClassSyncMode {
	readonly role = "student" as const;
	readonly sync: MirrorSync;

	constructor(private core: CoreServices) {
		this.sync = new MirrorSync(core, core.settings.userId, core.settings.localRoot);
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
}
