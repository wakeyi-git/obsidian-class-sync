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

## 8. 토큰 인증 — 두 가지 모드

이 저장소의 [`server.js`](server.js)는 두 모드를 지원한다(환경변수로 선택).

### 8a. (권장) `YJS_SECRET` — 공간별 HMAC 토큰

`docker-compose.yml`에 `YJS_SECRET=<긴 무작위 문자열>`을 두면 서버가 **공유 공간(room)별 서명 토큰**을
검증한다. 플러그인 설정의 **‘Yjs 공간 시크릿(HMAC)’**에 같은 값을 넣으면, 교사가 공간을 배포할 때마다
공간별 토큰(`<payload>.<sig>`, payload=`{c:classId, s:spaceId, e?:exp}`)을 발급해 학생에게 전달한다.

- 서버는 ① 서명이 시크릿과 일치하고 ② 접속 room이 `class_<c>/share/<s>/`로 시작하며 ③ (exp가 있으면) 미만료일
  때만 허용한다. → **토큰이 유출돼도 그 공간 room에만** 접근 가능(학급 전체가 아님).
- `openssl rand -hex 32` 등으로 생성. **실제 값은 NAS에만 두고 절대 커밋/공유하지 않는다.**

**회전/폐기(무상태 서버의 한계):**
- 전체 회전 = `YJS_SECRET`와 플러그인 시크릿을 새 값으로 바꾼 뒤 공간들을 재배포(모든 토큰 무효화).
- 멤버 제거 시 그 학생은 shares에서 빠져 room을 더는 받지 못한다(연결 안 함). 다만 무상태라 이미 가진 토큰의
  **즉시 단건 폐기**는 불가 — 플러그인의 **‘공간 토큰 만료(일)’**로 TTL을 두고 주기적 재배포로 무효화한다.
- 운영: 리버스 프록시 접근 로그에 `?token=` 쿼리가 남지 않게 **마스킹**한다 → 설정 방법은 §9.1 참고.

### 8b. (레거시) `YJS_TOKEN` — 전역 공유 토큰

`YJS_SECRET` 없이 `YJS_TOKEN=<문자열>`만 두면 기존처럼 `?token=`이 그 값과 일치하는지만 본다(공간 격리 없음).
하위호환용 — 신규 배포는 8a를 쓴다. 둘 다 비우면 인증이 꺼진다(테스트 전용).

---

## 9. 운영 팁

### 9.1 로그에 토큰(`?token=`)이 남지 않게 하기

토큰은 WebSocket URL의 쿼리스트링(`wss://.../room?token=...`)으로 전달된다.

- **위협 모델**: `wss://`(HTTPS)이므로 **전송 중에는 암호화**되어 네트워크 도청으로는 토큰이 보이지 않는다.
  실제 위험은 **서버나 프록시가 요청 URL을 접근 로그로 남길 때** 토큰이 평문으로 디스크에 쌓이는 것이다.
- **Yjs 컨테이너 자체는 안전**: 이 저장소의 [`server.js`](server.js)는 접속 URL을 로그로 찍지 않는다(기동 시
  한 줄만 출력). 따라서 `docker compose logs`에는 토큰이 남지 않는다.
- 남는 곳은 **앞단 리버스 프록시의 접근 로그**다. 거기서 쿼리스트링을 빼거나 로그를 끈다.

**(A) Synology DSM 리버스 프록시 (GUI로 만든 경우)**
DSM이 nginx 설정을 자동 생성하며, 접근 로그 포맷을 GUI에서 바꿀 수 없다. 선택지:
- 가장 간단: 이 가상호스트는 **접근 로그가 꼭 필요하지 않으면 끈다.** 커스텀 nginx 조각을 추가한다
  (`/etc/nginx/conf.d/` 또는 DSM이 보존하는 사용자 conf 경로). 예:
  ```nginx
  # 이 server 블록 안
  access_log off;
  ```
- 또는 DSM 로그를 **짧은 보존주기로 로테이션**하고, Hyper Backup 등 백업 대상에서 nginx 로그를 **제외**한다.
- 더 확실히 하려면 아래 (B)처럼 **직접 운영하는 reverse proxy**를 앞에 둔다.

**(B) 직접 운영하는 nginx**
접근 로그 포맷에서 전체 요청라인(`$request`, 쿼리 포함) 대신 **경로만 남기는 `$uri`** 를 쓴다.
```nginx
# http 블록
log_format ws_nolog '$remote_addr [$time_local] "$request_method $uri" $status $body_bytes_sent';

server {
    # ... wss 프록시 설정 ...
    access_log /var/log/nginx/yjs.access.log ws_nolog;   # 또는 access_log off;
    location / {
        proxy_pass http://127.0.0.1:1234;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
```
`$uri`는 정규화된 **경로(쿼리 제외)** 라서 `?token=...`이 로그에 남지 않는다.

**(C) Caddy / Traefik**
- Caddy: 사이트 블록에서 access log를 끄거나(`log { output discard }`) 필요한 필드만 남긴다.
- Traefik: `accessLog`의 `fields.names`에서 요청 URI 필드를 `drop`하거나 query를 제외하도록 설정한다.

