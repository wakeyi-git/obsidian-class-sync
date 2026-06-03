/** 첨부 크기 제한 판정(순수 함수). maxMB<=0이면 무제한(항상 false). */
export function exceedsAttachmentLimit(sizeBytes: number, maxMB: number): boolean {
	if (!maxMB || maxMB <= 0) return false;
	return sizeBytes > maxMB * 1024 * 1024;
}
