import { CoreServices } from "../../core/CoreServices";
import { ClassSyncMode } from "../ClassSyncMode";
import { PocTester } from "../PocTester";

/**
 * Teacher Mode (Phase 0 POC). 기술문서 §12.
 * POC에서는 학생 폴더(localRoot) 1건에 대해 동일 메커니즘을 검증한다.
 * Phase 2에서 다중 학생(StudentRegistry / MultiMirror*)으로 확장된다.
 */
export class TeacherMode implements ClassSyncMode {
	readonly role = "teacher" as const;
	readonly tester: PocTester;

	constructor(private core: CoreServices) {
		this.tester = new PocTester(core);
	}

	async start(): Promise<void> {
		const s = this.core.settings;
		const rootLabel = s.localRoot ? s.localRoot : "(미지정 — 학생 폴더를 설정하세요)";
		this.core.logger.ok(`Teacher Mode 시작 — 학생 폴더=${rootLabel}, mirror=${s.remoteDb}`, true);
		if (!s.localRoot) {
			this.core.logger.warn("Teacher Mode는 학생 폴더(localRoot)가 필요합니다. 설정에서 지정하세요. (예: 학생A)");
		}
	}

	async stop(): Promise<void> {
		await this.tester.dispose();
		this.core.logger.info("Teacher Mode 정지.");
	}
}
