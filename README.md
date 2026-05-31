# Class Sync for Obsidian

교사용 vault의 **학생별 폴더**와 **학생 개인 vault**를 양방향으로 동기화하는 Obsidian 플러그인입니다.
중앙 서버로 **CouchDB**(시놀로지 NAS 등 자가 호스팅)를 사용하고, 클라이언트는 **PouchDB**로 구현합니다.

```
TeacherVault/
├─ 학생A/  ⇄  mirror_student_a  ⇄  StudentA Vault/
├─ 학생B/  ⇄  mirror_student_b  ⇄  StudentB Vault/
└─ 학생C/  ⇄  mirror_student_c  ⇄  StudentC Vault/
```

하나의 플러그인을 배포하고, 최초 실행 시 **Student Mode** 또는 **Teacher Mode** 역할을 선택합니다.
학생은 자기 vault에서 평소처럼 노트를 작성하고, 교사는 하나의 vault에서 학생별 폴더를 관리합니다.

핵심 특징:
- **오프라인 우선** — 로컬 PouchDB ↔ 원격 CouchDB live replication. 끊겨도 큐에 쌓였다 재연결 시 전파.
- **QR/코드 초대** — 교사가 학생을 초대하면 학생은 admin 자격증명 없이 **자기 mirror DB만 접근**하는 최소 권한 계정으로 자동 설정.
- **서버 강제 격리** — 학생별 데이터는 CouchDB 데이터베이스별 권한(`_security`)으로 서버에서 격리.
- **마크다운 + 첨부파일** — 노트뿐 아니라 이미지·PDF 등 첨부도 동기화(PouchDB attachment).
- **충돌 보존** — 양쪽 동시 편집 시 로컬을 지키고 충돌 해소 UI로 비교/선택.

> 전체 설계는 [`기술문서.md`](기술문서.md)를 참고하세요.

---

## 현재 상태

| Phase | 내용 | 상태 |
|---|---|---|
| **0** | 기술 검증 POC (연결·put/get·changes·guard·모바일) | ✅ Mac·iOS 검증 |
| **1** | 단일 학생 양방향 미러 + 이름변경/삭제/purge + 오프라인 충돌(preserve-local) | ✅ 검증 |
| **2** | 다중 학생 Teacher Mode + 보안 초대(QR) + 자동 프로비저닝 | ✅ 검증 |
| **3** | 충돌 해소 UI(보기/선택/보존) + 학생 상태 대시보드 | ✅ 검증 |
| **4** | 교사 편의 — 학생에게 파일/폴더 복사 + 템플릿 변수 | ✅ 검증 |
| **5** | 첨부파일(이미지/PDF 등) 동기화 | ✅ |
| 6 | Yjs 기반 실시간 공동 편집 | ⬜ 예정 |

---

## 설치 (개발 빌드)

```bash
git clone https://github.com/wakeyi-git/obsidian-class-sync.git
cd obsidian-class-sync
npm install
npm run build      # main.js 생성 (개발 중에는 npm run dev 로 watch)
```

빌드 산출물 **`main.js` · `manifest.json` · `styles.css`** 세 파일을 vault의
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

