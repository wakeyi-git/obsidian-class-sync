# 파일 버전·삭제 복구·충돌 해소 검토 보고서

- 작성일: 2026-06-05
- 대상: Obsidian 플러그인 `class-sync`
- 검토 범위: 파일 버전 관리, 삭제 파일 동기화/복구, 충돌 파일 해소
- 검증: `npm test` 통과(10개 테스트 파일, 65개 테스트)

## 요약

현재 구현은 동기화 안전성 관점의 기본 장치는 잘 갖추고 있다.

- 파일마다 `version`, `contentHash`, `updatedAt`, `lastModified*`, CouchDB/PouchDB `_rev`를 가진다.
- 삭제는 hard delete가 아니라 tombstone으로 전파하고, 기본 정책에서는 상대 vault의 파일을 `_삭제됨/`으로 보관한다.
- 오프라인 중 삭제는 manifest 기준선(`_local/manifest`)으로만 tombstone 처리해 대량 삭제 사고를 줄인다.
- 마크다운 충돌은 `_conflicts`를 감지해 로컬을 보존하고, 원격본을 `_충돌/` 폴더에 꺼낸 뒤 UI에서 해소한다.

다만 사용자 관점의 "버전 관리", "복구", "충돌 해소"는 아직 부족하다. 현재의 버전 정보는 내부 정합용에 가깝고, 삭제 복구는 수동으로는 가능하지만 명시적 UI가 없다. 충돌 해소도 마크다운 중심이며 첨부파일 충돌은 보존만 하고 비교/선택 UI가 없다.

## 1. 파일 버전 관리 확인

### 현재 구조

`NoteDoc`와 `AssetDoc`는 다음 메타데이터를 가진다.

- CouchDB/PouchDB `_rev`
- 자체 `version`
- `contentHash`
- `mtime`
- `updatedAt`
- `lastModifiedBy`
- `lastModifiedRole`
- `lastModifiedDeviceId`
- 삭제 시 `deletedAt`, `deletedBy`, `deletedByRole`, `deleteMode`

관련 위치:

- `src/core/model/types.ts`
- `src/core/sync/MirrorContext.ts`
- `src/core/sync/Uploader.ts`

업로드 시 같은 `contentHash`면 생략하고, 변경이 있으면 기존 문서의 `version`에 1을 더해 새 문서를 만든다. 삭제 tombstone도 `version`을 증가시킨다.

### 현재 장점

파일별 버전 증가와 해시 dedupe가 있어 불필요한 업로드를 줄이고, 동기화 echo를 구분하는 데 도움이 된다.

`lastModifiedDeviceId`는 내가 만든 변경의 echo를 무시하는 데 사용된다. 이 덕분에 원격에서 돌아온 내 변경이 다시 로컬 파일을 덮는 루프를 줄인다.

CouchDB/PouchDB `_rev`는 충돌 감지와 삭제 정합에서 핵심이다. 특히 manifest는 기준선의 `rev`와 `hash`를 저장하고, 이후 값이 달라지면 "다른 기기에서 수정된 파일"로 보고 삭제 후보에서 제외한다.

### 현재 한계

현재 `version`은 사용자에게 제공되는 버전 히스토리가 아니다. 즉 "이 파일의 3번째 버전으로 되돌리기" 같은 기능은 없다.

CouchDB `_rev`도 사용자용 이력으로 쓰기 어렵다. CouchDB는 충돌 leaf는 유지하지만 일반적인 과거 리비전 본문은 compaction 등으로 사라질 수 있고, 현재 코드도 일반 버전 복원을 위해 과거 리비전을 보존하지 않는다.

`version`은 단일 숫자라 여러 기기에서 동시에 분기된 편집을 표현하기엔 부족하다. 실제 분기/충돌 판단은 PouchDB `_conflicts`에 의존한다.

### 개선안

#### P1. 사용자용 버전 히스토리 도입

내부 정합용 `version`과 별개로 사용자 복구용 히스토리 문서를 추가하는 것이 좋다.

예시:

```ts
interface VersionEntry {
  id: string;
  path: string;
  version: number;
  contentHash: string;
  createdAt: string;
  createdBy: string;
  role: "student" | "teacher";
  deviceId: string;
  kind: "snapshot" | "delete" | "restore" | "conflict-resolution";
  content?: string;
  assetRef?: string;
}
```

권장 정책:

- 마크다운은 최근 N개 또는 최근 N일 스냅샷 저장
- 첨부파일은 용량 제한을 두고 선택 저장
- 삭제 직전 버전은 반드시 보존
- 충돌 해소 직전 로컬/원격 버전은 반드시 보존
- 기본값은 보수적으로 `최근 10개` 또는 `30일`

#### P2. "버전 기록 열기" 명령 추가

