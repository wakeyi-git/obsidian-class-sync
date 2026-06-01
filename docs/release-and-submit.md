# 릴리스 & 커뮤니티 플러그인 제출 가이드

Class Sync를 새 버전으로 릴리스하고 Obsidian 커뮤니티 플러그인으로 제출하는 절차.

## 1. 버전 올리기

세 파일의 버전을 **동일하게** 맞춘다(예: `0.8.0`).

- `manifest.json` → `version`
- `package.json` → `version`
- `versions.json` → `"<버전>": "<minAppVersion>"` 항목 추가 (현재 minAppVersion은 `1.11.0`)

> `manifest.json`의 `version`과 `versions.json`의 키, 그리고 릴리스 태그가 **모두 같아야** 한다.

## 2. 릴리스 만들기 (자동)

태그를 push하면 [`.github/workflows/release.yml`](../.github/workflows/release.yml)이 빌드 후
`main.js` · `manifest.json` · `styles.css`를 릴리스 자산으로 첨부한다.

```bash
git tag 0.8.0          # v 접두사 없이 버전 숫자만
git push origin 0.8.0
```

> 태그는 반드시 **`v` 없이** 버전 숫자만 사용(예: `0.8.0`). Obsidian이 자산을 그 태그에서 찾는다.
> `main.js`는 `.gitignore`에 있으므로 저장소에 커밋하지 않고 릴리스 자산으로만 배포한다(표준 패턴).

수동으로 만들 경우: `npm install && npm run build` 후 GitHub 릴리스를 만들어
`main.js`, `manifest.json`, `styles.css` 세 파일을 자산으로 첨부한다.

## 3. 최초 1회: 커뮤니티 목록 등록 PR

1. [`obsidianmd/obsidian-releases`](https://github.com/obsidianmd/obsidian-releases) 포크.
2. `community-plugins.json` 맨 끝에 항목 추가:
   ```json
   {
     "id": "class-sync",
     "name": "Class Sync",
     "author": "wakeyi",
     "description": "Two-way sync between a teacher's per-student folders and each student's vault via CouchDB.",
     "repo": "wakeyi-git/obsidian-class-sync"
   }
   ```
3. PR 생성 → 봇/리뷰어 점검 → 머지되면 커뮤니티 브라우저에 노출.

## 4. 제출 전 자가 점검 (심사 가이드라인)

- [ ] `manifest.json`의 `id`/`name`/`version`/`minAppVersion`/`description`/`author` 정확.
- [ ] 플러그인 `name`에 "Obsidian" 미포함 → **Class Sync** ✓.
- [ ] 릴리스에 `main.js`·`manifest.json`·`styles.css` 자산 첨부됨.
- [ ] `versions.json` 키 = `manifest.version` = 릴리스 태그.
- [ ] `LICENSE` 존재(MIT).
- [ ] `innerHTML`/`outerHTML` 미사용, 콘솔 디버그 로그 없음(오류/경고만).
- [ ] `isDesktopOnly: false` (모바일 지원) — [모바일 체크리스트](mobile-test-checklist.md) 통과.
- [ ] 외부 네트워크 사용(사용자가 지정한 CouchDB/Yjs 서버)을 README에 명시.
- [ ] 자격증명은 로컬 저장, 내보내기 시 제외됨을 README 보안 메모에 명시.
