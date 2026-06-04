export type SharedStatus = "unprovisioned" | "needs-redeploy" | "deployed";

function sameSet(a: string[], b: string[]): boolean {
	if (a.length !== b.length) return false;
	const s = new Set(a);
	return b.every((x) => s.has(x));
}

/** 공유 공간 운영 상태(순수). 멤버가 배포 이후 바뀌면 재배포 필요. */
export function sharedSpaceStatus(sp: {
	provisioned?: boolean;
	members: string[];
	lastMemberSnapshot?: string[];
}): SharedStatus {
	if (!sp.provisioned) return "unprovisioned";
	if (sp.lastMemberSnapshot && !sameSet(sp.members, sp.lastMemberSnapshot)) return "needs-redeploy";
	return "deployed";
}
