import PouchDB from "pouchdb-browser";
import { PouchDocBase } from "../model/types";
import { createObsidianFetch } from "./obsidianFetch";

/**
 * PouchDB 기반 동기화 서비스. 기술문서 §23.4 CouchClient 역할을 대체한다.
 *
 * 각 학생 mirror DB는 원격 CouchDB의 한 데이터베이스에 대응한다.
 * PouchDB는 오프라인 큐 / 충돌 / changes / replication을 내장 제공하므로
 * 직접 구현할 필요가 없다. 모바일 CORS는 createObsidianFetch로 우회한다.
 *
 * Phase 0 POC 범위: ping / put(upsert) / get / changes(live) / 로컬↔원격 sync.
 */

export interface ChangeEvent<T = any> {
	id: string;
	deleted: boolean;
	doc?: T;
	seq: number | string;
}

export interface LiveHandle {
	cancel(): void;
}

export interface SyncHandle {
	cancel(): void;
}

export class PouchService {
	private remote: PouchDB.Database;
	private local: PouchDB.Database | null = null;
	private readonly fetchImpl: typeof fetch;

	constructor(
		private baseUrl: string,
		private dbName: string,
		username: string,
		password: string,
	) {
		this.fetchImpl = createObsidianFetch(username, password);
		this.remote = this.openRemote();
	}

	private remoteUrl(): string {
		const base = this.baseUrl.replace(/\/+$/, "");
		return `${base}/${encodeURIComponent(this.dbName)}`;
	}

	private openRemote(): PouchDB.Database {
		return new PouchDB(this.remoteUrl(), {
			// 표준 fetch 대신 requestUrl 기반 fetch 사용 (모바일 CORS 우회)
			fetch: (url: string | Request, opts?: RequestInit) =>
				this.fetchImpl(url as RequestInfo, opts),
			skip_setup: true, // POC: 권한 없으면 자동 DB 생성 시도하지 않음
		} as PouchDB.Configuration.RemoteDatabaseConfiguration);
	}

	/** 연결/권한 테스트. 기술문서 §22.3. 성공 시 db 정보 반환. */
	async ping(): Promise<{ ok: boolean; info?: PouchDB.Core.DatabaseInfo; error?: string }> {
		try {
			const info = await this.remote.info();
			return { ok: true, info };
		} catch (e: any) {
			return { ok: false, error: describeError(e) };
		}
	}

	/**
	 * 진단용: 우리 fetch shim이 DB 루트(GET /{db})에서 실제로 받는 응답을 그대로 확인.
	 * 본문이 비었는지/깨졌는지/정상 JSON인지 판별한다. (iOS 디버깅)
	 */
	async rawInfo(): Promise<{ status: number; length: number; snippet: string }> {
		const resp = await this.fetchImpl(this.remoteUrl(), { method: "GET" });
		const text = await resp.text();
		return { status: resp.status, length: text.length, snippet: text.slice(0, 200) };
	}

	/** 문서 조회. 없으면 null. */
	async get<T extends PouchDocBase>(id: string): Promise<(T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta) | null> {
		try {
			return (await this.remote.get(id)) as unknown as T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
		} catch (e: any) {
			if (e?.status === 404) return null;
			throw e;
		}
	}

	/**
	 * 문서 upsert. 기존 문서가 있으면 현재 _rev를 붙여 갱신한다.
	 * PouchDB가 409(conflict)를 던지면 최신 _rev로 1회 재시도.
	 */
	async put<T extends PouchDocBase>(doc: T): Promise<T & { _rev: string }> {
		const existing = await this.get<T>(doc._id);
		const toPut = existing ? { ...doc, _rev: existing._rev } : { ...doc };
		try {
			const res = await this.remote.put(toPut as any);
			return { ...doc, _rev: res.rev };
		} catch (e: any) {
			if (e?.status === 409) {
				const current = await this.get<T>(doc._id);
				const retry = { ...doc, _rev: current?._rev };
				const res = await this.remote.put(retry as any);
				return { ...doc, _rev: res.rev };
			}
			throw e;
		}
	}

	/** 문서 삭제. */
	async remove(id: string, rev: string): Promise<void> {
		await this.remote.remove(id, rev);
	}

	/**
	 * changes feed 구독 (live). 기술문서 §10. 새 변경마다 onChange 호출.
	 * since="now"면 구독 시작 이후 변경만 받는다.
	 */
	changes<T = any>(
		onChange: (change: ChangeEvent<T>) => void,
		opts: { since?: "now" | number | string; onError?: (e: Error) => void } = {},
	): LiveHandle {
		const feed = this.remote
			.changes({
				live: true,
				since: opts.since ?? "now",
				include_docs: true,
				timeout: false as unknown as number,
			})
			.on("change", (change: any) => {
				onChange({
					id: change.id,
					deleted: !!change.deleted,
					doc: change.doc as T,
					seq: change.seq,
				});
			})
			.on("error", (e: any) => {
				opts.onError?.(e instanceof Error ? e : new Error(describeError(e)));
			});

		return { cancel: () => feed.cancel() };
	}

	/**
	 * 로컬 PouchDB와 원격을 양방향 live 동기화. PouchDB replication 검증용.
	 * 로컬 DB 이름은 보통 mirror DB 이름과 동일하게 둔다.
	 */
	startSync(
		localName: string,
		handlers: {
			onChange?: (info: any) => void;
			onError?: (e: Error) => void;
			onPaused?: () => void;
		} = {},
	): SyncHandle {
		if (!this.local) this.local = new PouchDB(localName);
		const sync = this.local
			.sync(this.remote, { live: true, retry: true })
			.on("change", (info: any) => handlers.onChange?.(info))
			.on("paused", () => handlers.onPaused?.())
			.on("error", (e: any) => handlers.onError?.(e instanceof Error ? e : new Error(describeError(e))));
		return { cancel: () => sync.cancel() };
	}

	/** 리소스 정리 (mode stop / plugin unload). */
	async close(): Promise<void> {
		try {
			await this.remote.close();
		} catch {
			/* noop */
		}
		if (this.local) {
			try {
				await this.local.close();
			} catch {
				/* noop */
			}
		}
	}
}

function describeError(e: any): string {
	if (!e) return "unknown error";
	const status = e.status ? `${e.status} ` : "";
	const name = e.name ? `${e.name}: ` : "";
	return `${status}${name}${e.message ?? e.reason ?? String(e)}`;
}
