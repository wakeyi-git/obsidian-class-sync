# Class Sync 보안·운영 관점 추가 검토 보고서

- 작성일: 2026-06-03
- 대상: Obsidian 플러그인 `class-sync` 0.12.0
- 검토 관점: 보안/개인정보, 초대·권한 모델, 실시간 편집 운영, 모바일 성능, 패키징 검증
- 확인 결과: `npm run build` 통과, `npm run test` 통과
- 테스트 결과: 3개 테스트 파일, 25개 테스트 통과
- i18n 확인: 영문 키 447개, 중복 0개

## 요약

동기화 정합성 관련 핵심 위험은 최근 수정으로 상당히 안정화됐다. 이번 검토에서는 다른 관점, 특히 학생 계정 초대 방식, Yjs 실시간 편집 권한 모델, 모바일 대용량 파일 처리, Excalidraw 실시간 스냅샷 경로를 보았다.

가장 중요한 남은 위험은 실시간 편집 토큰이 공유 공간별/room별 권한이 아니라 학급 전체 마스터 키처럼 쓰인다는 점이다. 초대 코드에 학생 DB 비밀번호가 그대로 들어가는 방식도 least-privilege로 완화되지만 운영상 노출 위험이 있다. 또한 manifest 검증이 큰 asset을 다시 읽는 점과 `.excalidraw` 파일의 실시간 종료 스냅샷이 CouchDB에 저장되지 않을 수 있는 점은 모바일/실시간 사용성 관점에서 보완이 필요하다.

## 주요 발견 사항

### P1. Yjs 토큰이 학급 전체 마스터 키처럼 배포됨

- 위치: `src/main.ts:288`
- 관련 위치: `src/core/realtime/RealtimeManager.ts:130`

교사가 공유 공간을 배포할 때 같은 `s.yjsToken`을 모든 학생 mirror DB의 `rtconfig` 문서에 쓴다. 학생 클라이언트는 이 토큰을 받아 WebSocket provider의 query parameter로 보낸다.

현재 문서화된 서버 구조가 토큰 값만 확인하는 방식이라면, 학생 1명의 토큰이 유출되었을 때 해당 토큰으로 다른 공유 room에 접속할 수 있다. room 이름도 `classId/share/spaceId/dbPath` 형태라, `classId`, `spaceId`, 파일 경로를 알거나 추측할 수 있으면 접근 범위가 넓어진다.

영향:

- 학생 한 명의 기기/초대/설정이 유출되면 학급 내 여러 실시간 room에 접근할 수 있다.
- 공유 공간 멤버십이 CouchDB `_security`에서는 제한되더라도, Yjs 서버에서는 별도 멤버십 검증이 없다면 우회될 수 있다.
- 토큰을 WebSocket URL query로 보내므로 프록시/서버 로그에 남을 수 있다.

권장 수정:

- 공유 공간별 토큰을 발급한다.
- 더 안전하게는 room-bound token을 사용한다. 예: token payload에 `classId`, `spaceId`, 허용 room prefix, 만료 시간을 넣고 서버에서 검증한다.
- Yjs 서버에서 "이 토큰은 이 room 목록 또는 prefix만 허용"하는 권한 체크를 한다.
- 토큰을 query string 대신 가능한 경우 header/subprotocol 방식으로 전달한다. `y-websocket` 제약이 있으면 서버 로그에서 query를 마스킹한다.
- 공유 공간 멤버 변경 시 기존 토큰을 회전할 수 있게 한다.

### P2. 초대 코드/딥링크가 학생 DB 비밀번호를 base64로 포함함

- 위치: `src/core/invite/invite.ts:5`
- 관련 위치: `src/ui/InviteModal.ts:67`

초대 페이로드에는 `couchdbUrl`, `remoteDb`, `username`, `password`가 포함된다. 이 값은 암호화가 아니라 base64url로 인코딩되어 QR, 딥링크, 텍스트 코드로 표시된다.

학생 전용 계정이고 DB 권한이 제한되어 있어 피해 범위는 완화된다. 그러나 QR 사진, 클립보드, 메신저 전달 기록, 브라우저/OS 딥링크 로그에 비밀번호가 남을 수 있다.

영향:

- 학생 계정 비밀번호가 장기간 재사용될 수 있다.
- 초대 코드가 전달 과정에서 유출되면 해당 학생 mirror DB에 접근할 수 있다.
- 교사가 초대 코드를 다시 발급해도 기존 비밀번호가 계속 유효할 수 있다.

권장 수정:

- 단기 초대 토큰을 사용하고, 학생이 초대를 적용할 때 서버가 실제 계정 비밀번호를 발급하거나 회전한다.
- 초대 적용 성공 후 학생 비밀번호를 자동 회전하는 흐름을 고려한다.
- QR/코드 UI에 "비밀번호 포함, 만료 없음" 또는 "재발급 시 이전 초대 무효화" 같은 운영 안내를 더 명확히 표시한다.
- 교사 UI에 학생 비밀번호 회전/초대 폐기 버튼을 제공한다.

