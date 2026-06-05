# Class Sync 플러그인 평가 보고서

- 작성일: 2026-06-05
- 대상: Obsidian 플러그인 `class-sync` / `class-sync-for-obsidian`
- 버전: `0.17.1`
- 평가 관점: 기능 완성도, 동기화 안정성, 보안 모델, 모바일/운영 적합성, 릴리스 준비도

## 결론

현재 상태는 **상급 베타**로 평가한다. 제한된 학급 파일럿에는 충분히 투입 가능해 보이며, 단순 파일 동기화 플러그인이라기보다 CouchDB/PouchDB 기반의 교실 운영 시스템에 가깝다.

종합 점수는 **8/10** 정도다. 핵심 동기화 구조와 보안 설계는 꽤 탄탄하지만, 정식 커뮤니티 제출 또는 실제 학급 본운영 전에는 통합 테스트, 릴리스 재현성, 문서 버전 정리가 더 필요하다.

## 확인한 검증 결과

다음 명령은 모두 통과했다.

```bash
npm test
npm run build
npm run i18n:check
```

결과 요약:

- `npm test`: 10개 테스트 파일, 65개 테스트 통과
- `npm run build`: TypeScript 검사 및 production esbuild 번들 통과
- `npm run i18n:check`: 영문 키 559개, 사용 키 527개, 중복 0, 누락 0

## 강점

### 1. 기능 범위가 크지만 구조가 비교적 잘 나뉘어 있다

README의 아키텍처 설명과 실제 코드 구조가 대체로 일치한다. `MirrorContext`, `Uploader`, `LocalWatcher`, `LocalApplier`, `FullSync`, `ConflictManager`가 동기화의 각 책임을 나눠 갖고 있다.

핵심 구조는 다음 흐름이다.

```text
Vault <-> LocalWatcher / LocalApplier <-> local PouchDB <-> remote CouchDB
```

이 구조는 네트워크가 불안정한 교실/모바일 환경에서 좋은 선택이다. 로컬 PouchDB가 중간층이 되므로 오프라인 편집을 큐잉하고, 재연결 시 replication으로 따라잡을 수 있다.

관련 위치:

- `README.ko.md` 아키텍처 섹션
- `src/core/sync/MirrorSync.ts`
- `src/core/couch/PouchService.ts`

### 2. 삭제 정합이 신중하다

오프라인 또는 자동 동기화 비활성 중 로컬에서 삭제된 파일을 무작정 tombstone 처리하지 않는다. 링크별 manifest를 기준선으로 두고, 다음 조건을 만족할 때만 삭제 후보로 본다.

- 과거 이 vault가 실제로 보유했던 파일
- 현재 vault에서 사라진 파일
- 현재 DB 문서의 `rev`와 `contentHash`가 기준선과 동일한 파일
- 대량 삭제 임계치를 넘지 않는 경우

이는 `localRoot` 오설정이나 빈 vault 초기화 시 서버 문서가 대량 삭제되는 사고를 줄이는 좋은 방어다.

관련 위치:

- `src/core/sync/FullSync.ts`
- `src/core/sync/LinkManifest.ts`

### 3. 충돌 보존 정책이 실사용을 의식한다

충돌 처리의 기본 정책은 preserve-local이다. 로컬 편집을 덮어쓰지 않고, 원격본을 `_충돌/` 폴더에 materialize해서 사용자가 비교할 수 있게 한다.

특히 debounce pending 중에 원격 변경이 들어온 경우도 별도로 고려되어 있다. 이 경우 원격 변경이 선형으로 덮여 사라질 수 있으므로, 적용 전에 원격본을 충돌 폴더에 보존한다.

관련 위치:

- `src/core/sync/MirrorApplier.ts`
- `src/core/sync/ConflictManager.ts`

### 4. 보안 모델이 교육 환경에 잘 맞는다

학생 계정은 교사 admin 계정으로 자동 프로비저닝되고, 학생별 mirror DB는 CouchDB `_security`로 접근이 제한된다. 학생은 admin credential을 갖지 않고 자기 DB에만 접근하는 구조다.

