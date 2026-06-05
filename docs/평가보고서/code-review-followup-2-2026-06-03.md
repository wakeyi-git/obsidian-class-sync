# Class Sync 2차 후속 코드 검토 보고서

- 작성일: 2026-06-03
- 대상: manifest 기반 삭제 정합 및 asset 보존 추가 후 재검토
- 확인 결과: `npm run build` 통과, `npm run test` 통과
- 테스트 결과: 3개 테스트 파일, 24개 테스트 통과

## 요약

이번 수정으로 이전 라운드의 가장 큰 위험이 많이 줄었다. 삭제 정합은 `lastModifiedDeviceId` 추론에서 링크별 `_local/manifest` 기준선으로 바뀌었고, 신규/빈 vault나 캐시 초기화 직후에는 삭제 보정이 비활성화된다. `localRoot` 변경 무효화, 대량 삭제 임계치, `both` 실행 포함, asset 충돌 보존, `.obsidian` 단독 경로 차단도 좋은 방향이다.

다만 manifest 기준선을 기록할 때 "로컬 파일이 실제로 해당 DB rev와 같은 내용인가"를 확인하지 않는 문제가 남아 있다. 또한 `both`에서는 삭제 정합이 원격 pull보다 먼저 실행되어, 오프라인 중 다른 기기가 수정한 원격 rev를 보지 못한 상태로 tombstone을 만들 수 있다.

## 주요 발견 사항

### P1. manifest 기준선이 로컬 파일 내용과 DB rev의 일치를 확인하지 않고 기록됨

- 위치: `src/core/sync/FullSync.ts:190`
- 관련 위치: `src/core/sync/FullSync.ts:195`

`writeManifestSnapshot()`은 현재 vault에 파일이 있고, 로컬 DB에 같은 `dbPath`의 `_rev`가 있으면 해당 rev를 manifest에 기록한다. 그러나 그 로컬 파일 내용이 실제로 DB 문서의 `contentHash`와 일치하는지는 확인하지 않는다.

문제가 생길 수 있는 상황:

- `download-only` 실행 후 원격 문서 적용이 `skipped-self`, `skipped-pending`, `skipped-same`, `conflict` 등으로 끝난 경우
- 충돌이 unresolved 상태로 남아 로컬 파일과 DB winner rev가 서로 다른 경우
- `syncAssets`나 첨부 크기 제한 때문에 asset 문서는 DB에 있지만 로컬 파일이 해당 rev의 바이너리를 반영하지 못한 경우
- 실시간 세션 중이거나 pending 상태라 원격 적용이 보류된 경우

이런 경로가 manifest에 들어가면 다음 삭제 정합 때 "이 vault가 과거에 해당 DB rev를 가진 파일을 보유했다"고 오판할 수 있다. 사용자가 이후 로컬 파일을 삭제하면, 실제로는 vault가 온전히 적용한 적 없는 DB rev를 tombstone 처리할 수 있다.

영향:

- unresolved conflict 또는 적용 보류 상태의 원격 문서가 삭제 정합으로 tombstone 처리될 수 있다.
- manifest가 "로컬 보유 이력"이 아니라 "로컬 파일 경로와 DB rev가 동시에 존재한 이력"으로 약해진다.
- 삭제 정합의 핵심 안전 조건이 일부 깨진다.

권장 수정:

- manifest에는 로컬 파일 내용과 DB 문서가 일치하는 항목만 기록한다.
- note는 `sha256(localContent) === doc.contentHash`인 경우만 기록한다.
- asset은 `sha256(localBinary) === doc.contentHash`이고 로컬 파일 크기/첨부 상태가 정상인 경우만 기록한다.
- `_conflicts`가 있는 문서, deleted 문서, pending/realtime active 경로, 적용 실패 경로는 manifest에서 제외한다.
- 가능하면 `ManifestEntry`에 `contentHash`도 저장해 다음 삭제 정합 시 rev와 hash를 함께 확인한다.

### P2. both 방향에서 삭제 정합이 원격 pull보다 먼저 실행됨

- 위치: `src/core/sync/FullSync.ts:40-56`

현재 `both` 실행 순서는 다음과 같다.

