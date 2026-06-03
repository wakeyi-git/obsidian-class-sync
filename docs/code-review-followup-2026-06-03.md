# Class Sync 후속 코드 검토 보고서

- 작성일: 2026-06-03
- 대상: P1/P2 수정 후 재검토
- 확인 결과: `npm run build` 통과, `npm run test` 통과
- 테스트 결과: 3개 테스트 파일, 17개 테스트 통과

## 요약

수정 방향은 전반적으로 좋다. 수동 동기화 방향 분리, 공유 DB 캐시 초기화 포함, 경로 검증, 중첩 root 표시, 단위 테스트 도입은 이전 검토에서 지적한 위험을 실질적으로 줄였다.

다만 삭제 정합은 아직 local manifest 기반이 아니라 `lastModifiedDeviceId` 기반이라, 빈 vault는 막지만 `localRoot` 오설정이나 부분 스캔 상황에서 대량 tombstone 위험이 남아 있다. 또한 pending 보존은 markdown 문서에는 적용됐지만 asset 충돌에는 같은 위험이 남아 있다.

## 주요 발견 사항

### P1. 삭제 orphan 판정이 local manifest가 아니라 lastModifiedDeviceId에 의존함

- 위치: `src/core/sync/orphans.ts:18`
- 관련 위치: `src/core/sync/FullSync.ts:113`

현재 `selectOrphans()`는 다음 조건으로 삭제 후보를 고른다.

- 문서가 tombstone이 아님
- 현재 vault 스캔 결과에 같은 `dbPath`가 없음
- `lastModifiedDeviceId`가 현재 기기와 같음

이 방식은 신규/빈 vault에서 다른 기기가 만든 서버 문서를 삭제하는 사고는 막는다. 하지만 이 기기가 과거에 만든 문서가 서버에 있고, 사용자가 `localRoot`를 잘못 바꾸거나 일부 파일만 들어 있는 폴더에서 `up`을 실행하면, 현재 스캔에 빠진 문서를 삭제로 오판할 수 있다.

영향:

- `localRoot` 오설정 시 이 기기가 만든 기존 서버 문서를 대량 tombstone 처리할 수 있다.
- 부분 복구/부분 vault 상태에서 업로드만 실행하면 누락 파일이 삭제로 전파될 수 있다.
- "이 vault에서 과거에 존재했던 파일이 지금 사라졌다"는 근거가 아직 없다.

권장 수정:

- 링크별 local manifest를 도입한다.
- manifest에는 `dbPath`, `contentHash`, `sourceRev`, `lastSeenAt`, `appliedToVault` 같은 값을 저장한다.
- 삭제 후보는 "manifest에 과거 관찰/적용 이력이 있고, 현재 vault에 없고, 원격 문서가 그 이후 다른 기기에서 바뀌지 않은 경우"로 제한한다.
- manifest가 없거나 비어 있거나 캐시 초기화 직후인 경우 삭제 정합을 비활성화한다.

### P1. pending 보존이 asset에는 적용되지 않음

- 위치: `src/core/sync/MirrorApplier.ts:165`

markdown 문서는 pending 중 다른 기기의 원격 변경이 들어오면 `_충돌/`에 원격본을 materialize하도록 개선됐다. 하지만 asset 경로는 pending이면 바로 `skipped-pending`으로 끝난다.

이후 로컬 asset 업로드가 현재 로컬 PouchDB 최신 rev 위에 올라가면, 원격 바이너리 변경은 보존본 없이 사라질 수 있다.

영향:

- 이미지, PDF, 첨부 파일 교체 충돌에서 원격 변경이 보존되지 않을 수 있다.
- `syncAssets`가 기본 켜짐이라 실제 사용 중 발생 가능성이 있다.

권장 수정:

- asset pending에서도 다른 기기 변경이면 보존 경로를 만든다.
- 바이너리 충돌은 markdown처럼 내용 비교 UI가 어렵기 때문에 `_충돌/` 아래에 원격 asset 파일을 별도 이름으로 저장하거나 로그와 대시보드에 명확히 표시한다.
- asset 충돌 테스트를 추가한다.

### P2. both 방향에서는 삭제 정합이 실행되지 않음

- 위치: `src/core/sync/FullSync.ts:101`

`reconcileDeletions()`는 현재 `direction === "up"`일 때만 실행된다. 따라서 사용자가 "전체 동기화"(`both`)를 실행하면 오프라인/비활성 상태에서 삭제된 파일 보정이 빠진다.

영향:

- 구현 요약의 "업로드만/전체 실행 시점에 보정"과 실제 동작이 다르다.
- 사용자가 일반적으로 누를 가능성이 높은 "전체 동기화"에서 삭제 누락 문제가 계속 남는다.

권장 수정:

- local manifest 기반 안전장치가 먼저 들어간 뒤, `both`에서도 삭제 정합을 실행한다.
- 실행 순서는 `upload/reconcile deletions -> push -> pull -> download`처럼 명확히 정의한다.

### P2. `.obsidian` 정확 경로가 폴더 검증을 통과함

- 위치: `src/core/path/path.ts:28`
- 관련 위치: `src/settings/SettingsTab.ts:509`

`validateVaultPath()`는 `.obsidian/` 접두만 막고 `.obsidian` 자체는 막지 않는다. 하지만 설정 UI 안내는 `.obsidian 불가`라고 되어 있어 실제 동작과 다르다.

영향:

- 보관 폴더, 충돌 폴더, 학생 폴더 등을 `.obsidian`으로 설정할 수 있다.
- Obsidian 플러그인 내부 경로에 파일을 만들거나 이동하려는 위험한 설정이 저장될 수 있다.

권장 수정:

- `if (p === ".obsidian" || p.startsWith(".obsidian/")) return false;`로 수정한다.
- 테스트에 `.obsidian` 단독 경로를 추가한다.

## 개선 확인

다음 항목은 이전보다 개선됐다.

- `PouchService`에 `replicatePushOnce()`와 `replicatePullOnce()`가 추가되어 `up`/`down` 방향이 분리됐다.
- `main.ts`의 로컬 캐시 삭제 대상에 `sharedSpaces[].remoteDb`가 포함됐다.
- `validateFolderName()`과 `foldersOverlap()` 테스트가 추가됐다.
- 대시보드에서 중첩 root를 표시해 이중 동기화 제외 상태를 더 잘 볼 수 있게 됐다.
- Vitest 기반 단위 테스트가 도입됐다.

## 권장 수정 순서

1. 삭제 정합을 local manifest 기반으로 바꾼다.
2. manifest 기반 안전장치가 들어간 뒤 `both`에서도 삭제 정합을 실행한다.
3. asset pending 원격 변경 보존을 추가한다.
4. `.obsidian` 단독 경로 검증을 막고 테스트를 추가한다.
5. `FullSync`의 방향별 동작을 통합 테스트로 고정한다.

## 검증 기록

실행한 확인:

```bash
npm run test
npm run build
```

결과:

- `npm run test`: 3개 테스트 파일, 17개 테스트 통과
- `npm run build`: TypeScript 검사 및 production 번들 통과