실시간 공동 편집도 전역 토큰만 쓰는 레거시 방식에서 나아가, 공유 공간별 HMAC 토큰을 지원한다. 토큰 payload가 `classId`, `spaceId`, 선택 만료 시각을 포함하고, 서버는 room prefix를 검증한다. 따라서 토큰 하나가 유출되어도 피해 범위가 해당 공유 공간으로 제한된다.

관련 위치:

- `src/core/couch/CouchAdmin.ts`
- `src/core/realtime/spaceToken.ts`
- `src/main.ts`
- `docs/server.js`

### 5. 모바일과 운영 UX를 꽤 챙겼다

모바일 절전과 메모리 보호가 고려되어 있다.

- 백그라운드 진입 시 remote replication 일시정지
- 모바일에서는 더 긴 upload debounce 사용
- 대용량 첨부는 읽기 전에 `stat.size`로 먼저 제한 확인
- 설정 내보내기 시 비밀번호, 토큰, 학생 비밀번호, 기기 고유값 제외

관련 위치:

- `src/core/sync/LocalWatcher.ts`
- `src/core/sync/Uploader.ts`
- `src/settings/portable.ts`
- `src/main.ts`

## 주요 리스크와 개선점

### P1. 동기화 엔진의 통합 테스트가 아직 부족하다

현재 테스트는 65개로 양이 나쁘지 않지만, 대부분 순수 함수와 작은 유틸리티 중심이다. 실제 위험은 다음처럼 이벤트 순서가 얽히는 곳에 있다.

- PouchDB replication 중 `_conflicts` 발생
- Obsidian vault event와 debounce의 순서
- pending 중 원격 변경 수신
- 앱 종료/재시작 후 last sequence 재개
- 공유 공간 reconcile 중 링크 재구성
- 실시간 Yjs 세션 종료 후 CouchDB snapshot 저장

권장 추가 테스트:

- 로컬 수정 debounce 중 원격 변경 pull 시 `_충돌/` 보존 여부
- 신규/빈 vault에서 전체 동기화 시 서버 문서가 삭제로 오판되지 않는지
- 오프라인 중 삭제 후 재시작 시 manifest 기준으로만 tombstone 되는지
- 업로드만/다운로드만 명령이 의도한 방향으로만 원격 replication 하는지
- 공유 폴더가 학생 폴더 아래 있을 때 개인 mirror가 공유 파일을 이중 업로드하지 않는지

### P2. 릴리스 재현성이 약하다

`package.json`의 버전은 `0.17.1`인데 `package-lock.json` 루트 버전은 `0.11.2`로 남아 있다.

또한 release workflow는 `npm install`을 사용한다. 릴리스 재현성을 높이려면 lockfile을 갱신하고, workflow를 `npm ci`로 바꾸는 편이 낫다.

관련 위치:

- `package.json`
- `package-lock.json`
- `.github/workflows/release.yml`

권장:

```bash
npm install --package-lock-only
```

그 뒤 workflow의 install 단계:

```yaml
- name: Install
  run: npm ci
```

### P2. `obsidian` devDependency가 `latest`다

현재 `manifest.json`의 `minAppVersion`은 `1.11.4`다. 그런데 `package.json`의 devDependency는 `obsidian: latest`로 되어 있다.

이 경우 최신 Obsidian API를 기준으로 컴파일되어, 실제 최소 지원 버전인 1.11.4에서는 동작하지 않는 API를 실수로 사용할 가능성이 있다.

권장:

- `obsidian` devDependency를 최소 지원 버전 또는 검증한 범위로 고정
- 최소 지원 버전에서 실제 로드 테스트 수행

### P2. 문서의 최소 Obsidian 버전이 일부 오래되어 있다

현재 주요 파일은 `1.11.4`를 기준으로 한다.

- `manifest.json`: `minAppVersion` = `1.11.4`
- `versions.json`: `0.17.0`, `0.17.1` = `1.11.4`
- README 요구사항: `1.11.4`

하지만 일부 문서는 아직 `1.11.0`을 말한다.