### P2. manifest 기록이 첨부 최대 크기 보호를 우회해 큰 파일을 다시 읽음

- 위치: `src/core/sync/FullSync.ts:200`
- 관련 위치: `src/core/sync/FullSync.ts:222`, `src/core/sync/Uploader.ts:74`

업로드 로직은 asset을 읽기 전에 `maxAttachmentMB`와 파일 크기를 확인한다. 하지만 manifest snapshot은 모든 local file에 대해 `verifiedEntry()`를 호출하고, asset이면 `readVaultBinary()` 후 `sha256()`을 계산한다.

즉 동기화 대상 폴더에 큰 동영상, ZIP, PDF가 있을 경우 업로드는 크기 제한으로 생략되더라도 manifest 검증 단계에서 다시 메모리에 읽힐 수 있다.

영향:

- 모바일에서 큰 파일을 읽으며 메모리 사용량이 급증할 수 있다.
- 전체 동기화 완료 시간이 길어질 수 있다.
- 사용자가 "첨부 최대 크기"로 보호된다고 기대한 파일이 다른 경로에서 처리될 수 있다.

권장 수정:

- `verifiedEntry()`에서도 asset은 `stat.size`를 먼저 확인한다.
- `maxAttachmentMB`를 초과하는 asset은 manifest에 기록하지 않는다.
- 가능하면 기존 업로드 단계에서 계산한 hash를 재사용하거나, manifest 기록용 hash cache를 둔다.
- 대용량 asset은 streaming hash가 가능할 때만 확장한다.

### P2. `.excalidraw` 실시간 종료 스냅샷이 CouchDB에 저장되지 않을 수 있음

- 위치: `src/core/realtime/RealtimeManager.ts:417`
- 관련 위치: `src/core/sync/Uploader.ts:37`

Excalidraw 실시간 세션 종료 시 `snapshotNote(path, content)`를 호출한다. 그러나 `snapshotNote()`는 내부적으로 `Uploader.uploadContent()`를 사용하고, `uploadContent()`는 markdown 파일만 허용한다.

따라서 `.excalidraw.md` 파일은 snapshot 대상이 될 수 있지만, `.excalidraw` 확장자는 markdown이 아니므로 `skipped-outside`가 되어 CouchDB에 반영되지 않을 수 있다.

영향:

- 실시간 참여자끼리는 Yjs로 보이지만, 세션 종료 후 비실시간 멤버 또는 나중에 접속한 멤버에게 Excalidraw 변경이 반영되지 않을 수 있다.
- 사용자는 실시간 편집이 저장되었다고 생각하지만 mirror DB에는 최신 상태가 없을 수 있다.

권장 수정:

- 실시간 Excalidraw 지원 대상을 `.excalidraw.md`로 제한하고 UI/진단 로그에 명확히 표시한다.
- 또는 `.excalidraw`를 asset/text asset으로 저장하는 별도 snapshot API를 추가한다.
- `snapshotNote()` 대신 `snapshotPath()`처럼 markdown과 asset/text 파일을 모두 처리하는 메서드를 만든다.
- 반환값이 `skipped-outside`인 경우 사용자에게 경고를 남긴다.

## 추가 관찰

### 패키징/릴리스 상태

- `package.json`, `manifest.json`, `versions.json`은 0.12.0으로 맞춰져 있다.
- GitHub release workflow는 tag push 시 `main.js`, `manifest.json`, `styles.css`를 릴리스에 첨부한다.
- `npm run build`가 release workflow에 포함되어 있어 기본 패키징 검증은 되어 있다.

권장:

- release workflow에 `npm run test`를 추가한다.
- 가능하면 i18n 중복키 검사도 CI에 넣는다.

### 실시간 토큰 운영

Yjs 토큰이 교사 설정에서 학생에게 전파되는 구조이므로, 토큰 회전 UX가 중요하다.

권장:

- 공유 공간 재배포 시 토큰 회전 옵션을 제공한다.
- 멤버 제거 시 해당 공유 공간 토큰을 자동 회전한다.
- Yjs 서버 로그에서 query token을 출력하지 않도록 문서화한다.

## 권장 수정 순서

1. Yjs 토큰을 공유 공간별 또는 room-bound 권한으로 바꾼다.
2. `.excalidraw` 실시간 스냅샷 경로를 명확히 고친다.
3. manifest 검증에서 큰 asset 크기 제한을 적용한다.
4. 초대 코드 운영을 단기 토큰/비밀번호 회전 모델로 개선한다.
5. CI에 `npm run test`와 i18n 중복키 검사를 추가한다.

## 검증 기록

실행한 확인:

```bash
npm run test
npm run build
node -e "<i18n duplicate key check>"
```

결과:

- `npm run test`: 3개 테스트 파일, 25개 테스트 통과
- `npm run build`: TypeScript 검사 및 production 번들 통과
- 영문 i18n 키: 447개
- 중복 키: 0개