사용자가 파일 단위로 버전을 보고 복원할 수 있어야 한다.

권장 UI:

- 현재 파일의 버전 목록
- 생성 시각, 작성자, 역할, 기기 표시
- 선택 버전 미리보기
- "이 버전으로 복원"
- "현재 내용을 백업하고 복원"

#### P2. 버전 이벤트 타입 명확화

현재 `version`은 단순 증가값이다. 추후 분석과 복구를 위해 변경 이벤트의 의미를 기록하면 좋다.

추천 이벤트:

- `create`
- `modify`
- `rename-from`
- `rename-to`
- `delete`
- `restore`
- `conflict-local`
- `conflict-remote`
- `conflict-resolve-local`
- `conflict-resolve-remote`
- `conflict-keep-both`

## 2. 삭제 파일 동기화·복구 확인

### 현재 구조

삭제는 일반 파일 삭제와 보관 폴더 삭제로 나뉜다.

일반 파일 삭제:

1. `LocalWatcher.onDelete()`가 삭제 이벤트를 받는다.
2. 동기화 대상이면 `Uploader.tombstonePath()`를 호출한다.
3. 기존 문서를 `deleted: true`로 바꾸고 삭제 메타데이터를 채운다.
4. PouchDB replication이 tombstone을 원격으로 전파한다.

보관 폴더 안 파일 삭제:

1. `_삭제됨/` 안 파일 삭제를 감지한다.
2. `archiveDbPath()`로 원래 DB path를 계산한다.
3. `Uploader.purgePath()`가 해당 DB 문서를 hard remove한다.
4. 다른 쪽에서는 purge 전파 시 archive 사본도 정리한다.

관련 위치:

- `src/core/sync/LocalWatcher.ts`
- `src/core/sync/Uploader.ts`
- `src/core/sync/MirrorApplier.ts`
- `src/core/sync/MirrorContext.ts`

### 수신 측 삭제 정책

삭제 tombstone을 받은 쪽은 자기 설정의 `deletePolicy`를 따른다.

- `archive`: 파일을 `_삭제됨/<원래경로>`로 이동
- `propagate-delete`: 즉시 삭제
- `ignore-delete`: 삭제를 무시

관련 위치:

- `src/settings/types.ts`
- `src/settings/SettingsTab.ts`
- `src/core/sync/MirrorApplier.ts`

### 오프라인 삭제 정합

앱이 꺼져 있거나 자동 동기화가 꺼진 동안 삭제된 파일은 이벤트가 없을 수 있다. 이 경우 `FullSync`가 manifest 기준선으로 삭제 누락을 보정한다.

현재 안전장치:

- 기준선 manifest가 없으면 삭제 정합 생략
- `localRoot`가 바뀌면 삭제 정합 생략
- 기준선의 `rev`와 `hash`가 현재 DB 문서와 같을 때만 삭제 후보
- 후보가 대량 삭제 임계치를 넘으면 중단

관련 위치:

- `src/core/sync/FullSync.ts`
- `src/core/sync/LinkManifest.ts`
- `src/core/sync/LinkManifest.test.ts`

### 현재 복구 가능성

명시적 복구 버튼은 없지만, 기본 `archive` 정책에서는 수동 복구가 가능하다.

예상 동작:

1. `_삭제됨/<원래경로>`의 파일을 원래 위치로 이동한다.
2. `LocalWatcher.onRename()`이 새 위치를 업로드 대상으로 본다.
3. 기존 DB 문서가 `deleted: true`여도 `Uploader.uploadNote()`는 같은 hash라도 tombstone을 부활시킨다.
4. 새 문서는 `deleted: false`로 다시 올라간다.

이 흐름은 코드상 가능해 보인다. 하지만 UI나 문서에서 "복구"로 안내되지 않아 사용자가 알기 어렵다.

### 현재 한계

#### 1. 복구 UX가 없다

삭제 파일을 어디에서 보고, 어떤 파일을 원래 위치로 되돌릴지 안내하는 UI가 없다. 사용자가 `_삭제됨/` 폴더를 직접 찾아 옮겨야 한다.

#### 2. 보관 폴더에서 삭제하면 즉시 purge가 된다

현재 설명은 명확하지만, 사용자 입장에서는 `_삭제됨/` 안에서 실수로 파일을 지우면 DB에서도 영구 삭제된다. 확인 모달이나 유예 기간이 없다.

#### 3. `propagate-delete` 정책은 복구 여지가 작다

즉시 삭제 정책에서는 상대 vault 파일이 Obsidian trash로 이동한다. 이 경우 플러그인 내부의 복구 흐름과 연결되지 않는다.

#### 4. 삭제 vs 원격 수정의 사용자 선택지가 없다

