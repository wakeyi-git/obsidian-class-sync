const http = require("http");
const WebSocket = require("ws");
const { setupWSConnection } = require("y-websocket/bin/utils");

const host = process.env.HOST || "0.0.0.0";
const port = parseInt(process.env.PORT || "1234", 10);
const token = process.env.YJS_TOKEN || ""; // 값이 있으면 토큰 인증 활성화

// 헬스체크용 HTTP 응답(리버스 프록시/모니터링 확인용)
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Yjs WebSocket server OK");
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (conn, req) => {
  // 토큰 인증: YJS_TOKEN이 설정돼 있으면 ?token=... 이 일치해야 한다.
  // (room 이름은 URL 경로에서 파싱되고 query는 무시되므로 token 추가는 room에 영향 없음)
  if (token) {
    let provided = null;
    try {
      provided = new URL(req.url, "http://localhost").searchParams.get("token");
    } catch {
      /* URL 파싱 실패 → 거부 */
    }
    if (provided !== token) {
      conn.close(4001, "unauthorized");
      return;
    }
  }
  setupWSConnection(conn, req);
});

server.listen(port, host, () => {
  console.log(`Yjs WebSocket server listening on ws://${host}:${port} (auth: ${token ? "on" : "off"})`);
});
