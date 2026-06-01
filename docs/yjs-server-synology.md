# 시놀로지 NAS에 Yjs WebSocket 서버 설치 가이드

이 문서는 Class Sync **Phase 6b(글자 단위 실시간 공동 편집)** 의 기반이 되는 **Yjs WebSocket 서버**를
시놀로지 NAS에 Docker(Container Manager)로 설치하는 방법을 정리한다.

- 동기화(파일 단위)는 CouchDB(Phase 0~6a)가 담당한다.
- 실시간 공동 편집(글자 단위)은 **별도의 Yjs WebSocket 서버**가 담당한다. 둘은 독립적이다.

> 개념 구조(기술문서 §19.3)
> ```
> 학생 Editor ↕ Y.Doc ↕ WebSocket 서버 ↕ Y.Doc ↕ 교사 Editor
> room 이름 예: class_2026_1/student_a/과제.md
> ```

---

## ⚠️ 먼저 — 보안 경고 (반드시 읽기)

표준 `y-websocket` 서버는 **인증·권한이 전혀 없다.** 서버에 접속할 수 있고 room 이름만 알면 **누구나** 그
문서를 읽고 쓸 수 있다. 학생 데이터를 다루므로 아래를 반드시 적용한다.

1. **외부에 1234 포트를 직접 열지 말 것.** 반드시 시놀로지 **리버스 프록시 + HTTPS(`wss://`)** 뒤에 둔다.
2. 가능하면 **VPN 내부** 또는 **신뢰된 네트워크**에서만 접근하게 한다.
3. 운영 배포 전에는 **토큰 인증**(아래 §8)을 추가한다. Phase 6b 플러그인 연동 시 토큰 검증을 함께 구현한다.

---

## 1. 사전 준비

- 시놀로지 DSM **7.2 이상**, **Container Manager** 패키지 설치(구버전은 "Docker").
- 외부 접속용 도메인 + HTTPS 인증서(예: `yourname.synology.me`, DSM의 Let's Encrypt).
- SSH 또는 File Station으로 파일을 올릴 수 있는 권한.
- 작업 폴더(예): `/volume1/docker/yjs`

---

## 2. 서버 파일 준비

File Station에서 `docker/yjs` 폴더를 만들고 아래 4개 파일을 넣는다.

### `package.json`
```json
{
  "name": "yjs-ws-server",
  "private": true,
  "dependencies": {
    "ws": "^8.16.0",
    "yjs": "^13.6.10",
    "y-websocket": "^1.5.4",
    "y-leveldb": "^0.1.2"
  }
}
```

### `server.js`
```js
const http = require("http");
const WebSocket = require("ws");
const { setupWSConnection } = require("y-websocket/bin/utils");

const host = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "1234", 10);

// 헬스체크용 HTTP 응답(리버스 프록시/모니터링 확인용)
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Yjs WebSocket server OK");
});

const wss = new WebSocket.Server({ server });
wss.on("connection", (conn, req) => setupWSConnection(conn, req));

server.listen(port, host, () => {
  console.log(`Yjs WebSocket server listening on ws://${host}:${port}`);
});
```

> `YPERSISTENCE` 환경변수가 설정되면 `y-websocket/bin/utils`가 LevelDB(`y-leveldb`)로 문서를 디스크에
> 자동 저장한다. 서버 재시작에도 편집 내용이 유지된다.

### `Dockerfile`
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js ./
ENV HOST=0.0.0.0 PORT=1234 YPERSISTENCE=/data
EXPOSE 1234
CMD ["node", "server.js"]
```

### `docker-compose.yml`
```yaml
services:
  yjs:
    build: .
    container_name: yjs-websocket
    restart: unless-stopped
    ports:
      - "1234:1234"        # NAS 내부 포트(외부 직접 노출 금지 — 리버스 프록시로만)
    environment:
      - HOST=0.0.0.0
      - PORT=1234
      - YPERSISTENCE=/data  # 영속 저장(LevelDB)
    volumes:
      - ./data:/data
```

폴더 구조:
```
/volume1/docker/yjs/
├─ docker-compose.yml
├─ Dockerfile
├─ package.json
├─ server.js
└─ data/        # 자동 생성(영속 데이터)
```

---

## 3. Container Manager로 실행

1. **Container Manager** 열기 → 좌측 **프로젝트(Project)** → **생성**.
2. 프로젝트 이름: `yjs`, 경로: `/volume1/docker/yjs`(위 파일들이 있는 폴더).
3. 소스: **기존 docker-compose.yml 사용** 선택 → 다음.
4. 빌드·실행이 시작된다(처음엔 이미지 빌드로 1~3분 소요).
5. 컨테이너가 **실행 중(running)** 상태가 되면 성공.

> CLI를 선호하면 SSH 접속 후:
> ```bash
> cd /volume1/docker/yjs
> sudo docker compose up -d --build
> sudo docker compose logs -f   # 로그 확인
> ```

