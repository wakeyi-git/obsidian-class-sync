import { Role } from "../settings/types";
import { SyncDirection } from "../core/sync/FullSync";
import { MirrorSync } from "../core/sync/MirrorSync";

/** 역할별 mode 공통 인터페이스. 기술문서 §23.3. Teacher는 다중 학생이므로 메서드로 노출. */
export interface ClassSyncMode {
	readonly role: Role;
	start(): Promise<void>;
	stop(): Promise<void>;
	/** 수동 전체 동기화 (Teacher는 전체 학생에 적용). */
	fullSync(direction: SyncDirection): Promise<void>;
	/** 이 모드의 동기화 링크들 (Student=1, Teacher=학생 수). 충돌 목록 집계 등에 사용. */
	getSyncs(): MirrorSync[];
}