1. 로컬 파일 업로드
2. manifest 기준 삭제 정합
3. push 후 pull
4. 다운로드 적용
5. manifest 기록

이 순서에서는 이 vault가 오프라인인 동안 다른 기기가 원격에서 문서를 수정했더라도, 삭제 정합 시점에는 아직 local PouchDB에 최신 원격 rev가 들어오지 않았을 수 있다. 그러면 manifest의 기준 rev와 local DB의 현재 rev가 같아 보이고, 로컬에 없는 파일이 tombstone 후보가 된다.

CouchDB replication 과정에서 원격 수정과 로컬 tombstone이 충돌로 남을 가능성은 있지만, 사용자는 단순 전체 동기화를 눌렀을 뿐인데 불필요한 삭제 conflict가 만들어질 수 있다.

영향:

- 오프라인 중 "한쪽은 삭제, 다른 쪽은 수정" 시나리오에서 삭제 tombstone이 너무 이르게 만들어질 수 있다.
- 삭제 vs 원격 수정 충돌이 필요한 경우라도, 원격 최신 rev를 확인한 뒤 판단하는 편이 더 안전하다.

권장 수정:

- `both`에서는 원격 최신 rev를 먼저 pull한 뒤 삭제 정합을 수행하는 순서를 검토한다.
- 예시 순서:
  1. 로컬에 존재하는 파일 업로드
  2. 원격 pull
  3. manifest 기준 삭제 정합
  4. push
  5. 다운로드 적용
  6. manifest 기록
- `up`은 기존처럼 pull 없이 push 전 삭제 정합을 유지할 수 있다. 단, 사용자가 `up`을 선택한 경우 "원격 최신 수정과 비교하지 않는다"는 의미를 UI/로그에서 분명히 하는 것이 좋다.

## 개선 확인

다음 항목은 이전 라운드보다 명확히 개선됐다.

- 삭제 정합이 `lastModifiedDeviceId` 기반에서 `_local/manifest` 기준선으로 바뀌었다.
- manifest 없음/빈 manifest/캐시 초기화 직후에는 삭제 정합을 건너뛴다.
- `localRoot`가 바뀌면 기준선을 무효화하고 삭제 정합을 건너뛴다.
- 후보 수가 `max(5, 50%)`를 넘으면 대량 삭제로 보고 중단한다.
- `both`에서도 삭제 정합이 실행되도록 범위가 넓어졌다.
- pending 또는 충돌 상태의 asset 원격본을 `_충돌/`에 보존한다.
- 충돌 사본 이름이 확장자 앞에 라벨을 넣도록 바뀌어 `image.학생A.png` 형태가 된다.
- `.obsidian` 단독 경로가 검증에서 차단된다.

## 권장 수정 순서

1. manifest 기록 대상을 "로컬 파일 hash와 DB contentHash가 일치하는 문서"로 제한한다.
2. `_conflicts`, pending, realtime active, 적용 실패 상태는 manifest에서 제외한다.
3. `both` 실행 순서를 원격 pull 후 삭제 정합으로 조정할지 결정한다.
4. manifest 기록/삭제 정합 통합 테스트를 추가한다.
5. 오프라인 중 "삭제 vs 원격 수정" 2-vault 시나리오를 실제 환경에서 검증한다.

## 테스트 제안

현재 테스트는 순수 함수 검증에 집중되어 있다. 다음 시나리오를 추가하면 회귀 방지 효과가 커진다.

- 로컬 파일 hash와 DB `contentHash`가 다르면 manifest에 기록하지 않아야 한다.
- `_conflicts`가 있는 문서는 manifest에 기록하지 않아야 한다.
- `both`에서 원격이 오프라인 중 수정한 문서를 pull한 뒤에는 tombstone 후보에서 제외되어야 한다.
- asset pending 충돌 시 `_충돌/`에 확장자를 유지한 원격 바이너리 사본이 생겨야 한다.
- 캐시 초기화 후 첫 동기화에서는 manifest만 기록되고 tombstone이 생성되지 않아야 한다.

## 검증 기록

실행한 확인:

```bash
npm run test
npm run build
```

결과:

- `npm run test`: 3개 테스트 파일, 24개 테스트 통과
- `npm run build`: TypeScript 검사 및 production 번들 통과

