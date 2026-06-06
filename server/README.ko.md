# Class Sync — 서버 구축

> 🌐 **English**: [`README.md`](README.md)

Class Sync는 **독립적인 두 서버**가 필요합니다: **CouchDB**(파일 동기화, 필수)와 **Yjs WebSocket 서버**(실시간 공동 편집,
선택). 두 서버는 **서로 통신하지 않으며**(플러그인이 둘의 유일한 클라이언트), 같은 호스트·네트워크에 묶을 필요가 없습니다.
이 폴더는 두 서버 모두를 설명하며, Yjs 서버의 구동 파일은 [`yjs/`](yjs/) 하위 폴더에 들어 있습니다.

## 구조와 제약

플러그인은 독립된 두 엔드포인트와 통신하며, 둘을 잇는 유일한 주체입니다:

```
            ┌──────────────── CouchDB    (PouchDB HTTP/HTTPS 복제)
플러그인     │
(교사/      ├──────────────── Yjs 서버    (WebSocket / WSS)
 학생)       │
            └─ 실시간 스냅샷은 플러그인이 → CouchDB에 기록
```

- **Yjs 서버는 CouchDB에 전혀 접속하지 않습니다.** `ws`/`y-websocket` + HMAC만 사용하고 LevelDB에 로컬로 영속 저장합니다.
  실시간 편집이 CouchDB에 반영되는 것은 *플러그인*이 라이브 문서를 주기적으로 스냅샷해 동기화 계층으로 되돌려 쓰기 때문이며,
  서버 간 직접 연결이 아닙니다.
- 따라서 **CouchDB와 Yjs 서버는 같은 위치에 있을 필요가 없습니다**: 서로 다른 호스트·제공자·리전이어도 무방합니다.
  한 서버에 함께 두는 것은 순전히 운영 편의(한 대의 머신, 하나의 리버스 프록시)일 뿐입니다.
- 진짜 제약은 **도달성**(모든 클라이언트가 인터넷으로 둘 다에 닿을 수 있어야 함 — 원격 학생이 있으면 어느 쪽도 LAN 전용
  주소에 둘 수 없음), **HTTPS/WSS**(Obsidian 모바일은 보안 전송 필수), 그리고 Yjs 서버와 플러그인 설정 간의
  **`YJS_SECRET` 일치**입니다.

---

## CouchDB (필수)

중앙 서버. 시놀로지 NAS Docker 예시:

```bash
docker run -d --name couchdb -p 5984:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD='****' couchdb:3
```

