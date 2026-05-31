import { Role } from "../settings/types";
import { MirrorSync } from "../core/sync/MirrorSync";

/** 역할별 mode 공통 인터페이스. 기술문서 §23.3. */
export interface ClassSyncMode {
	readonly role: Role;
	/** 이 mode의 동기화 엔진. 명령/설정이 여기로 위임된다. */
	readonly sync: MirrorSync;
	start(): Promise<void>;
	stop(): Promise<void>;
}
