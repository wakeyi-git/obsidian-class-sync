import { MirrorContext } from "./MirrorContext";
import { MirrorApplier } from "./MirrorApplier";
import { LiveHandle } from "../couch/PouchService";
import { NoteDoc } from "../model/types";

/**
 * 로컬 PouchDB changes 구독 → vault 반영. 기술문서 §10 / §17.2.
 *
 * replication이 원격 변경을 로컬 DB에 가져오면 로컬 changes로 흘러들어오고, 이를 vault에 적용한다.
 * 내 업로드(vault→로컬 DB)도 여기로 돌아오지만 Applier가 deviceId/해시로 무시한다.
 * 저장된 local seq부터 재개(증분)하고, 처리 후 seq를 체크포인트한다(영속).
 */
export class LocalApplier {
	private handle: LiveHandle | null = null;

	constructor(
		private ctx: MirrorContext,
		private applier: MirrorApplier,
	) {}

	start(): void {
		if (this.handle) return;
		const since = this.parseSince(this.ctx.getLastSeq());
		this.ctx.logger.info(`LocalApplier 시작: ${this.ctx.remoteDb} (since=${since === 0 ? "처음" : since})`);

		this.handle = this.ctx.pouch.localChanges<NoteDoc & { _conflicts?: string[] }>(
			async (change) => {
				try {
					if (change.deleted) {
						// PouchDB hard-remove(purge)가 전파됨 → 아카이브 사본 정리
						await this.applier.applyPurge(change.id);
					} else if (change.doc && (change.doc as any).type === "note") {
						await this.applier.applyDoc(change.doc);
					} else if (change.doc && (change.doc as any).type === "asset") {
						await this.applier.applyAsset(change.doc as any);
					}
				} catch (e) {
					this.ctx.logger.error(`로컬 변경 적용 실패: ${change.id} — ${e instanceof Error ? e.message : String(e)}`);
				} finally {
					this.ctx.setLastSeq(String(change.seq));
				}
			},
			{
				since,
				onError: (e) => this.ctx.logger.error(`로컬 changes 오류: ${e.message}`),
			},
		);
	}

	stop(): void {
		this.handle?.cancel();
		this.handle = null;
	}

	/** 로컬 seq는 숫자다. (구버전에 저장된 원격 seq 문자열은 0으로 폴백 → 안전하게 재처리.) */
	private parseSince(raw: string | undefined): number {
		if (raw && /^\d+$/.test(raw)) return Number(raw);
		return 0;
	}
}
