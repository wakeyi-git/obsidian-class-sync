# Class Sync — Yjs realtime server

A small **Yjs WebSocket server** for Class Sync's optional realtime co-editing. File sync runs on CouchDB and works
without this; run this only if you want character-level realtime editing of shared-folder notes (and Excalidraw).

Files here:
- `server.js` — y-websocket server with two auth modes (per-space HMAC `YJS_SECRET`, or legacy global `YJS_TOKEN`).
- `Dockerfile` / `docker-compose.yml` / `package.json` — container build + run (LevelDB persistence in `./data`).
- `disable-yjs-accesslog.sh` — Synology DSM helper to keep `?token=` out of reverse-proxy access logs.

## Run (Docker)

```bash
cd server
# Recommended: per-space HMAC. Generate a long random secret and set it on the server.
echo "YJS_SECRET=$(openssl rand -hex 32)" >> .env   # or set it in docker-compose.yml / Container Manager
docker compose up -d --build
docker compose logs -f          # startup line shows: auth: hmac (per-space) | global token | off
```

Check `http://<host>:1234` → `Yjs WebSocket server OK`.

## Make it safe (required for real use)

1. **Never expose port 1234 directly.** Put it behind an **HTTPS reverse proxy (`wss://`)** (e.g. Synology reverse
   proxy + Let's Encrypt). Forward the WebSocket `Upgrade`/`Connection` headers.
2. **Set `YJS_SECRET`** (env var) and the **same value** in the plugin's *Yjs space secret (HMAC)*. The teacher then
   deploys spaces, which issue per-space signed tokens to students (a leaked token only grants that space's room).
3. **Keep tokens out of logs.** The token travels as a `?token=` query, so mask/disable query logging on the reverse
   proxy/CDN/monitoring (see `disable-yjs-accesslog.sh` for Synology DSM). Tokens travel over WSS, so they aren't
   exposed in transit — the risk is plaintext tokens piling up in access logs.

## In the plugin

Settings → enter the **Yjs server URL** (`wss://…`) and **Yjs space secret (HMAC)** (same as `YJS_SECRET`), enable
realtime, and **deploy** a shared space. Set *Space token expiry (days)* to bound how long issued tokens stay valid.
