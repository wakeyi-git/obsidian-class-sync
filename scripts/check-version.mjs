// 버전 정합 검사: manifest.json == package.json == versions.json 최신 키, 그리고 minAppVersion 항목 존재.
import fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const versions = JSON.parse(fs.readFileSync("versions.json", "utf8"));

const v = manifest.version;
const errs = [];
if (pkg.version !== v) errs.push(`package.json(${pkg.version}) != manifest.json(${v})`);
if (!(v in versions)) errs.push(`versions.json에 "${v}" 항목 없음`);
else if (versions[v] !== manifest.minAppVersion)
	errs.push(`versions.json["${v}"](${versions[v]}) != manifest.minAppVersion(${manifest.minAppVersion})`);

if (errs.length) {
	console.error("✗ 버전 정합 실패:");
	for (const e of errs) console.error("   " + e);
	process.exit(1);
}
console.log(`version: ${v} (minApp ${manifest.minAppVersion}) — manifest/package/versions 정합 OK`);