manifest는 기준선 이후 원격 수정이 있으면 삭제 후보에서 제외해 데이터 손실은 막는다. 하지만 사용자는 "내 삭제가 보류된 이유"와 "삭제할지, 수정본을 유지할지"를 UI에서 결정할 수 없다.

### 개선안

#### P1. 삭제 파일 복구함 UI 추가

`_삭제됨/` 폴더를 직접 탐색하지 않아도 되는 "삭제 파일" 패널을 추가한다.

권장 표시 항목:

- 원래 경로
- 삭제한 사람/역할
- 삭제 시각
- 현재 보관 위치
- DB 이름/학생 이름
- 복구 가능 여부

권장 액션:

- "원래 위치로 복구"
- "다른 이름으로 복구"
- "영구 삭제"
- "파일 열기"

#### P1. 복구 API 명시화

수동 rename에 의존하지 말고 `restoreDeleted(dbPath, options)` 같은 명시적 메서드를 추가하는 편이 안전하다.

권장 흐름:

1. tombstone 문서 조회
2. archive 파일 또는 버전 히스토리에서 내용 확보
3. 원래 위치 충돌 여부 확인
4. 기존 파일이 있으면 rename/overwrite/keep-both 선택
5. `deleted: false`, `version + 1`, `restoreFromVersion`, `restoredAt`, `restoredBy` 기록
6. PouchDB에 put

#### P2. purge 전 확인 또는 유예 tombstone 도입

보관 폴더에서 삭제하면 즉시 DB hard remove 대신 다음 중 하나를 고려한다.

- 확인 모달 표시
- `purgePending: true` 문서로 표시 후 일정 기간 뒤 purge
- "최근 영구 삭제" 목록에서 되돌리기

#### P2. 삭제/수정 충돌 큐 추가

오프라인 삭제 정합에서 rev/hash가 달라 후보에서 제외된 경우, 단순히 조용히 보존하는 대신 "삭제-수정 충돌"로 사용자에게 보여주는 것이 좋다.

예시 선택지:

- "내 삭제 적용"
- "원격 수정 유지"
- "수정본을 다른 이름으로 보관하고 삭제"

## 3. 충돌 파일 해소 확인

### 현재 구조

충돌은 PouchDB `_conflicts`를 기준으로 감지한다.

1. `PouchService.listConflicts()`가 `_conflicts`가 있는 note 문서를 조회한다.
2. `MirrorApplier.applyDoc()`가 충돌을 감지하면 로컬 파일은 유지한다.
3. `ConflictManager.materialize()`가 라이브 파일과 다른 leaf를 골라 `_충돌/` 폴더에 기록한다.
4. `ConflictModal`에서 사용자가 비교/해소한다.

관련 위치:

- `src/core/couch/PouchService.ts`
- `src/core/sync/MirrorApplier.ts`
- `src/core/sync/ConflictManager.ts`
- `src/ui/ConflictModal.ts`
- `src/main.ts`

### 현재 UI

충돌 목록 UI는 다음 액션을 제공한다.

- `비교(열기)`: 로컬 파일과 `_충돌/` 파일을 split leaf로 연다.
- `로컬 유지`: 현재 vault 내용을 최종본으로 선택한다.
- `원격 적용`: 원격 leaf 내용을 현재 파일에 적용한다.
- `두 버전 보관`: 원격 내용을 `<파일명> (충돌본).md`로 저장하고, 현재 파일은 로컬 내용으로 확정한다.

해소 시에는 선택 내용을 새 문서로 put하고, conflict leaf들을 remove해서 PouchDB 충돌을 collapse한다.

### 현재 장점

로컬 보존을 기본으로 하는 것은 교육 자료 손실 방지 관점에서 안전하다.

상대가 먼저 충돌을 해소해 내 편집이 덮일 상황에서는 내 편집을 `_충돌/<파일>.내편집.md`로 보존한다.

pending 중 원격 변경이 들어오는 race도 고려해 원격본을 `_충돌/`에 materialize한다.

### 현재 한계

#### 1. 첨부파일 충돌은 UI 해소가 없다

첨부파일은 충돌 시 원격본을 `_충돌/`에 보존하고 로그를 남긴다. 하지만 충돌 목록 UI는 note 문서만 조회하므로, 첨부 충돌은 사용자가 직접 파일을 보고 처리해야 한다.

#### 2. 비교 UI가 단순 파일 열기다

현재 비교는 두 파일을 split으로 여는 방식이다. 실제 diff 뷰, 변경점 강조, 선택 병합은 없다.

#### 3. "두 버전 보관"의 의미가 약간 모호하다

현재 `both`는 원격본을 `<파일명> (충돌본).md`로 저장하고, 원래 파일은 로컬 내용으로 확정한다. 즉 "두 버전을 모두 보관하되 최종본은 로컬"이다. UI 문구만 보면 사용자가 최종본 선택 방식까지 이해하기 어려울 수 있다.

