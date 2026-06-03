// i18n 점검: en.ts 중복키(실패) + t() 사용 키 중 en.ts 누락(경고). 누락은 한국어로 폴백되므로 경고만.
import fs from "node:fs";
import path from "node:path";

function walk(dir) {
	let out = [];
	for (const f of fs.readdirSync(dir)) {
		const p = path.join(dir, f);
		const s = fs.statSync(p);
		if (s.isDirectory()) out = out.concat(walk(p));
		else if (f.endsWith(".ts") && !f.endsWith(".test.ts") && !p.includes("i18n/en.ts") && !p.includes("i18n/index.ts"))
			out.push(p);
	}
	return out;
}

const en = fs.readFileSync("src/i18n/en.ts", "utf8");

// 1) 중복 키 (실패)
const keyMatches = [...en.matchAll(/^\t"((?:[^"\\]|\\.)*)":/gm)].map((m) => m[1]);
const seen = new Set();
const dups = [];
for (const k of keyMatches) (seen.has(k) ? dups.push(k) : seen.add(k));

// 2) 사용 키 중 en 누락 (경고)
const enKeys = new Set(keyMatches.map((k) => k.replace(/\\"/g, '"')));
const used = new Set();
for (const file of walk("src")) {
	const src = fs.readFileSync(file, "utf8");
	for (const m of src.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) used.add(m[1].replace(/\\"/g, '"'));
}
const missing = [...used].filter((k) => !enKeys.has(k));

console.log(`i18n: en 키 ${keyMatches.length}개, 사용 t() ${used.size}개, 중복 ${dups.length}, 누락 ${missing.length}`);
if (missing.length) {
	console.warn("⚠ en.ts 누락(한국어 폴백):");
	for (const k of missing) console.warn("   " + JSON.stringify(k));
}
if (dups.length) {
	console.error("✗ en.ts 중복 키:", dups);
	process.exit(1); // 중복만 실패
}