> 토큰이 이미 로그에 쌓였다면, 위 설정 적용 후 **기존 로그 파일을 비우거나 회전**시켜 평문 토큰을 제거한다.
> 의심되면 §8a 회전대로 `YJS_SECRET`을 교체해 모든 토큰을 무효화한다.

### 9.2 로그·모니터링

- **컨테이너 로그**: Container Manager → 컨테이너 → 로그, 또는 `docker compose logs -f`.
  기동 로그에 `auth: hmac (per-space)`(8a 모드) / `global token`(8b) / `off`가 찍혀 현재 인증 모드를 확인할 수 있다.
- **헬스체크**: `http://<NAS_IP>:1234` 또는 `https://<도메인>` 접속 시 `Yjs WebSocket server OK`.
  업타임 모니터(예: Uptime Kuma)로 이 HTTP 응답을 주기 점검하면 다운을 빨리 안다.
- **인증 실패 진단**: 클라이언트가 연결 직후 끊기고(코드 **4001**) 다시 시도하면, 시크릿 불일치(서버
  `YJS_SECRET` ≠ 플러그인 ‘Yjs 공간 시크릿’) 또는 만료(8a의 TTL 경과)일 가능성이 높다. 양쪽 값과 만료를 확인한다.

### 9.3 업데이트·재시작

- **이미지 업데이트**: `package.json`/`server.js` 수정 후
  ```bash
  cd /volume1/docker/yjs
  sudo docker compose up -d --build
  ```
  (Container Manager에선 프로젝트 → **작업 → 빌드**.) `--build`가 없으면 코드 변경이 반영되지 않는다.
- **환경변수만 변경**(예: `YJS_SECRET` 추가/교체): `docker-compose.yml` 수정 후
  `docker compose up -d --force-recreate` (재빌드는 불필요).
- **자동 재시작**: `restart: unless-stopped` 로 NAS 재부팅·컨테이너 비정상 종료 후에도 자동 기동한다.

### 9.4 리소스·스케일

- 학급 규모(수십 명, 문서 수십~수백 개)면 메모리 **수백 MB**로 충분하다(저사양 J 시리즈도 가능).
- y-websocket은 room마다 메모리에 Y.Doc을 유지한다. 동시에 열린 문서가 많을수록 메모리가 는다 —
  너무 많은 대용량 문서를 동시에 실시간 편집하면 메모리를 모니터링한다.
- 단일 프로세스로 충분하지만, 부하가 크면 NAS CPU/메모리 여유를 확인하고 동시 편집 인원을 분산한다.

### 9.5 보안 재점검(주기적으로)

- 외부에 **443만** 열려 있고 **1234는 내부 전용**인지 방화벽을 재확인한다.
- `YJS_SECRET`(8a)이 설정돼 있고 플러그인 값과 일치하는지 — 인증 off로 떨어져 있지 않은지.
- 접근 로그에 토큰이 남지 않는지(§9.1), 로그 보존주기가 과하지 않은지.
- 멤버 변경/유출 의심 시: 플러그인에서 **공간 재배포**(토큰 재발급), 심각하면 **`YJS_SECRET` 교체 + 재배포**.

### 9.6 자주 겪는 문제(트러블슈팅)

| 증상 | 원인 후보 | 조치 |
|------|-----------|------|
| 연결 직후 끊김(4001) | 시크릿 불일치 / 토큰 만료 | 서버·플러그인 시크릿 동일 확인, 공간 재배포 |
| `OK`는 뜨는데 실시간 안 됨 | WebSocket 헤더 누락 | 리버스 프록시 **WebSocket 프리셋**(Upgrade/Connection) 적용(§5) |
| 재시작하면 편집 내용 사라짐 | `YPERSISTENCE`/볼륨 미설정 | `data/` 볼륨과 `YPERSISTENCE=/data` 확인(§6) |
| `YJS_SECRET` 바꿨는데 학생이 옛 토큰으로 끊김 | 재배포 안 함 | 플러그인에서 공유 공간 **재배포** 필요 |
| 코드 고쳤는데 반영 안 됨 | `--build` 누락 | `docker compose up -d --build` |

---

## 요약 체크리스트

- [ ] `docker/yjs`에 4개 파일 배치
- [ ] Container Manager 프로젝트로 빌드·실행(컨테이너 running)
- [ ] `http://NAS_IP:1234` → `OK` 확인
- [ ] 리버스 프록시(HTTPS 443 → HTTP 1234) + **WebSocket 헤더** 설정
- [ ] 외부엔 443만, 1234는 내부 전용
- [ ] (운영 전) 토큰 인증 추가 — `YJS_SECRET`(공간별 HMAC, §8a) 권장
- [ ] 리버스 프록시 접근 로그에서 `?token=` 마스킹/로그 끄기(§9.1)
- [ ] `data/` 백업 설정(단, nginx 로그는 백업 제외)

이 서버가 준비되면 Phase 6b에서 Obsidian 에디터(CodeMirror) ↔ Y.Doc ↔ `wss://` 서버를 연결해
글자 단위 실시간 공동 편집을 구현한다.