- `docs/mobile-test-checklist.md`
- `docs/release-and-submit.md`

권장:

- 모든 제출/검증 문서의 현재 minAppVersion을 `1.11.4`로 통일
- Secret Storage API 사용 때문에 1.11.4가 필요한 이유를 체크리스트에도 명시

### P3. 실시간 공동 편집은 운영 복잡도가 높다

Yjs 실시간 기능은 가치가 크지만, 실제 교실 배포 관점에서는 운영 난이도가 높다.

필요 조건:

- CouchDB 서버
- 별도 Yjs WebSocket 서버
- HTTPS/WSS 리버스 프록시
- HMAC secret 관리
- 토큰 query 로그 마스킹
- Excalidraw 실시간을 쓰려면 별도 Excalidraw 플러그인

코드와 문서에는 상당 부분 안내가 있지만, 일반 교사 대상이라면 실시간 기능은 "고급 기능"으로 분리하고, 기본 파일 동기화부터 성공시키는 온보딩이 중요하다.

## 출시 준비도

### 커뮤니티 플러그인 제출 관점

기본 요건은 대체로 갖췄다.

- `manifest.json` 존재
- `versions.json` 존재
- `LICENSE` 존재
- `main.js`, `manifest.json`, `styles.css` 릴리스 자산 구조
- `isDesktopOnly: false`
- 외부 서버 요구사항 README 명시
- 릴리스 workflow에서 test/i18n/build 실행

보완하면 좋은 항목:

- `package-lock.json` 버전 동기화
- workflow `npm ci` 적용
- `obsidian` devDependency 버전 고정
- 문서의 minAppVersion 불일치 수정
- 실제 모바일 검증 체크리스트 완료 기록 추가

### 실제 학급 운영 관점

파일럿 운영에는 적합하다. 다만 처음부터 전 기능을 켜기보다는 단계적으로 적용하는 편이 안전하다.

권장 도입 순서:

1. 교사 1명 + 학생 1명으로 개인 mirror 동기화만 테스트
2. 첨부파일과 삭제/복원 정책 테스트
3. 여러 학생으로 확장
4. 공유 폴더 배포 테스트
5. 실시간 Yjs 기능은 마지막에 선택적으로 활성화

## 우선순위별 액션 아이템

1. `package-lock.json`을 `package.json` 버전과 동기화하고 release workflow를 `npm ci`로 변경한다.
2. `obsidian: latest`를 고정 버전으로 바꾼다.
3. `docs/mobile-test-checklist.md`, `docs/release-and-submit.md`의 minAppVersion을 `1.11.4`로 맞춘다.
4. pending/replication/manifest/delete/reconcile 관련 통합 테스트를 추가한다.
5. 모바일 실기기에서 QR 초대, 오프라인 편집, 대용량 첨부 skip, 백그라운드 pause/resume을 검증하고 체크리스트에 결과를 남긴다.
6. 실시간 기능은 별도 "고급 설정" 문서나 troubleshooting 문서를 강화한다.

## 최종 평가

이 플러그인은 기능 욕심만 큰 미완성품은 아니다. 위험한 부분을 알고 있고, 그 위험을 줄이기 위한 구조적 장치가 꽤 많이 들어가 있다. 특히 삭제 정합, 충돌 보존, 학생별 권한, 공간별 실시간 토큰은 좋은 설계 판단이다.

다만 동기화 플러그인의 진짜 난이도는 "평상시 잘 됨"이 아니라 "네트워크가 끊기고, 앱이 꺼지고, 같은 파일을 동시에 고치고, 폴더를 잘못 지정했을 때도 자료를 잃지 않는가"에 있다. 이 부분은 현재 코드상 방어가 상당히 있지만, 통합 테스트와 실기기 검증으로 더 고정해야 한다.

따라서 현재 상태는 **정식 출시 직전의 탄탄한 베타**로 보는 것이 가장 적절하다. 파일럿을 돌리면서 통합 테스트와 릴리스 재현성만 보강하면 커뮤니티 제출도 충분히 노려볼 만하다.
