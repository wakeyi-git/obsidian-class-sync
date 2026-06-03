# Class Sync 코드 검토 보고서

- 작성일: 2026-06-03
- 대상: Obsidian 플러그인 `class-sync`
- 검토 관점: 동기화 정확성, 삭제/충돌 처리, 공유 공간 캐시, 수동 동기화 명령의 사용자 기대, 빌드 상태
- 확인 결과: `npm run build` 통과

## 요약

프로젝트는 Obsidian vault와 CouchDB mirror DB 사이에 로컬 PouchDB를 두는 오프라인 우선 구조로 설계되어 있다. 구조 자체는 역할 분리, 교사/학생 모드, 공유 공간, 실시간 편집까지 일관되게 확장되어 있으며 주석도 의도를 잘 설명한다.

다만 실제 교실 환경에서 자주 발생할 수 있는 경계 조건, 특히 편집 debounce 중 원격 변경 수신, 오프라인 삭제, 수동 동기화 방향성, 공유 공간 캐시 초기화에서 데이터가 기대와 다르게 남거나 덮일 위험이 있다. 아래 항목은 우선 수정이 필요한 순서대로 정리했다.

## 주요 발견 사항

### P1. pending 중 원격 변경이 체크포인트 처리되어 로컬 편집이 충돌 없이 덮을 수 있음

- 위치: `src/core/sync/LocalApplier.ts:33-58`
- 관련 위치: `src/core/sync/MirrorApplier.ts:57-61`, `src/core/sync/Uploader.ts:61-65`

`LocalApplier`는 로컬 PouchDB changes를 처리한 뒤 결과와 관계없이 `finally`에서 `lastSeqByDb`를 갱신한다. 그런데 `MirrorApplier`가 `ctx.isPending(doc.path)` 때문에 원격 변경 적용을 `skipped-pending`으로 보류해도, 해당 change seq는 이미 처리된 것으로 저장된다.

이후 debounce가 끝나면 `Uploader.uploadNote()`가 현재 로컬 PouchDB의 최신 문서 rev 위에 로컬 내용을 다시 `put`한다. 이 흐름에서는 원격 변경이 별도 충돌본으로 보존되지 않고, 로컬 편집이 최신 rev 위에 올라타 원격 변경을 실질적으로 덮을 수 있다.

영향:

- 동시 편집 또는 느린 네트워크 상황에서 상대 변경이 충돌 UI 없이 사라질 수 있다.
- `preserve-local` 정책의 의도와 다르게, 원격 버전이 `_충돌` 폴더에도 남지 않을 수 있다.

권장 수정:

- `skipped-pending`일 때는 `lastSeqByDb`를 넘기지 않거나, pending change를 별도 큐에 보관한 뒤 업로드 완료 후 다시 적용한다.
- 또는 pending 상태에서 들어온 원격 문서를 즉시 충돌본으로 materialize하고, 이후 로컬 업로드가 충돌 리비전으로 남도록 처리한다.
- 회귀 테스트: 로컬 파일 수정 후 debounce 대기 중 원격 문서를 pull하고, 최종적으로 충돌 목록 또는 보존본이 생기는지 검증한다.

### P1. 오프라인/비활성 상태에서 삭제된 파일은 전체 동기화로 tombstone 처리되지 않음

- 위치: `src/core/sync/FullSync.ts:78-99`
- 관련 위치: `src/core/sync/LocalWatcher.ts:132-160`

삭제 전파는 `LocalWatcher.onDelete()` 이벤트에서 `tombstonePath()`를 호출하는 방식이다. 하지만 앱이 꺼져 있거나 자동 동기화가 꺼진 동안 파일이 삭제되면 delete 이벤트가 발생하지 않는다.

이후 `FullSync.upload()`는 현재 vault에 존재하는 파일만 스캔한다. 따라서 로컬에는 사라졌지만 PouchDB에는 남아 있는 기존 문서를 tombstone으로 바꾸지 못한다.

영향:

- 상대 vault에는 삭제가 전파되지 않는다.
- 이후 원격 변경이나 다운로드 정합 시 삭제했던 파일이 다시 생성될 수 있다.
- 이름변경도 오프라인 중 발생하면 옛 경로 삭제가 누락될 수 있다.

권장 수정:

- 단순히 "PouchDB/서버에는 있는데 현재 vault에는 없다"는 이유만으로 tombstone 처리하면 안 된다. 신규 vault, 빈 vault, `localRoot` 오설정, 공유 폴더 미생성 상태에서 `both`/`up`을 실행할 때 서버 문서 전체를 삭제로 오판할 수 있다.
- 삭제 추론은 "이 로컬 vault에서 과거에 실제로 존재하거나 성공적으로 적용된 적 있는 파일이 지금 사라졌다"는 근거가 있을 때만 수행한다.
- 이를 위해 링크별 local manifest를 둔다. 예: `dbPath`, `contentHash`, `lastSeenAt`, `appliedToVault`, `sourceRev` 같은 정보를 저장하고, 전체 정합 시 현재 vault 파일 목록과 manifest를 비교한다.
- manifest가 없거나 비어 있는 첫 동기화, 로컬 캐시 초기화 직후, 새 기기/빈 vault로 판단되는 경우에는 삭제 보정을 비활성화한다.
- manifest의 마지막 hash/rev와 현재 PouchDB 문서 hash/rev가 다르면, 사용자가 삭제한 사이 상대가 수정했을 가능성이 있으므로 tombstone 대신 "삭제 vs 원격 수정" 충돌 또는 보류 상태로 남긴다.
- 회귀 테스트: 자동 동기화 중지 상태에서 이 vault에 과거 관찰 이력이 있는 파일을 삭제한 뒤 `upload-only` 또는 시작 시 정합을 실행하면 tombstone 문서가 생성되어야 한다. 반대로 신규/빈 vault에서 `both`/`up`을 실행해도 서버 문서가 tombstone 처리되지 않아야 한다.

### P2. 업로드만/다운로드만 명령이 실제로는 양방향 원격 replication을 수행함

- 위치: `src/core/sync/FullSync.ts:25-47`
- 관련 위치: `src/core/couch/PouchService.ts:281-286`

`FullSync.run()`은 방향이 `up`, `down`, `both` 중 무엇이든 `ctx.pouch.replicateOnce()`를 호출한다. `replicateOnce()`는 항상 push 후 pull을 수행한다.

즉 사용자가 "다운로드만 실행"을 눌러 서버 상태로 복구하려는 경우에도, 로컬 PouchDB에 쌓인 변경이 먼저 서버로 push될 수 있다. 반대로 "업로드만 실행"도 서버 변경을 pull한다.

영향:

- 명령 이름과 실제 동작이 달라 복구 작업 중 의도치 않은 서버 변경이 발생할 수 있다.
- 오프라인 큐가 남아 있는 상황에서는 특히 위험하다.

권장 수정:

- `replicateOnce()`를 `replicatePushOnce()`와 `replicatePullOnce()`로 분리한다.
- `up`: upload 후 push만 실행
- `down`: pull 후 download만 실행
- `both`: push/pull 순서를 명시적으로 선택하되, 충돌 정책에 맞게 처리
- UI 설명도 "원격까지 반영"인지 "로컬 DB만 정합"인지 분명히 나눈다.

### P2. 로컬 캐시 초기화가 공유 공간 DB를 삭제하지 않음

- 위치: `src/main.ts:167-182`
- 관련 위치: `src/modes/teacher/TeacherMode.ts`, `src/modes/student/StudentMode.ts`

`destroyLocalCaches()`는 교사 모드에서 학생 개인 mirror DB만, 학생 모드에서 개인 `remoteDb`만 삭제한다. 공유 공간 DB(`sharedSpaces[].remoteDb`)는 포함되지 않는다.

영향:

- `resetLocalCache()` 또는 역할 재설정 후에도 공유 공간의 IndexedDB 캐시가 남는다.
- 공유 DB의 stale 문서, 충돌 리비전, 오래된 shares 관련 상태가 다시 보일 수 있다.
- "서버에서 다시 받기"라는 사용자 기대와 다르게 공유 공간은 완전히 초기화되지 않는다.

권장 수정:

- 교사 모드: `students[].remoteDb`와 `sharedSpaces[].remoteDb`를 모두 포함한다.
- 학생 모드: 개인 `remoteDb`와 현재 settings 또는 shares 문서에서 알 수 있는 공유 DB를 함께 삭제한다.
- 학생 모드는 shares 문서를 로컬 캐시 삭제 전에 읽어 공유 DB 목록을 확보하거나, 런타임 `mode.getSyncs()` 기준으로 삭제 대상을 수집하는 방식이 안전하다.

## 추가 관찰

### 경로 설정 검증 부족

- 위치: `src/settings/SettingsTab.ts:393-426`
- 관련 위치: `src/core/path/path.ts:22-29`

DB path는 `validateVaultPath()`로 검증하지만, 사용자 입력인 `archiveFolder`, `conflictFolder`, `excludeFolders`, 학생/공유 폴더명은 저장 시 충분히 검증되지 않는다.

권장:

- 설정 저장 시 빈 값, `..`, 절대 경로, `.obsidian` 내부 경로, archive/conflict 폴더 중복을 막는다.
- 공유 폴더와 학생 폴더가 겹치는 경우 경고를 표시한다.

### 공유 폴더 중첩 처리의 의미가 UI에서 드러나지 않음

- 위치: `src/core/sync/childRoots.ts:10-18`

`computeChildRoots()`는 중첩된 동기화 root를 제외해 이중 동기화를 막는다. 다만 학생 폴더 안에 공유 폴더를 둔 경우, 어느 DB가 어느 파일을 담당하는지 사용자가 알기 어렵다.

권장:

- 설정 UI에서 중첩 root를 감지해 "이 폴더는 다른 링크가 담당합니다" 같은 설명을 제공한다.
- 대시보드에 제외된 child root를 표시하면 문제 진단이 쉬워진다.

## 권장 수정 순서

1. pending 중 원격 변경 처리 방식을 수정한다.
2. 수동 동기화 방향을 push/pull로 분리한다.
3. local manifest 기반으로만 오프라인 삭제 누락을 tombstone 보정한다.
4. 로컬 캐시 초기화 대상에 공유 DB를 포함한다.
5. 경로 설정 검증과 UI 경고를 추가한다.
6. 위 시나리오를 테스트로 고정한다.

## 테스트 제안

현재 저장소에는 별도 테스트 파일이 보이지 않고, 빌드 검증만 존재한다. 동기화 로직은 이벤트 순서에 민감하므로 아래 시나리오 테스트를 우선 추가하는 것이 좋다.

- 로컬 수정 debounce 중 원격 변경 pull: 원격본이 충돌 또는 보존본으로 남아야 한다.
- 자동 동기화 off 상태에서 파일 삭제 후 시작: manifest에 관찰 이력이 있는 파일만 tombstone 처리되어야 한다.
- 신규/빈 vault에서 `both` 또는 `up` 실행: 서버에만 있는 문서가 삭제로 오판되어 tombstone 처리되지 않아야 한다.
- 다운로드만 실행: 로컬 변경이 원격으로 push되지 않아야 한다.
- 업로드만 실행: 원격 변경이 pull되어 vault에 적용되지 않아야 한다.
- 로컬 캐시 초기화: 학생 개인 DB와 공유 DB 캐시가 모두 삭제되어야 한다.
- 공유 폴더가 학생 폴더 아래에 있을 때: 개인 mirror DB가 공유 폴더 파일을 업로드하지 않아야 한다.

## 검증 기록

실행한 확인:

```bash
npm run build
```

결과:

- TypeScript 검사 통과
- esbuild production 번들 생성 통과
- 리뷰 과정 후 작업 트리는 보고서 작성 전까지 깨끗한 상태였음
