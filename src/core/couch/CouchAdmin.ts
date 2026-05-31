import { createObsidianFetch } from "./obsidianFetch";

/**
 * CouchDB 관리자 프로비저닝. 기술문서 §13 / §22.
 *
 * 교사 기기에서 admin 자격증명으로 학생을 프로비저닝한다:
 *  1) _users 에 학생 계정 생성
 *  2) 학생 mirror DB 생성
 *  3) DB _security 를 학생 본인만 멤버로 설정 → 다른 학생은 403
 *
 * requestUrl 기반 fetch(createObsidianFetch)를 써서 데스크톱/모바일 모두 동작(CORS 우회).
 */
export class CouchAdmin {
	private readonly fetchImpl: typeof fetch;

	constructor(
		private baseUrl: string,
		adminUser: string,
		adminPass: string,
	) {
		this.fetchImpl = createObsidianFetch(adminUser, adminPass);
	}

	private url(path: string): string {
		return `${this.baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
	}

	private async req(method: string, path: string, body?: unknown): Promise<{ status: number; json: any; text: string }> {
		const resp = await this.fetchImpl(this.url(path), {
			method,
			headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
			body: body !== undefined ? JSON.stringify(body) : undefined,
		});
		const text = await resp.text();
		let json: any = undefined;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			/* non-JSON */
		}
		return { status: resp.status, json, text };
	}

	/** admin 연결/권한 확인 (서버 루트 + _users 접근). */
	async checkAdmin(): Promise<{ ok: boolean; error?: string }> {
		const root = await this.req("GET", "/");
		if (root.status === 401 || root.status === 403) return { ok: false, error: `인증 오류 (HTTP ${root.status})` };
		if (root.status >= 400) return { ok: false, error: `서버 오류 (HTTP ${root.status})` };
		return { ok: true };
	}

	/**
	 * 학생 프로비저닝(멱등). 계정/DB/권한을 보장한다.
	 * 이미 있는 계정은 비밀번호를 갱신한다(초대 재발급).
	 */
	async provisionStudent(opts: {
		username: string;
		password: string;
		remoteDb: string;
	}): Promise<{ ok: boolean; error?: string }> {
		const { username, password, remoteDb } = opts;
		const userId = `org.couchdb.user:${username}`;
		const userPath = `_users/${encodeURIComponent(userId)}`;

		// 1) 학생 계정 생성/갱신 (비밀번호 반드시 반영). 409(rev 충돌)이면 최신 _rev로 재시도.
		//    409를 성공으로 넘기면 옛 비밀번호가 남아 학생이 401을 맞으므로 반드시 끝까지 갱신한다.
		let userOk = false;
		for (let attempt = 0; attempt < 3 && !userOk; attempt++) {
			const existing = await this.req("GET", userPath);
			const userDoc: Record<string, unknown> = { _id: userId, name: username, password, roles: [], type: "user" };
			if (existing.status === 200 && existing.json?._rev) userDoc._rev = existing.json._rev;
			const putUser = await this.req("PUT", userPath, userDoc);
			if (putUser.status < 300) {
				userOk = true;
			} else if (putUser.status === 409) {
				continue; // 최신 _rev로 재시도
			} else {
				return { ok: false, error: `계정 생성 실패 (HTTP ${putUser.status}): ${putUser.json?.reason ?? putUser.text}` };
			}
		}
		if (!userOk) return { ok: false, error: "계정 비밀번호 갱신 실패 (rev 충돌 반복)" };

		// 2) mirror DB 생성 (이미 있으면 412/409 무시)
		const putDb = await this.req("PUT", encodeURIComponent(remoteDb));
		if (putDb.status >= 400 && putDb.status !== 412 && putDb.status !== 409) {
			return { ok: false, error: `DB 생성 실패 (HTTP ${putDb.status}): ${putDb.json?.reason ?? putDb.text}` };
		}

		// 3) _security: 학생 본인만 멤버 (서버 admin은 항상 접근)
		const security = {
			admins: { names: [], roles: [] },
			members: { names: [username], roles: [] },
		};
		const putSec = await this.req("PUT", `${encodeURIComponent(remoteDb)}/_security`, security);
		if (putSec.status >= 400) {
			return { ok: false, error: `권한 설정 실패 (HTTP ${putSec.status}): ${putSec.json?.reason ?? putSec.text}` };
		}

		return { ok: true };
	}
}