1. **HTTPS 권장**(예: 시놀로지 리버스 프록시 + Let's Encrypt).
2. **수동 스키마 작업 불필요.** 학생 계정·mirror DB·권한은 교사가 플러그인에서 자동 생성합니다(교사 Teacher Mode의
   관리자 계정으로 `_users` 계정 + `mirror_*` DB + `_security`를 프로비저닝).
3. **CORS는 선택 사항.** 플러그인은 Obsidian `requestUrl`로 CORS를 우회하므로 없어도 동작하며, Fauxton 등 브라우저
   도구를 쓸 때만 켜면 됩니다. Obsidian origin: `app://obsidian.md`(데스크톱) · `capacitor://localhost`(iOS) ·
   `http://localhost`(Android).

### 호스팅 선택지

CouchDB는 표준 소프트웨어라, 플러그인은 HTTPS URL + 관리자 계정만 있으면 됩니다. 이미 가진 환경에 맞춰 고르세요:

- **다른 하드웨어 + Docker** — 다른 NAS(QNAP 등), 라즈베리파이 4/5, 미니PC, 또는 임의의 리눅스 머신: `couchdb:3`.
- **클라우드 VPS + Docker** — Hetzner / DigitalOcean / Vultr / Linode / AWS Lightsail / Oracle Cloud 항상 무료.
  여러 장소에서 쓰거나 고정 가정용 IP가 없을 때 적합.
- **PaaS(원클릭 컨테이너)** — Railway / Render / Fly.io에 데이터 디렉터리용 **영속 볼륨**과 함께 배포.
- **관리형** — IBM Cloudant(CouchDB 호환, 서버 관리 0; 일부 API/요금 차이).

---

## Yjs 실시간 서버 (선택)

**실시간 공동 편집**에만 필요합니다 — 파일 동기화(CouchDB)와 독립적이라, 파일 동기화만 쓸 거면 건너뜁니다. 구동 파일은
[`yjs/`](yjs/) 폴더에 있습니다:

- [`yjs/server.js`](yjs/server.js) — y-websocket 서버. 두 가지 인증 모드(공간별 HMAC `YJS_SECRET`, 또는 레거시 전역
  `YJS_TOKEN`).
- [`yjs/Dockerfile`](yjs/Dockerfile) / [`yjs/docker-compose.yml`](yjs/docker-compose.yml) /
  [`yjs/package.json`](yjs/package.json) — 컨테이너 빌드 + 실행(영속 저장은 `./data`, LevelDB).
- [`yjs/disable-yjs-accesslog.sh`](yjs/disable-yjs-accesslog.sh) — 리버스 프록시 접근 로그에 `?token=`이 남지 않게
  하는 시놀로지 DSM 헬퍼.

### 실행 (Docker)

```bash
cd server/yjs
# 권장: 공간별 HMAC. 길고 무작위인 시크릿을 만들어 서버에 설정합니다.
echo "YJS_SECRET=$(openssl rand -hex 32)" >> .env   # 또는 docker-compose.yml / Container Manager에 설정
docker compose up -d --build
docker compose logs -f          # 기동 로그에 인증 모드 표시: auth: hmac (per-space) | global token | off
```

`http://<host>:1234` 접속 → `Yjs WebSocket server OK` 확인.

### 안전하게 만들기 (실사용 필수)

1. **포트 1234를 직접 노출하지 마세요.** **HTTPS 리버스 프록시(`wss://`)** 뒤에 둡니다(예: 시놀로지 리버스 프록시 +
   Let's Encrypt). WebSocket `Upgrade`/`Connection` 헤더를 전달하도록 구성합니다.
2. **`YJS_SECRET`(환경변수)** 을 설정하고, 플러그인의 *Yjs 공간 시크릿(HMAC)* 에 **같은 값**을 넣습니다. 그러면 교사가
   공간을 배포할 때 공간별 서명 토큰이 학생에게 발급됩니다(토큰이 유출돼도 해당 공간 room만 접근 가능).
3. **토큰을 로그에 남기지 마세요.** 토큰은 `?token=` 쿼리로 전달되므로, 리버스 프록시/CDN/모니터링의 쿼리 로깅을
   마스킹/비활성화합니다(시놀로지 DSM은 [`yjs/disable-yjs-accesslog.sh`](yjs/disable-yjs-accesslog.sh) 참고). 토큰은
   WSS로 전송되어 전송 중에는 노출되지 않으며, 위험은 평문 토큰이 접근 로그에 쌓이는 것입니다.

### 플러그인 설정

설정 → **Yjs 서버 URL**(`wss://…`)과 **Yjs 공간 시크릿(HMAC)**(`YJS_SECRET`과 동일)을 입력하고, 실시간을 켠 뒤 공유
공간을 **배포**합니다. *공간 토큰 만료(일)* 로 발급된 토큰의 유효 기간을 제한할 수 있습니다.

### 호스팅 선택지

[`yjs/`](yjs/) 이미지를 원하는 인프라에 올려 실행하세요:

- CouchDB와 같은 VPS/홈서버/PaaS(포트만 분리), 또는 상시 프로세스 + LevelDB 볼륨이 가능한 다른 어디든.
- ⚠️ **매니지드 Yjs SaaS(PartyKit, Liveblocks, Hocuspocus Cloud, y-sweet)는 그대로 대체되지 않습니다.** 이들은 이
  서버의 공간별 HMAC `?token=` 검증을 구현하지 않으므로, 플러그인의 공간 격리 보안 모델이 적용되지 않습니다. 이 서버를
  그대로 운영하세요(인증 로직을 다른 곳에 이식하는 것은 가능하지만 수동 작업입니다).

**HTTPS/WSS로 노출하기** (시놀로지 리버스 프록시 대안):

- **Caddy** — 도메인만 가리키면 HTTPS가 자동 발급/갱신되고 WebSocket도 기본 지원. 가장 간단한 선택지.
  로그에서 `?token=`을 제거하려면 `log { output discard }`(또는 쿼리 제거 필터)를 사용.
- **Cloudflare Tunnel** 또는 **Tailscale Funnel** — **포트포워딩·고정 IP 없이** 홈서버를 노출.
- **Traefik / nginx** — 여러 서비스를 함께 운영할 때 컨테이너 자동 감지 / 세밀한 제어.
