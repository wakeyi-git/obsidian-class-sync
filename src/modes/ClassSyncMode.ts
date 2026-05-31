import { Role } from "../settings/types";
import { PocTester } from "./PocTester";

/** 역할별 mode 공통 인터페이스. 기술문서 §23.3. */
export interface ClassSyncMode {
	readonly role: Role;
	/** 이 mode가 다루는 검증 루틴. POC 명령이 여기로 위임된다. */
	readonly tester: PocTester;
	start(): Promise<void>;
	stop(): Promise<void>;
}
