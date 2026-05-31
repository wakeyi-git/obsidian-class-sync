import { CoreServices } from "../../core/CoreServices";
import { ClassSyncMode } from "../ClassSyncMode";
import { PocTester } from "../PocTester";

/**
 * Student Mode (Phase 0 POC). 기술문서 §11.
 * POC 단계에서는 PocTester를 통해 핵심 메커니즘을 검증하는 얇은 래퍼다.
 * Phase 1에서 LocalWatcher / RemoteSubscriber / MirrorApplier로 확장된다.
 */
export class StudentMode implements ClassSyncMode {
	readonly role = "student" as const;
	readonly tester: PocTester;

	constructor(private core: CoreServices) {
		this.tester = new PocTester(core);
	}

	async start(): Promise<void> {
		const s = this.core.settings;
		const rootLabel = s.localRoot ? s.localRoot : "(vault root)";
		this.core.logger.ok(`Student Mode 시작 — localRoot=${rootLabel}, mirror=${s.remoteDb}`, true);
	}

	async stop(): Promise<void> {
		await this.tester.dispose();
		this.core.logger.info("Student Mode 정지.");
	}
}
