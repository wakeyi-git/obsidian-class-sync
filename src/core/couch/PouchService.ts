import PouchDB from "pouchdb-browser";
import { NoteDoc, PouchDocBase } from "../model/types";
import { createObsidianFetch } from "./obsidianFetch";

/**
 * PouchDB 기반 동기화 서비스. 기술문서 §23.4 CouchClient 역할을 대체한다.
 *
 * 오프라인 우선 구조:
 *  - 로컬 PouchDB(IndexedDB)에 읽고 쓴다.
 *  - 로컬 ↔ 원격은 live sync(retry:true)가 자동으로 맞춘다(오프라인 큐·재연결·충돌 리비전).
 *  - 따라서 네트워크가 끊겨도 로컬 쓰기는 큐에 쌓였다가 재연결 시 전파되고,
 *    동시 편집은 PouchDB의 _conflicts(리비전 충돌)로 정확히 감지된다.
 *
 * 연결/권한 테스트(ping/rawInfo)만 원격을 직접 본다. 모바일 CORS는 createObsidianFetch로 우회.
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

export interface ReplicationHandlers {
	onChange?: (direction: "push" | "pull", docs: number) => void;
	onPaused?: (err?: unknown) => void;
	onActive?: () => void;
	onError?: (e: Error) => void;
	onDenied?: (e: unknown) => void;
}

export class PouchService {
	private remote: PouchDB.Database;
	private local: PouchDB.Database | null = null;
	private replication: PouchDB.Replication.Sync<{}> | null = null;
	private readonly fetchImpl: typeof fetch;

	constructor(
		private baseUrl: string,
		private dbName: string,
		username: string,
		password: string,
		private localDbName: string,
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
			fetch: (url: string | Request, opts?: RequestInit) => this.fetchImpl(url as RequestInfo, opts),
			skip_setup: true,
		} as PouchDB.Configuration.RemoteDatabaseConfiguration);
	}

	/** 로컬 PouchDB(지연 생성). vault별로 이름이 달라 같은 기기 다중 vault에서도 충돌하지 않는다. */
	private localDb(): PouchDB.Database {
		if (!this.local) this.local = new PouchDB(this.localDbName);
		return this.local;
	}

	// --- 연결/권한 테스트 (원격 직접) ---

	async ping(): Promise<{ ok: boolean; info?: PouchDB.Core.DatabaseInfo; error?: string }> {
		try {
			const info = await this.remote.info();
			return { ok: true, info };
		} catch (e: any) {
			return { ok: false, error: describeError(e) };
		}
	}

	async rawInfo(): Promise<{ status: number; length: number; snippet: string }> {
		const resp = await this.fetchImpl(this.remoteUrl(), { method: "GET" });
		const text = await resp.text();
		return { status: resp.status, length: text.length, snippet: text.slice(0, 200) };
	}

	// --- 로컬 DB 읽기/쓰기 ---

	async get<T extends PouchDocBase>(id: string): Promise<(T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta) | null> {
		try {
			return (await this.localDb().get(id)) as unknown as T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta;
		} catch (e: any) {
			if (e?.status === 404) return null;
			throw e;
		}
	}

	/** _conflicts 포함 조회(충돌 감지용). */
	async getWithConflicts<T extends PouchDocBase>(
		id: string,
	): Promise<(T & PouchDB.Core.IdMeta & PouchDB.Core.GetMeta & { _conflicts?: string[] }) | null> {
		try {
			return (await this.localDb().get(id, { conflicts: true })) as any;
		} catch (e: any) {
			if (e?.status === 404) return null;
			throw e;
		}
	}

	/** 특정 리비전 조회(충돌 사본 비교용). */
	async getRev<T extends PouchDocBase>(id: string, rev: string): Promise<T | null> {
		try {
			return (await this.localDb().get(id, { rev })) as unknown as T;
		} catch {
			return null;
		}
	}

	/** 로컬 upsert. 기존 _rev를 붙여 갱신, 409 시 1회 재시도. */
	async put<T extends PouchDocBase>(doc: T): Promise<T & { _rev: string }> {
		const db = this.localDb();
		const existing = await this.get<T>(doc._id);
		const toPut = existing ? { ...doc, _rev: existing._rev } : { ...doc };
		try {
			const res = await db.put(toPut as any);
			return { ...doc, _rev: res.rev };
		} catch (e: any) {
			if (e?.status === 409) {
				const current = await this.get<T>(doc._id);
				const res = await db.put({ ...doc, _rev: current?._rev } as any);
				return { ...doc, _rev: res.rev };
			}
			throw e;
		}
	}

	/** 특정 리비전 제거(충돌 해소용). */
	async removeRev(id: string, rev: string): Promise<void> {
		await this.localDb().remove(id, rev);
	}

	/** 로컬 note 문서 전체. */
	async allNotes(): Promise<NoteDoc[]> {
		const res = await this.localDb().allDocs<NoteDoc>({
			include_docs: true,
			startkey: "note:",
			endkey: "note:￿",
		});
		return res.rows.map((r) => r.doc).filter((d): d is NoteDoc & PouchDB.Core.IdMeta & PouchDB.Core.RevisionIdMeta => !!d);
	}

	/** 로컬 변경 구독(라이브). conflicts:true로 충돌 정보를 함께 받는다. */
	localChanges<T = any>(
		onChange: (change: ChangeEvent<T>) => void,
		opts: { since?: number | string; onError?: (e: Error) => void } = {},
	): LiveHandle {
		const feed = this.localDb()
			.changes({
				live: true,
				since: opts.since ?? 0,
				include_docs: true,
				conflicts: true,
				return_docs: false,
			})
			.on("change", (change: any) => {
				onChange({ id: change.id, deleted: !!change.deleted, doc: change.doc as T, seq: change.seq });
			})
			.on("error", (e: any) => {
				opts.onError?.(e instanceof Error ? e : new Error(describeError(e)));
			});
		return { cancel: () => feed.cancel() };
	}

	/** 로컬 changes 체크포인트(재시작 시 증분 적용용). */
	async currentLocalSeq(): Promise<string> {
		const info = await this.localDb().info();
		return String(info.update_seq ?? "0");
	}

	// --- 로컬 ↔ 원격 live replication ---

	/** 1회성 양방향 동기화(push 후 pull). 자동 동기화가 꺼진 상태의 수동 전체 동기화에 사용. */
	async replicateOnce(): Promise<{ pushed: number; pulled: number }> {
		const db = this.localDb();
		const push = await db.replicate.to(this.remote);
		const pull = await db.replicate.from(this.remote);
		return { pushed: push?.docs_written ?? 0, pulled: pull?.docs_written ?? 0 };
	}

	/** 양방향 live 동기화 시작. retry:true로 오프라인/재연결을 자동 처리. */
	startReplication(handlers: ReplicationHandlers = {}): void {
		if (this.replication) return;
		this.replication = this.localDb()
			.sync(this.remote, { live: true, retry: true })
			.on("change", (info: any) => handlers.onChange?.(info.direction, info.change?.docs_written ?? 0))
			.on("paused", (err: any) => handlers.onPaused?.(err))
			.on("active", () => handlers.onActive?.())
			.on("denied", (e: any) => handlers.onDenied?.(e))
			.on("error", (e: any) => handlers.onError?.(e instanceof Error ? e : new Error(describeError(e)))) as any;
	}

	/** 로컬 PouchDB(IndexedDB)를 완전 삭제. 원격을 비운 뒤 깨끗이 다시 받기 위함. */
	async destroyLocal(): Promise<void> {
		this.stopReplication();
		const db = this.localDb();
		await db.destroy(); // IndexedDB 제거 + 닫힘
		this.local = null;
	}

	/** live replication만 중지(로컬/원격 DB는 유지). 인증 실패 시 재시도 폭주를 막는 데 사용. */
	stopReplication(): void {
		if (this.replication) {
			try {
				this.replication.cancel();
			} catch {
				/* noop */
			}
			this.replication = null;
		}
	}

	async close(): Promise<void> {
		if (this.replication) {
			try {
				this.replication.cancel();
			} catch {
				/* noop */
			}
			this.replication = null;
		}
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
			this.local = null;
		}
	}
}

function describeError(e: any): string {
	if (!e) return "unknown error";
	const status = e.status ? `${e.status} ` : "";
	const name = e.name ? `${e.name}: ` : "";
	return `${status}${name}${e.message ?? e.reason ?? String(e)}`;
}
