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

**Phase 1(단일 학생 양방향 미러 MVP)**: 자동 동기화 엔진 구현 완료(기기 검증 대기).
역할 최초 1회 설정 후 잠금, 로컬 변경 감시(create/modify) → 자동 업로드, 원격 changes 구독 →
자동 반영, 증분 재개(last_seq 체크포인트), 수동 전체/업로드/다운로드 동기화, preserve-local 충돌 보호.

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

## 사용

**최초 실행 시** 역할 선택 화면(Student / Teacher)이 뜹니다. 역할은 한 번 선택하면 잠기며,
변경하려면 설정의 '역할 재설정'을 사용합니다. 이후 설정 탭에서 CouchDB URL / 계정 / Mirror DB /
localRoot 를 입력하고 **연결 테스트** → **설정 적용**을 누릅니다.

자동 동기화가 켜져 있으면(기본값) 파일 생성·수정이 양방향으로 자동 반영됩니다.
명령 팔레트(`Cmd/Ctrl+P`)에서 `Class Sync:` 로 검색:

| 명령 | 동작 |
|---|---|
| 전체 동기화 | localRoot ↔ mirror DB 전체 정합 (업로드+다운로드) |
| 업로드만 실행 | 로컬 파일을 원격으로 |
| 다운로드만 실행 | 원격 문서를 로컬로 |
| 연결/권한 테스트 | CouchDB 연결과 인증 확인 |
| 자동 동기화 켜기/끄기 | 실시간 감시·구독 토글 |
| 로그 패널 열기 | 동기화 로그 보기 |

좌측 리본의 🔄 아이콘으로도 로그 패널을 열 수 있습니다.

---

## 아키텍처

```
src/
├─ main.ts                     # 진입점, 최초 역할 설정, 명령 등록
├─ settings/                   # 설정 타입 + 설정 탭 UI
├─ core/
│  ├─ couch/PouchService.ts    # PouchDB 래퍼 (ping/put/get/changes/allNotes)
│  ├─ couch/obsidianFetch.ts   # requestUrl 기반 fetch shim (모바일 CORS 우회)
│  ├─ guard/RemoteApplyGuard.ts# 동기화 루프 차단
│  ├─ sync/                    # 동기화 엔진
│  │  ├─ MirrorContext.ts      # 링크별 경로/IO/상태 헬퍼
│  │  ├─ MirrorApplier.ts      # 원격→로컬 적용 (guard, preserve-local)
│  │  ├─ Uploader.ts           # 로컬→원격 업로드 (해시 dedupe)
│  │  ├─ LocalWatcher.ts       # vault 변경 감시 (onLayoutReady, debounce)
│  │  ├─ RemoteSubscriber.ts   # changes 구독 (last_seq 증분 재개)
│  │  ├─ FullSync.ts           # 전체 정합 (up/down/both)
│  │  └─ MirrorSync.ts         # 위를 엮은 링크 엔진
│  ├─ path/  hash/  log/       # 경로 매핑 · contentHash · 로거
│  └─ model/types.ts           # 문서 모델 (note 등)
├─ modes/                      # ClassSyncMode / StudentMode / TeacherMode
└─ ui/                         # LogView · RoleSetupModal
```

---

## 로드맵 (기술문서 §24)

- [x] **Phase 0** — 기술 검증 POC
- [x] **Phase 1** — 단일 학생 양방향 미러 MVP (자동 파일 감지·반영) *(기기 검증 대기)*
- [ ] **Phase 2** — 다중 학생 Teacher Mode
- [ ] **Phase 3** — 이동/삭제/충돌 처리
- [ ] **Phase 4** — 교사 편의 복사 명령
- [ ] **Phase 5** — 첨부파일 · 안정화
- [ ] **Phase 6** — Yjs 기반 글자 단위 실시간 공동 편집 (저장 백엔드와 독립적인 확장 레이어)

---

## 라이선스

[MIT](LICENSE)
