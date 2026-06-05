# Class Sync 코드 검토 후속 보고서 3

- 작성일: 2026-06-03
- 대상: 이전 검토 보고서 반영 후 수정본
- 검토 관점: 보안/운영 안정성, 초대 무효화, 실시간 인증 전환, 첨부파일 메모리 보호, 삭제 정합 회귀

## 요약

이전 보고서의 핵심 이슈는 대부분 올바른 방향으로 반영되었다.

- 공유 공간별 HMAC 토큰 도입으로 전역 토큰 유출 시 학급 전체가 열리는 문제를 크게 줄였다.
- 초대 코드에 비밀번호 포함 경고와 비밀번호 재발급 버튼이 추가되어 유출 대응 UX가 개선되었다.
- `.excalidraw` 실시간 지원 범위를 `.excalidraw.md`로 제한해 스냅샷 미전파 위험을 줄였다.
- manifest 기반 삭제 정합은 기준선 검증, rev/hash 비교, 대량 삭제 중단 장치가 들어가 이전 P1 계열 위험을 잘 낮췄다.
- 릴리스 워크플로우에 테스트와 i18n 중복키 검사가 추가되었다.

검증 결과 `npm run test`, `npm run build`, i18n 중복키 검사는 모두 통과했다.

다만 실제 배포/운영에서 문제가 될 수 있는 잔여 이슈가 남아 있다. 아래 항목은 우선순위 순서로 정리했다.

## Findings

### P2. 기본 docker-compose가 공개된 HMAC 시크릿으로 바로 기동됨

- 위치: `docs/docker-compose.yml:12`
- 관련 위치: `docs/server.js:13`

`docs/docker-compose.yml`의 기본값이 다음처럼 실제 환경변수로 설정되어 있다.

```yaml
- YJS_SECRET=CHANGE_ME_to_a_long_random_secret
```

사용자가 문서를 그대로 복사해 배포하면 알려진 시크릿으로 HMAC 모드가 켜진다. 이 경우 `classId`와 `spaceId`를 추측하거나 알 수 있는 공격자가 같은 시크릿으로 유효한 공간 토큰을 만들 수 있다.

권장 수정:

- compose 예시는 `YJS_SECRET` 줄을 주석 처리하고, 반드시 새 값을 넣으라는 안내로 바꾼다.
- 또는 `docs/server.js` 시작 시 `CHANGE_ME`, `changeme`, 너무 짧은 secret 등을 거부해 컨테이너가 실패하도록 한다.

예:

```js
if (secret && /^CHANGE_ME/i.test(secret)) {
  throw new Error("YJS_SECRET must be replaced before production use.");
}
```

### P2. 비밀번호 재발급이 로컬 값을 먼저 바꿔 실패 시 중간 상태가 생길 수 있음

- 위치: `src/main.ts:257`
- 세부 위치: `src/main.ts:263`, `src/main.ts:265`

현재 `rotateStudentPassword()`는 `student.password`를 먼저 교체한 뒤 `inviteStudent(student)`를 호출한다.

```ts
student.password = genPassword();
await this.inviteStudent(student);
```

서버 갱신이 실패하면 기존 서버 비밀번호는 그대로인데 로컬 객체는 새 비밀번호로 바뀐 상태가 될 수 있다. 더 위험한 경우 `_users` 비밀번호 갱신은 성공했지만 DB 생성 또는 `_security` 단계에서 실패하면, 이전 초대는 이미 무효화됐는데 새 초대가 저장/표시되지 않는 상태가 생긴다.

권장 수정:

- 새 비밀번호를 임시 변수로 만든다.
- 서버 `_users` 갱신과 필요한 권한 확인이 성공한 뒤에만 `student.password`에 반영하고 저장한다.
- 재발급 전용 메서드를 분리해, 기존 학생 프로비저닝 전체 단계와 비밀번호 회전 단계를 구분한다.

간단한 방향:

```ts
const nextPassword = genPassword();
const nextStudent = { ...student, password: nextPassword };
const ok = await this.provisionStudentForInvite(nextStudent);
if (!ok) return;
student.password = nextPassword;
student.provisioned = true;
await this.saveSettings();
this.openInvite(student);
```

### P2. 큰 첨부파일은 자동 감시 단계에서 여전히 메모리에 읽힘

- 위치: `src/core/sync/LocalWatcher.ts:70`
- 세부 위치: `src/core/sync/LocalWatcher.ts:84`
- 관련 위치: `src/core/sync/Uploader.ts:74`

업로드 단계는 `Uploader.uploadAsset()`에서 `stat.size`를 먼저 확인하므로 큰 첨부파일을 읽지 않고 생략한다. 하지만 자동 감시 단계는 업로드 전에 `currentHash()`를 호출하고, 비마크다운 파일이면 바로 `readVaultBinary()`로 전체 바이너리를 읽어 해시를 만든다.

즉 `maxAttachmentMB`가 있어도 자동 동기화 중 큰 파일을 한 번은 메모리에 올릴 수 있다. 모바일 보호 목적이 완전히 달성되지 않는다.

권장 수정:

- `LocalWatcher.currentHash()` 또는 `maybeSchedule()`에서 비마크다운 파일의 `stat.size`를 먼저 검사한다.
- 한도 초과면 해시 계산 없이 생략하고, 필요하면 `skipped-toolarge`와 같은 로그를 남긴다.
- `exceedsAttachmentLimit()` helper를 watcher에서도 재사용한다.

예:

```ts
if (!this.ctx.isMarkdown(localPath)) {
  const size = this.ctx.getFile(localPath)?.stat.size ?? 0;
  if (exceedsAttachmentLimit(size, this.ctx.settings.maxAttachmentMB || 0)) return null;
}
```

### P2. HMAC 시크릿/TTL 변경 시 비대상 공유 공간 토큰이 오래 남을 수 있음

- 위치: `src/main.ts:303`
- 관련 위치: `src/main.ts:313`

공유 공간 배포 시 현재 배포 대상 공간은 토큰을 재발급하지만, 다른 공간은 토큰이 없을 때만 발급한다.

```ts
if (sp.id === space.id || !sp.token) {
  sp.token = await mintSpaceToken(...);
}
```

그런데 같은 배포 과정에서 모든 학생의 `shares` 문서가 다시 기록된다. 따라서 `yjsSecret`을 변경했거나 TTL이 만료된 상황에서 한 공간만 배포하면, 다른 공간의 구시크릿/만료 토큰이 그대로 학생에게 다시 내려갈 수 있다. 결과적으로 일부 공유 공간의 실시간 연결만 실패하는 운영 문제가 생긴다.

권장 수정:

- HMAC 모드에서는 배포 시 모든 공유 공간 토큰을 재발급한다.
- 또는 토큰 payload의 `exp`, 발급 시각, secret version/hash를 설정에 저장해 만료/시크릿 변경을 감지한다.
- UI에 "모든 공유 공간 토큰 재발급" 버튼을 별도로 제공하는 것도 좋다.

가장 단순한 안전안:

```ts
if (s.yjsSecret) {
  for (const sp of s.sharedSpaces) {
    sp.token = await mintSpaceToken(s.yjsSecret, { classId: s.classId, spaceId: sp.id, exp: ttl });
  }
}
```

### P3. 실시간 진단 로그가 HMAC 모드에서 토큰 없음처럼 보일 수 있음

- 위치: `src/core/realtime/RealtimeManager.ts:267`

`diagnose()`는 `s.yjsToken`만 보고 토큰 유무를 표시한다. 하지만 HMAC 모드에서는 실제 토큰이 `SharedSpace.token`에 들어 있고, `settings.yjsToken`은 비어 있을 수 있다. 이 경우 실시간 설정은 정상인데 진단 로그는 `token=없음`처럼 보일 수 있다.

권장 수정:

- 전역 토큰과 공간 토큰을 구분해 표시한다.
- 현재 활성 파일이 속한 공유 공간에 `space.token`이 있는지도 함께 출력한다.

예:

```txt
실시간 점검 - url=설정됨, legacyToken=없음, spaceTokens=3/3
활성 파일 - 공유공간=g1, spaceToken=설정됨
```

## 잘 반영된 부분

### 공간별 HMAC 토큰

- 위치: `src/core/realtime/spaceToken.ts`
- 위치: `docs/server.js`

토큰 payload를 `{c: classId, s: spaceId, e?: exp}`로 제한하고, 서버가 room prefix `class_<c>/share/<s>/`를 확인하는 구조는 타당하다. 전역 토큰 대비 피해 범위를 공유 공간 단위로 줄인다.

### 포터블 설정에서 secret 제거

- 위치: `src/settings/portable.ts`

`password`, `yjsToken`, `yjsSecret`, `sharedSpaces[].token`, `students[].password`가 내보내기에서 제외된다. 설정 백업/기기 이전 시 비밀값이 함께 유출되는 위험을 줄인다.

### manifest 기반 삭제 정합

- 위치: `src/core/sync/FullSync.ts`
- 위치: `src/core/sync/LinkManifest.ts`

기준선 manifest가 없거나 비었을 때 삭제 정합을 건너뛰고, `localRoot` 변경 시 기준선을 무효화하며, rev/hash가 모두 동일한 경우에만 tombstone 후보로 삼는 방식은 안전하다. 대량 삭제 임계치도 빈 vault/오설정 사고를 줄이는 데 도움이 된다.

### `.excalidraw.md` 제한

- 위치: `src/core/realtime/RealtimeManager.ts`

순수 `.excalidraw` 파일은 실시간 세션을 켜지 않고 경고를 남기도록 한 것은 적절하다. 현재 스냅샷 경로가 markdown 업로드에 의존하므로, `.excalidraw.md`만 지원하는 제한은 명확한 안전장치다.

### 릴리스 워크플로우 검증

- 위치: `.github/workflows/release.yml`

릴리스 전에 `npm run test`, i18n 중복키 검사, `npm run build`가 실행된다. 이전처럼 빌드만 통과하고 테스트/번역 회귀가 릴리스되는 위험이 줄었다.

## 검증

이번 검토 중 확인한 결과:

- `npm run test`: 통과, 25 tests
- `npm run build`: 통과
- i18n 중복키 검사: 중복 0

## 권장 수정 우선순위

1. `docs/docker-compose.yml`의 기본 `YJS_SECRET`를 주석 처리하거나 서버에서 placeholder secret을 거부한다.
2. `rotateStudentPassword()`를 서버 성공 후 로컬 반영 순서로 바꾼다.
3. `LocalWatcher`에서도 첨부 크기 제한을 먼저 검사해 큰 파일을 읽지 않게 한다.
4. HMAC 모드에서 토큰 재발급 정책을 전체 공유 공간 기준으로 정리한다.
5. 실시간 진단 로그에 legacy token과 space token 상태를 분리해서 표시한다.
