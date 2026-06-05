// 인메모리 Vault + App. 동기화 엔진(MirrorContext)이 호출하는 vault API만 충실히 구현한다.
import { TFile, TFolder, TAbstractFile, normalizePath } from "obsidian";

function byteLen(s: string): number {
	return new TextEncoder().encode(s).length;
}

interface Entry {
	file: TFile;
	content?: string; // markdown 등 텍스트
	binary?: ArrayBuffer; // 첨부
}

/** Obsidian Vault의 인메모리 대체물. 실제 엔진이 그대로 사용한다. */
export class InMemoryVault {
	private files = new Map<string, Entry>();
	private folders = new Set<string>();
	constructor(private vaultName = "test-vault") {}

	getName(): string {
		return this.vaultName;
	}

	getAbstractFileByPath(path: string): TAbstractFile | null {
		const p = normalizePath(path);
		const e = this.files.get(p);
		if (e) return e.file;
		if (this.folders.has(p)) return Object.assign(new TFolder(p), {});
		return null;
	}

	async read(file: TFile): Promise<string> {
		const e = this.files.get(normalizePath(file.path));
		if (!e || e.content == null) throw new Error(`read: not a text file: ${file.path}`);
		return e.content;
	}

	async cachedRead(file: TFile): Promise<string> {
		return this.read(file);
	}

	async readBinary(file: TFile): Promise<ArrayBuffer> {
		const e = this.files.get(normalizePath(file.path));
		if (!e || e.binary == null) throw new Error(`readBinary: not a binary file: ${file.path}`);
		return e.binary;
	}

	/** 백그라운드 atomic 쓰기(가이드라인 권장 API). */
	async process(file: TFile, fn: (data: string) => string): Promise<string> {
		const p = normalizePath(file.path);
		const e = this.files.get(p);
		if (!e || e.content == null) throw new Error(`process: not a text file: ${file.path}`);
		const next = fn(e.content);
		e.content = next;
		e.file.stat.size = byteLen(next);
		return next;
	}

	async create(path: string, content: string): Promise<TFile> {
		const p = normalizePath(path);
		if (this.files.has(p)) throw new Error(`create: already exists: ${p}`);
		const file = new TFile(p, byteLen(content));
		this.files.set(p, { file, content });
		return file;
	}

	async createBinary(path: string, data: ArrayBuffer): Promise<TFile> {
		const p = normalizePath(path);
		if (this.files.has(p)) throw new Error(`createBinary: already exists: ${p}`);
		const file = new TFile(p, data.byteLength);
		this.files.set(p, { file, binary: data });
		return file;
	}

	async modifyBinary(file: TFile, data: ArrayBuffer): Promise<void> {
		const e = this.files.get(normalizePath(file.path));
		if (!e) throw new Error(`modifyBinary: missing: ${file.path}`);
		e.binary = data;
		e.file.stat.size = data.byteLength;
	}

	async createFolder(path: string): Promise<TFolder> {
		const p = normalizePath(path);
		this.folders.add(p);
		return new TFolder(p);
	}

	/** trash(file, false) = vault 내 삭제. 테스트에선 단순 제거. */
	async trash(file: TFile, _system: boolean): Promise<void> {
		this.files.delete(normalizePath(file.path));
	}
	async delete(file: TFile): Promise<void> {
		this.files.delete(normalizePath(file.path));
	}

	getFiles(): TFile[] {
		return [...this.files.values()].map((e) => e.file);
	}
	getMarkdownFiles(): TFile[] {
		return this.getFiles().filter((f) => f.extension === "md");
	}

	/** fileManager.renameFile 구현 위임. */
	rename(file: TFile, toPath: string): void {
		const from = normalizePath(file.path);
		const to = normalizePath(toPath);
		const e = this.files.get(from);
		if (!e) throw new Error(`rename: missing: ${from}`);
		this.files.delete(from);
		e.file.path = to;
		e.file.name = to.split("/").pop() ?? to;
		this.files.set(to, e);
	}

	// --- 테스트 헬퍼 ---
	has(path: string): boolean {
		return this.files.has(normalizePath(path));
	}
	textOf(path: string): string | undefined {
		return this.files.get(normalizePath(path))?.content;
	}
	/** 엔진을 거치지 않고 직접 파일을 심는다(초기 상태 구성용). */
	seed(path: string, content: string): TFile {
		const p = normalizePath(path);
		const file = new TFile(p, byteLen(content));
		this.files.set(p, { file, content });
		return file;
	}
	seedBinary(path: string, data: ArrayBuffer): TFile {
		const p = normalizePath(path);
		const file = new TFile(p, data.byteLength);
		this.files.set(p, { file, binary: data });
		return file;
	}
	allPaths(): string[] {
		return [...this.files.keys()];
	}
}

/** CoreServices가 받는 App 형태. vault + fileManager만 쓴다. */
export function makeApp(appId: string, vaultName: string): { app: any; vault: InMemoryVault } {
	const vault = new InMemoryVault(vaultName);
	const app = {
		appId,
		vault,
		fileManager: {
			renameFile: async (file: TFile, toPath: string) => vault.rename(file, toPath),
		},
	};
	return { app, vault };
}