#### 4. 충돌본 폴더는 동기화 제외 폴더다

`_충돌/` 자체는 동기화 대상에서 제외된다. 반면 `both`가 만드는 `<파일명> (충돌본).md`는 원래 위치에 생기므로 동기화된다. 이 차이는 의도적으로 보이지만, UI에서 설명이 더 필요하다.

### 개선안

#### P1. 충돌 해소 화면에 diff 뷰 추가

마크다운 충돌은 단순히 파일 두 개를 열기보다, 한 화면에서 비교할 수 있어야 한다.

권장 기능:

- 좌측: 로컬
- 우측: 원격
- 변경 줄 하이라이트
- 공백/줄바꿈 차이 무시 옵션
- "로컬 선택", "원격 선택", "두 버전 보관"
- 가능하면 블록 단위 선택 병합

#### P1. 첨부파일 충돌 UI 추가

첨부 충돌도 충돌 목록에 포함해야 한다.

권장 표시:

- 파일명
- MIME 타입
- 크기
- 로컬/원격 수정자
- 로컬/원격 미리보기 가능 여부

권장 액션:

- 로컬 유지
- 원격 적용
- 두 버전 보관
- 원격본 열기

#### P2. `both` 문구 개선

현재 동작을 더 정확히 드러내는 문구가 좋다.

예:

- 현재: `두 버전 보관`
- 개선: `로컬을 최종본으로 하고 원격 사본 보관`
- 또는 버튼 2개 분리:
  - `두 버전 보관(로컬 최종)`
  - `두 버전 보관(원격 최종)`

#### P2. 충돌 해소 전 백업 스냅샷 저장

사용자가 충돌을 잘못 해소해도 되돌릴 수 있게, 해소 직전 로컬/원격 내용을 version history에 저장하는 것이 좋다.

#### P3. 충돌 상태 배지 강화

대시보드에는 충돌 개수가 보이지만, 사용자가 어떤 파일에서 어떤 종류의 충돌이 났는지 바로 알기는 어렵다.

권장:

- 마크다운 충돌
- 첨부파일 충돌
- 삭제/수정 충돌
- 실시간 세션 스냅샷 충돌

을 구분해 표시한다.

## 우선순위 액션 아이템

1. 삭제 파일 복구함 UI와 `restoreDeleted()` API를 추가한다.
2. 마크다운 충돌 모달에 diff 뷰를 넣는다.
3. 첨부파일 충돌을 충돌 목록에 포함하고 해소 액션을 제공한다.
4. 사용자용 버전 히스토리 문서를 추가하고, 삭제 직전/충돌 해소 직전 스냅샷을 보존한다.
5. 삭제-수정 충돌 큐를 만들어 manifest가 보존한 파일을 사용자가 명시적으로 판단하게 한다.
6. `_삭제됨/`에서 삭제 시 즉시 purge 대신 확인 또는 유예 절차를 둔다.
7. `두 버전 보관` 버튼 문구를 최종본 선택 의미가 드러나게 바꾼다.

## 권장 설계 순서

가장 먼저 할 일은 삭제 복구 UI다. 이유는 구현 난이도 대비 사용자 가치가 크고, 이미 `_삭제됨/`과 tombstone 구조가 있어 현재 구조를 크게 바꾸지 않아도 된다.

그다음은 충돌 diff UI다. 현재 충돌 해소는 기능적으로 가능하지만, 사용자가 내용을 안전하게 판단하기 어렵다. 마크다운 diff만 들어가도 체감 안정성이 크게 올라간다.

마지막으로 버전 히스토리를 도입하는 것이 좋다. 이 기능은 저장 공간, retention, privacy, attachment 처리 정책을 함께 설계해야 하므로 앞의 두 개선보다 범위가 크다.

## 결론

현재 구현은 "동기화 중 자료를 잃지 않기 위한 내부 안전장치"는 꽤 잘 갖추고 있다. 특히 tombstone, archive, manifest, `_conflicts` 기반 충돌 해소는 좋은 방향이다.

하지만 사용자가 체감하는 복구성과 설명 가능성은 아직 한 단계 더 필요하다. 지금은 문제가 생겼을 때 플러그인이 파일을 보존해 주지만, 사용자가 그것을 찾아서 안전하게 복구·선택하는 흐름은 충분히 제품화되어 있지 않다.

따라서 개선의 핵심은 새로운 동기화 알고리즘보다 **복구/해소 UI와 사용자용 히스토리 계층**을 추가하는 것이다. 이 세 가지가 보강되면 교실 운영 중 실수나 동시 편집이 생겨도 훨씬 안심하고 사용할 수 있다.
