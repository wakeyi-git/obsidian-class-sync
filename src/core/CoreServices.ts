import { App } from "obsidian";
import { ClassSyncSettings } from "../settings/types";
import { Logger } from "./log/Logger";
import { RemoteApplyGuard } from "./guard/RemoteApplyGuard";
import { PouchService } from "./couch/PouchService";

/**
 * 역할 공통 core 서비스. 기술문서 §3 / §23.2.
 * mode들이 공유하는 logger, guard, 그리고 현재 설정으로 PouchService를 만드는 팩토리를 제공한다.
 */
export class CoreServices {
	readonly guard = new RemoteApplyGuard();

	constructor(
		public readonly app: App,
		public settings: ClassSyncSettings,
		public readonly logger: Logger,
	) {}

	/** 현재 설정 기준으로 mirror DB(PouchService)를 생성. */
	createPouch(dbName?: string): PouchService {
		const s = this.settings;
		return new PouchService(s.couchdbUrl, dbName ?? s.remoteDb, s.username, s.password);
	}

	dispose(): void {
		this.guard.dispose();
	}
}
