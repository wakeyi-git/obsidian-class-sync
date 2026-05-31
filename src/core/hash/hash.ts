/**
 * SHA-256 콘텐츠 해시. 기술문서 §8.1 contentHash, §18.2 동일 해시 업로드 생략에 사용.
 * crypto.subtle은 데스크톱/모바일 Obsidian 모두에서 사용 가능하다.
 */
export async function sha256(data: string | ArrayBuffer): Promise<string> {
	const buffer = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
	const digest = await crypto.subtle.digest("SHA-256", buffer);
	const bytes = new Uint8Array(digest);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}
