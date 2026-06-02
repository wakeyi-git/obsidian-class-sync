import { App, MarkdownView, TFile } from "obsidian";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { EditorView } from "@codemirror/view";
import { CoreServices } from "../CoreServices";
import { bindView, unbindView } from "./editorBinding";

interface Session {
	file: string;
	ydoc: Y.Doc;
	ytext: Y.Text;
	provider: WebsocketProvider;
	ready: boolean; // 서버 동기화 + 시드 완료 → 바인딩 가능
	bound: Set<EditorView>;
	snapTimer?: number; // 주기적 CouchDB 스냅샷 타이머(§19.2)
	lastSnapshot?: string; // 마지막으로 스냅샷한 내용(중복 쓰기 방지)
}

/** 실시간 스냅샷을 받을 대상(담당 MirrorSync). main이 경로로 해결해 준다. */
export interface SnapshotTarget {
	snapshotNote(localPath: string, content: string): Promise<unknown>;
}

const COLORS = ["#e11d48", "#2563eb", "#16a34a", "#d97706", "#7c3aed", "#0891b2", "#db2777", "#65a30d"];

/**
 * Yjs 실시간 공동 편집 관리. 기술문서 §19. 공유 폴더 markdown 문서에만 적용.
 *
 * 열린 에디터를 훑어 공유 파일이면 세션(WebSocket provider + Y.Doc)을 띄우고 CM6에 바인딩한다.
 * 파일이 모두 닫히면 세션을 종료하며 vault에 스냅샷을 저장(→ CouchDB로 영속).
 */
export class RealtimeManager {
	private sessions = new Map<string, Session>();

	constructor(
		private app: App,
		private core: CoreServices,
		/** 현재 사용자의 공유 공간 목록(교사=설정, 학생=shares). main이 주입. */
		private getSpaces: () => Array<{ id: string; folder: string }>,
		/** 로컬 경로 → 담당 동기화 링크(스냅샷 쓰기용). main이 현재 mode 기준으로 주입. */
		private getSyncForPath: (localPath: string) => SnapshotTarget | undefined = () => undefined,
	) {}

	private get settings() {
		return this.core.settings;
	}

	/** 실시간 세션 중인 파일인가 (applier 공존 판단용). */
	isActive(localPath: string): boolean {
		return this.sessions.has(localPath);
	}

	/** 해당 파일의 접속자 수(본인 포함). 세션 없으면 0. */
	presenceFor(localPath: string): number {
		const session = this.sessions.get(localPath);
		if (!session || !session.ready) return 0;
		try {
			return session.provider.awareness.getStates().size;
		} catch {
			return 0;
		}
	}

	/** 열린 markdown 에디터를 훑어 세션을 맞춘다. workspace 이벤트마다 호출. */
	syncOpenEditors(): void {
		const s = this.settings;
		const on = s.realtimeEnabled && !!s.yjsServerUrl && !!s.yjsToken;

		// 열린 공유 markdown 파일 → 뷰들
		const byPath = new Map<string, MarkdownView[]>();
		if (on) {
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view as MarkdownView;
				const file = view?.file;
				if (!file || file.extension !== "md") continue;
				if (!this.spaceFor(file.path)) continue;
				const arr = byPath.get(file.path) ?? [];
				arr.push(view);
				byPath.set(file.path, arr);
			}
		}

		// 더는 열려 있지 않은 세션 종료
		for (const path of [...this.sessions.keys()]) {
			if (!byPath.has(path)) void this.endSession(path);
		}

