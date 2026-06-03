/**
 * Excalidraw가 원격 커서·선택 영역에 쓰는 색과 **정확히 동일하게** 계산한다.
 * (Excalidraw clients.ts getClientColor: collaborator.color를 무시하고 clientId 문자열 해시로 HSL을 만든다.)
 * 참가자 칩을 이 색으로 칠해야 커서·선택 영역과 색이 일치한다. (의존성 없는 순수 모듈 → 단위 테스트.)
 */
export function clientColor(id: string): string {
	let hash = 0;
	for (let i = 0; i < id.length; i++) hash = (hash << 5) - hash + id.charCodeAt(i);
	const hue = (Math.abs(hash) % 37) * 10;
	return `hsl(${hue}, 100%, 83%)`;
}