1. HTTPS 권장 (시놀로지 리버스 프록시 + Let's Encrypt)
2. 학생 계정·mirror DB·권한은 **교사가 플러그인에서 자동 생성**하므로 수동 작업 불필요
   (교사 Teacher Mode의 관리자 계정으로 `_users` 계정 + `mirror_*` DB + `_security`를 프로비저닝).
3. CORS는 **선택 사항**입니다. 이 플러그인은 Obsidian `requestUrl`로 CORS를 우회하므로 없어도
   동작하지만, Fauxton 등 브라우저 도구를 쓰려면 켜두면 편합니다. Obsidian origin:
   - `app://obsidian.md` (데스크톱) · `capacitor://localhost` (iOS) · `http://localhost` (Android)

---

## 사용

최초 실행 시 역할 선택 화면이 뜹니다. 역할은 한 번 선택하면 잠기며, 변경하려면 설정의 '역할 재설정'을 사용합니다.

### 교사 (Teacher Mode)
1. 설정 → **관리자 계정**(CouchDB URL / admin 사용자·비밀번호) 입력 — 이 기기에만 저장됩니다.
2. **학생 목록**에서 `+ 학생 추가` → 이름·학생 ID 입력 (Mirror DB/폴더는 비우면 자동).
3. 학생 카드의 **초대** 클릭 → 플러그인이 학생 계정/DB/권한을 자동 생성하고 **QR + 초대 코드**를 표시.
4. **연결 테스트**로 모든 학생 DB 접근을 확인, **설정 적용**으로 동기화 시작.

### 학생 (Student Mode)
- 교사가 준 **QR을 휴대폰 기본 카메라로 스캔** → Obsidian이 열리며 자동 설정, 또는
- **초대 코드를 붙여넣기**(첫 실행 화면 또는 Student 설정).
- 학생은 자기 mirror DB에만 접근하는 전용 계정으로 연결됩니다.

### 명령 (`Cmd/Ctrl+P` → `Class Sync:`)
| 명령 | 동작 |
|---|---|
| 전체 동기화 / 업로드만 / 다운로드만 | 수동 정합 (Teacher는 전체 학생) |
| 연결/권한 테스트 | CouchDB 연결·권한 확인 |
| 자동 동기화 켜기/끄기 | 실시간 감시·구독 토글 |
| 로컬 캐시 초기화 | 로컬 PouchDB 삭제 후 서버에서 다시 받기 |
| 충돌 목록 열기 | 충돌 비교/해소 (로컬 유지·원격 적용·두 버전 보관) |
| 대시보드 열기 | 학생별 동기화 상태 표 (👥 리본으로도) |
| 현재 파일/폴더를 학생에게 복사 | 템플릿 배포 (교사) — `{{studentName}}` 등 변수 치환 |
| 로그 패널 열기 | 동기화 로그 보기 (🔄 리본으로도) |

삭제한 파일은 **보관 폴더(`_삭제됨/`, 설정 가능)** 로 이동하며, 그 폴더에서 지우면 DB에서도 영구 삭제됩니다.

### 충돌
양쪽이 같은 파일을 다르게 편집하면 로컬을 보존(preserve-local)하고 원격 버전을 **`_충돌/` 폴더**에
꺼내 둡니다. `충돌 목록 열기`에서 비교 후 *로컬 유지 / 원격 적용 / 두 버전 보관*으로 해소합니다.
상대가 먼저 해소해 내 편집이 덮일 경우, 내 버전은 `_충돌/<파일>.내편집.md`로 보존됩니다.

### 첨부파일
이미지·PDF 등 비markdown 파일도 동기화됩니다(CouchDB attachment). 설정에서 *첨부파일 동기화* 토글과
*첨부 최대 크기(MB)* 로 제어합니다(모바일 보호). 첨부 충돌은 로컬 보존 + 로그(비교 UI는 마크다운만).

### 교사 배포 (Phase 4)
`템플릿/` 등 학생 폴더 밖에 원본을 두고, `현재 파일/폴더를 학생에게 복사`로 선택·전체 학생에게 배포합니다.
`{{studentName}}` `{{studentId}}` `{{classId}}` `{{date}}` 변수가 학생별로 치환되고, 기존 파일은
건너뛰기(기본)/덮어쓰기/새 이름 정책으로 처리합니다.

---

## 아키텍처

```
src/
├─ main.ts                     # 진입점, 역할 설정, 초대 딥링크 핸들러, 명령
├─ settings/                   # 설정 타입 + 설정 탭(학생 카드 UI)
├─ core/
│  ├─ couch/
│  │  ├─ PouchService.ts       # 로컬 PouchDB + live sync(retry) + changes
│  │  ├─ obsidianFetch.ts      # requestUrl 기반 fetch shim (모바일 CORS 우회)
│  │  └─ CouchAdmin.ts         # 학생 계정/DB/_security 프로비저닝 (admin)
│  ├─ invite/invite.ts         # 초대 페이로드 인코딩 + obsidian:// 딥링크
│  ├─ guard/RemoteApplyGuard.ts# 동기화 루프 차단
│  ├─ sync/
│  │  ├─ MirrorContext.ts      # 링크별 경로/IO/상태/보관 헬퍼
│  │  ├─ MirrorApplier.ts      # 원격→로컬 적용 (_conflicts preserve-local, 삭제/purge)
│  │  ├─ Uploader.ts           # 로컬→원격 (해시 dedupe, tombstone, purge)
│  │  ├─ LocalWatcher.ts       # vault 감시 (create/modify/rename/delete)
│  │  ├─ LocalApplier.ts       # 로컬 changes → vault 반영 (last_seq 증분)
│  │  ├─ FullSync.ts           # 전체 정합 (up/down/both)
│  │  ├─ ConflictManager.ts    # 충돌 원격본 생성/해소/내편집 보존
│  │  ├─ MirrorSync.ts         # 위를 엮은 학생↔DB 링크 엔진 + 상태
│  │  └─ connectionTest.ts     # 연결/권한 테스트
│  ├─ path/  hash/  log/       # 경로 매핑 · contentHash · 로거
│  └─ model/types.ts           # 문서 모델 (note / asset / tombstone)
├─ modes/                      # ClassSyncMode / StudentMode / TeacherMode / teacher/BulkCopy
└─ ui/                         # LogView · RoleSetupModal · InviteModal · ConflictModal · DashboardView · BulkCopyModal
```

**동기화 구조 (오프라인 우선)**
```
Vault  ◄──(LocalWatcher / LocalApplier)──►  로컬 PouchDB  ◄──(live sync, retry)──►  원격 CouchDB
```
교사는 학생마다 `MirrorSync`를 하나씩 두어 여러 학생을 동시에 동기화합니다.

---

## 보안 메모

- 초대 코드에는 학생 전용 비밀번호가 포함됩니다(교실 1회 온보딩용). 만료 토큰은 후속 과제입니다.
- 교사 관리자 자격증명은 교사 기기에만 저장되며, 학생은 admin 권한을 일절 다루지 않습니다.
- 학생 간 데이터는 CouchDB `_security`로 서버에서 격리됩니다(다른 학생 DB 접근 시 403).

---

## 라이선스

[MIT](LICENSE)