		// 열린 공유 파일에 세션 보장 + 바인딩
		for (const [path, views] of byPath) {
			let session = this.sessions.get(path);
			if (!session) session = this.startSession(path);
			if (session?.ready) this.bindViews(session, views);
		}
	}

	private startSession(path: string): Session | undefined {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) return undefined;
		const space = this.spaceFor(path);
		if (!space) return undefined;

		const room = this.roomFor(path, space);
		if (!room) return undefined;
		const dbPath = path.slice(space.folder.length + 1);

		const ydoc = new Y.Doc();
		const ytext = ydoc.getText("content");
		const provider = new WebsocketProvider(this.settings.yjsServerUrl, room, ydoc, {
			params: { token: this.settings.yjsToken },
		});

		const color = COLORS[Math.abs(hash(this.settings.deviceId)) % COLORS.length];
		provider.awareness.setLocalStateField("user", { name: this.settings.displayName || "사용자", color });

		const session: Session = { file: path, ydoc, ytext, provider, ready: false, bound: new Set() };
		this.sessions.set(path, session);

		provider.on("status", (e: { status: string }) => {
			if (e.status === "connected") this.core.logger.info(`실시간 연결: ${dbPath}`);
		});
		provider.once("sync", (synced: boolean) => {
			if (!synced) return;
			// 잠깐 기다려 다른 접속자/서버 상태가 반영된 뒤 시드 판단(시드 충돌 방지)
			window.setTimeout(() => void this.onSynced(session, file), 400);
		});
		this.core.logger.info(`실시간 세션 시작: ${dbPath} (room=${room})`);
		return session;
	}

	private async onSynced(session: Session, file: TFile): Promise<void> {
		// 이미 교체/종료된 세션이면(setTimeout 대기 중 endSession 발생) 무시 — 좀비 타이머/바인딩 방지.
		if (this.sessions.get(session.file) !== session) return;
		try {
			if (session.ytext.length === 0) {
				// 단일 시드: 나 혼자일 때만 파일 내용으로 시드. 다른 참여자가 있으면 그들의 공유 내용을 받는다.
				// (여러 명이 서로 다른 파일 내용을 시드하면 문서가 뒤섞여 깨진다.)
				const others = session.provider.awareness.getStates().size; // 본인 포함
				if (others <= 1) {
					const content = await this.app.vault.read(file);
					if (content.length > 0) {
						session.ytext.insert(0, content);
						this.core.logger.info(`실시간 시드(첫 진입): ${session.file}`);
					}
				} else {
					this.core.logger.info(`실시간: 다른 참여자 있음 → 시드 생략, 공유 내용 사용 (${session.file})`);
				}
			}
		} catch {
			/* 읽기 실패 무시 */
		}
		session.ready = true;
		session.lastSnapshot = session.ytext.toString();
		this.maybeStartSnapshot(session);
		this.syncOpenEditors(); // 이제 바인딩
	}

	/** 주기적 CouchDB 스냅샷 타이머 시작(§19.2). snapshotSec>0일 때만. */
	private maybeStartSnapshot(session: Session): void {
		const sec = this.settings.realtimeSnapshotSec;
		if (!sec || sec <= 0 || session.snapTimer != null) return;
		session.snapTimer = window.setInterval(() => void this.snapshotTick(session), Math.max(5, sec) * 1000);
		this.core.logger.info(`실시간 주기 스냅샷 활성: ${session.file} (${sec}s)`);
	}

	private async snapshotTick(session: Session): Promise<void> {
		try {
			if (!session.ready || !this.isSnapshotLeader(session)) return;
			const content = session.ytext.toString();
			if (content === session.lastSnapshot || content.length === 0) return; // 변화 없음/빈 내용 방지
			const target = this.getSyncForPath(session.file);
			if (!target) return;
			const res = await target.snapshotNote(session.file, content);
			session.lastSnapshot = content;
			this.core.logger.info(`주기 스냅샷 → CouchDB: ${session.file} (${String(res)})`);
		} catch (e) {
			this.core.logger.warn(`주기 스냅샷 실패: ${session.file} — ${e instanceof Error ? e.message : String(e)}`);
		}
	}

	/** 단일 작성자 선출: 내 clientID가 현재 awareness 최소면 내가 쓴다(동시 작성 → 충돌 방지). */
	private isSnapshotLeader(session: Session): boolean {
		try {
			const states = session.provider.awareness.getStates();
			const myId = session.provider.awareness.clientID;
			let min = myId;
			for (const id of states.keys()) if (id < min) min = id;
			return myId === min;
		} catch {
			return false;
		}
	}

	/** 실시간 상태 점검(명령). 왜 세션이 안 뜨는지 진단용. */
	diagnose(): void {
		const s = this.settings;
		const log = this.core.logger;
		log.info(
			`실시간 점검 — enabled=${s.realtimeEnabled}, url=${s.yjsServerUrl ? "설정됨" : "없음"}, token=${s.yjsToken ? "설정됨" : "없음"}`,
			true,
		);
		log.info(`공유 폴더: ${this.getSpaces().map((x) => x.folder).join(", ") || "(없음)"}`);
		const f = this.app.workspace.getActiveFile();
		const space = f ? this.spaceFor(f.path) : null;
		log.info(`활성 파일: ${f?.path ?? "(없음)"} → 공유공간: ${f ? (space?.id ?? "아님(공유폴더 밖)") : "-"}`);
		// room 이름(교사·학생이 정확히 같아야 실시간 공유됨)
		const room = f && space ? this.roomFor(f.path, space) : null;
		log.info(`room: ${room ?? "(없음)"}  [교사·학생이 이 값이 완전히 같아야 함]`);
		const session = f ? this.sessions.get(f.path) : undefined;
		log.info(
			`세션: ${session ? (session.ready ? "ready" : "연결중") : "없음"}, 연결=${session ? (session.provider as any).wsconnected : "-"}, 접속자=${f ? this.presenceFor(f.path) : 0}`,
		);
		const md = this.app.workspace.getActiveViewOfType(MarkdownView);
		const cm = md ? (md.editor as unknown as { cm?: EditorView }).cm : undefined;
		log.info(`활성 에디터 CM6 접근: ${cm ? "가능(편집모드)" : "불가(읽기 모드면 편집모드로 여세요)"}`);
	}

	private bindViews(session: Session, views: MarkdownView[]): void {
		for (const view of views) {
			const cm = (view.editor as unknown as { cm?: EditorView }).cm;
			if (!cm) {
				this.core.logger.warn(`실시간: 에디터(CM6) 접근 불가 — ${session.file} (읽기 모드면 편집 모드로 여세요)`);
				continue;
			}
			if (session.bound.has(cm)) continue;
			try {
				bindView(cm, session.ytext, session.provider.awareness);
				session.bound.add(cm);
			} catch (e) {
				this.core.logger.error(`실시간 바인딩 실패: ${session.file} — ${e instanceof Error ? e.message : String(e)}`);
			}
		}
	}

	private async endSession(path: string): Promise<void> {
		const session = this.sessions.get(path);
		if (!session) return;
		this.sessions.delete(path);

		if (session.snapTimer != null) window.clearInterval(session.snapTimer);

		// 내 awareness를 명시적으로 제거(null) → 모든 피어가 즉시 커서/이름을 지운다.
		// (provider.destroy()는 소켓만 닫아 서버 정리에 의존 → 서버가 정리 안 하면 유령 커서가 남음.)
		try {
			session.provider.awareness.setLocalState(null);
		} catch {
			/* noop */
		}

		// 바인딩 해제
		for (const cm of session.bound) {
			try {
				unbindView(cm);
			} catch {
				/* 뷰가 이미 사라졌을 수 있음 */
			}
		}

		// 스냅샷 영속: Y.Text → vault (변경 시) → LocalWatcher가 CouchDB 업로드
		try {
			const file = this.app.vault.getAbstractFileByPath(path);
			if (file instanceof TFile) {
				const content = session.ytext.toString();
				const current = await this.app.vault.read(file);
				if (content !== current) {
					// 안전장치: 빈 내용으로 기존 내용을 덮어쓰지 않음(데이터 손실 방지)
					if (content.length === 0 && current.length > 0) {
						this.core.logger.warn(`실시간 스냅샷 생략(빈 내용 덮어쓰기 방지): ${path}`);
					} else {
						await this.app.vault.modify(file, content);
						this.core.logger.ok(`실시간 스냅샷 저장: ${path}`);
					}
				}
			}
		} catch (e) {
			this.core.logger.error(`스냅샷 저장 실패: ${path} — ${e instanceof Error ? e.message : String(e)}`);
		}

		session.provider.destroy();
		session.ydoc.destroy();
	}

	/** 파일의 room 이름(모든 멤버가 동일해야 함). */
	private roomFor(localPath: string, space: { id: string; folder: string }): string | null {
		if (localPath !== space.folder && !localPath.startsWith(space.folder + "/")) return null;
		const dbPath = localPath.slice(space.folder.length + 1);
		return `class_${this.settings.classId}/share/${space.id}/${dbPath}`;
	}

	/** 파일 경로가 속한 공유 공간(있으면). 보관/충돌/제외 폴더 아래 파일은 실시간 대상이 아니다. */
	private spaceFor(localPath: string): { id: string; folder: string } | null {
		for (const sp of this.getSpaces()) {
			if (!sp.folder) continue;
			if (localPath === sp.folder || localPath.startsWith(sp.folder + "/")) {
				if (this.isExcludedFromRealtime(localPath, sp.folder)) return null;
				return sp;
			}
		}
		return null;
	}

	/**
	 * 보관(_삭제됨)·충돌(_충돌)·제외 폴더 아래 파일인지(실시간 제외).
	 * 보관본이 별도 room으로 실시간 세션을 띄워 협업이 갈라지는 것을 막는다([MirrorContext.isExcluded]와 동일 규칙).
	 */
	private isExcludedFromRealtime(localPath: string, folder: string): boolean {
		const s = this.settings;
		const rel = localPath === folder ? "" : localPath.slice(folder.length + 1);
		const under = (base: string): boolean => !!base && (rel === base || rel.startsWith(base + "/"));
		if (under(s.archiveFolder) || under(s.conflictFolder)) return true;
		for (const f of s.excludeFolders) {
			const ff = f.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
			if (ff && (localPath === ff || localPath.startsWith(ff + "/"))) return true;
		}
		return false;
	}

	/**
	 * 모든 세션을 깨끗이 종료(awareness 제거)한 뒤 다시 맞춘다.
	 * 설정 적용/공유 공간 재배포로 mode가 재시작될 때 호출 → 유령(이전 위치) 커서가 남지 않게 한다.
	 */
	async refresh(): Promise<void> {
		for (const path of [...this.sessions.keys()]) await this.endSession(path);
		this.syncOpenEditors();
	}

	async dispose(): Promise<void> {
		for (const path of [...this.sessions.keys()]) await this.endSession(path);
	}
}

function hash(s: string): number {
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
	return h;
}