---

## 4. 내부 동작 확인

같은 네트워크의 PC 브라우저에서 `http://<NAS_IP>:1234` 접속 →
`Yjs WebSocket server OK` 가 보이면 HTTP 레이어 정상.

WebSocket까지 확인하려면(선택):
```bash
npx wscat -c ws://<NAS_IP>:1234/test-room
# 연결이 유지되면 정상
```

---

## 5. 리버스 프록시 + HTTPS (`wss://`) 설정

외부/모바일에서 안전하게 쓰려면 DSM 리버스 프록시로 감싼다.

1. **제어판 → 로그인 포털 → 고급 → 리버스 프록시 → 생성**
2. **소스**
   - 프로토콜: `HTTPS`
   - 호스트 이름: `yjs.yourname.synology.me` (또는 기존 도메인 + 경로)
   - 포트: `443`
3. **대상**
   - 프로토콜: `HTTP`
   - 호스트 이름: `localhost`
   - 포트: `1234`
4. **사용자 지정 헤더(Custom Header) 탭 → 생성 → WebSocket** 프리셋 선택
   (자동으로 아래 두 헤더가 추가된다 — WebSocket 업그레이드에 필수)
   ```
   Upgrade     $http_upgrade
   Connection  $connection_upgrade
   ```
5. 저장. 인증서가 도메인에 적용돼 있어야 한다(제어판 → 보안 → 인증서).

이제 클라이언트는 **`wss://yjs.yourname.synology.me`** 로 접속한다.

> 방화벽을 쓴다면 외부에는 **443만** 열고, **1234는 내부 전용**으로 둔다(외부 차단).

---

## 6. 영속성 & 백업

- 편집 내용은 `./data`(컨테이너 `/data`)에 LevelDB로 저장된다.
- 백업: `data/` 폴더를 Hyper Backup 등으로 백업.
- 초기화가 필요하면 컨테이너 중지 후 `data/` 비우기.

---

## 7. 룸(room) 이름 규칙

문서 1개 = room 1개. Class Sync와 일관되게(기술문서 §19.3):
```
개인:  class_<classId>/<studentId>/<dbPath>
공유:  class_<classId>/share/<spaceId>/<dbPath>
```
예: `class_2026_1/student_a/과제.md`, `class_2026_1/share/g1/공지.md`

Phase 6b 플러그인이 편집 중인 파일 경로로부터 이 room 이름을 만들어 `wss://` 서버에 연결한다.

---

## 8. (권장) 토큰 인증 추가 — 운영 전 하드닝

표준 서버는 인증이 없다. 최소한 **공유 비밀 토큰**을 URL로 받아 검증하는 정도는 넣는다.
`server.js`의 connection 처리에서 토큰을 확인하도록 바꾼다.

```js
const SECRET = process.env.YJS_TOKEN; // docker-compose environment에 추가

wss.on("connection", (conn, req) => {
  if (SECRET) {
    const url = new URL(req.url, "http://x");
    if (url.searchParams.get("token") !== SECRET) {
      conn.close(4001, "unauthorized");
      return;
    }
  }
  setupWSConnection(conn, req);
});
```
- `docker-compose.yml`의 `environment`에 `YJS_TOKEN=<긴 무작위 문자열>` 추가 후 재배포.
- 클라이언트는 `wss://.../room?token=<토큰>` 으로 접속.

> 더 강한 방식: room 이름에서 `classId/studentId`를 파싱해, 그 학생이 해당 room에 접근할 권한이 있는지
> (예: 토큰을 CouchDB 세션/계정과 대조) 검증한다. 이 통합은 Phase 6b 플러그인 구현과 함께 진행한다.

---

## 9. 운영 팁

- **로그**: Container Manager → 컨테이너 → 터미널/로그, 또는 `docker compose logs -f`.
- **업데이트**: `package.json` 버전 수정 후 `docker compose up -d --build`.
- **자동 재시작**: `restart: unless-stopped` 로 NAS 재부팅 후에도 자동 기동.
- **리소스**: 학급 규모(수십 명)면 메모리 수백 MB로 충분(J 시리즈 등 저사양도 가능).

---

## 요약 체크리스트

- [ ] `docker/yjs`에 4개 파일 배치
- [ ] Container Manager 프로젝트로 빌드·실행(컨테이너 running)
- [ ] `http://NAS_IP:1234` → `OK` 확인
- [ ] 리버스 프록시(HTTPS 443 → HTTP 1234) + **WebSocket 헤더** 설정
- [ ] 외부엔 443만, 1234는 내부 전용
- [ ] (운영 전) 토큰 인증 추가
- [ ] `data/` 백업 설정

이 서버가 준비되면 Phase 6b에서 Obsidian 에디터(CodeMirror) ↔ Y.Doc ↔ `wss://` 서버를 연결해
글자 단위 실시간 공동 편집을 구현한다.
