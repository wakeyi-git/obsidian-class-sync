# Class Sync for Obsidian

교사용 vault의 **학생별 폴더**와 **학생 개인 vault**를 양방향으로 동기화하는 Obsidian 플러그인입니다.
중앙 서버로 **CouchDB**(시놀로지 NAS 등 자가 호스팅)를 사용하고, 클라이언트는 **PouchDB**로 구현합니다.

```
TeacherVault/
├─ 학생A/  ⇄  mirror_student_a  ⇄  StudentA Vault/
├─ 학생B/  ⇄  mirror_student_b  ⇄  StudentB Vault/
└─ 학생C/  ⇄  mirror_student_c  ⇄  StudentC Vault/
```

하나의 플러그인을 배포하고, 사용자는 설정에서 **Student Mode** 또는 **Teacher Mode** 역할을 선택합니다.
학생은 자기 vault에서 평소처럼 노트를 작성하고, 교사는 하나의 vault에서 학생별 폴더를 관리합니다.
학생별 데이터 격리는 CouchDB의 데이터베이스별 권한(`_security`)으로 서버에서 강제됩니다.

> 전체 설계는 [`기술문서.md`](기술문서.md)를 참고하세요.

---

## 현재 상태: Phase 0 (기술 검증 POC) ✅

핵심 동기화 메커니즘이 **Mac · iOS** Obsidian에서 실제 CouchDB 서버를 상대로 검증되었습니다.

| 검증 항목 | 상태 |
|---|:---:|
| Obsidian vault 파일 읽기/쓰기 | ✅ |
| CouchDB 문서 put/get | ✅ |
| changes feed 실시간 수신 | ✅ |
| remote apply guard (동기화 루프 차단) | ✅ |
| 역할 기반 mode 전환 (Student ⇄ Teacher) | ✅ |
| 모바일 동작 (`requestUrl` fetch shim으로 CORS 우회) | ✅ |

아직 자동 동기화 엔진(파일 감지·자동 반영)은 **Phase 1**에서 구현됩니다. 현재는 검증용 수동 명령으로 동작합니다.

---

## 설치 (개발 빌드)

```bash
git clone https://github.com/wakeyi-git/obsidian-class-sync.git
cd obsidian-class-sync
npm install
npm run build      # main.js 생성 (개발 중에는 npm run dev 로 watch)
```

빌드 산출물 **`main.js` · `manifest.json` · `styles.css`** 세 파일을 테스트 vault의
`<vault>/.obsidian/plugins/class-sync/` 에 복사한 뒤, Obsidian 설정 → 커뮤니티 플러그인에서
**Class Sync** 를 활성화합니다.

> **모바일(iOS/Android)**: 같은 세 파일을 폰 vault의 같은 경로에 넣습니다. iCloud로 동기화되는
> vault라면 데스크톱에서 복사한 파일이 폰에 따라옵니다. 적용 후 Obsidian 앱을 완전히 종료했다 다시 엽니다.

---

## CouchDB 준비 (시놀로지 NAS Docker 예시)

```bash
docker run -d --name couchdb -p 5984:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD='****' couchdb:3
```

1. 학생별 mirror DB 생성 — 예: `mirror_student_a`
2. HTTPS 권장 (시놀로지 리버스 프록시 + Let's Encrypt)
3. CORS는 **선택 사항**입니다. 이 플러그인은 Obsidian `requestUrl`로 CORS를 우회하므로 없어도
   동작하지만, Fauxton 등 브라우저 도구를 쓰려면 켜두면 편합니다. Obsidian origin:
   - `app://obsidian.md` (데스크톱) · `capacitor://localhost` (iOS) · `http://localhost` (Android)
4. 학생 계정은 자기 mirror DB에만, 교사 계정은 모든 mirror DB에 read/write 권한 부여 (기술문서 §13, §22)

---

## 사용 (Phase 0 POC 명령)

설정 탭에서 역할 / CouchDB URL / 계정 / Mirror DB / localRoot 를 입력하고 **연결 테스트**를 누릅니다.
이후 명령 팔레트(`Cmd/Ctrl+P`)에서 `Class Sync:` 로 검색하면 검증 명령이 나옵니다.

| 명령 | 검증 내용 |
|---|---|
| 연결/권한 테스트 | CouchDB 연결과 인증 (HTTP 상태로 정직하게 판정) |
| 문서 put/get 테스트 | 문서 왕복 및 contentHash 일치 |
| changes feed 구독 시작/중지 | 원격 변경 실시간 수신 |
| vault 파일 쓰기/읽기 테스트 | Obsidian 파일 입출력 |
| 원격→로컬 적용 + guard 테스트 | 동기화 루프 차단 |
| 로컬↔원격 sync 시작/중지 | PouchDB replication |
| 역할 전환 (student ⇄ teacher) | mode 전환 |

좌측 리본의 🔄 아이콘 또는 `Class Sync: 로그 패널 열기` 로 결과 로그를 볼 수 있습니다.

---

## 아키텍처

```
src/
├─ main.ts                     # 진입점, 역할 기반 mode 전환, 명령 등록
├─ settings/                   # 설정 타입 + 설정 탭 UI
├─ core/
│  ├─ couch/PouchService.ts    # PouchDB 래퍼 (ping/put/get/changes/sync)
│  ├─ couch/obsidianFetch.ts   # requestUrl 기반 fetch shim (모바일 CORS 우회)
│  ├─ guard/RemoteApplyGuard.ts# 동기화 루프 차단
│  ├─ path/  hash/  log/       # 경로 매핑 · contentHash · 로거
│  └─ model/types.ts           # 문서 모델 (note 등)
├─ modes/                      # ClassSyncMode / StudentMode / TeacherMode / PocTester
└─ ui/LogView.ts               # 로그 패널
```

---

## 로드맵 (기술문서 §24)

- [x] **Phase 0** — 기술 검증 POC (현재)
- [ ] **Phase 1** — 단일 학생 양방향 미러 MVP (자동 파일 감지·반영)
- [ ] **Phase 2** — 다중 학생 Teacher Mode
- [ ] **Phase 3** — 이동/삭제/충돌 처리
- [ ] **Phase 4** — 교사 편의 복사 명령
- [ ] **Phase 5** — 첨부파일 · 안정화
- [ ] **Phase 6** — Yjs 기반 글자 단위 실시간 공동 편집 (저장 백엔드와 독립적인 확장 레이어)

---

## 라이선스

[MIT](LICENSE)
