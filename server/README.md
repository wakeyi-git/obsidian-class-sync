# Class Sync — server setup

> 🌐 **한국어**: [`README.ko.md`](README.ko.md)

Class Sync needs **two independent servers**: **CouchDB** (file sync, required) and a **Yjs WebSocket server**
(realtime co-editing, optional). They **never talk to each other** — the plugin is the only client of both — so they
don't need to share a host or a network. This folder documents both and ships the Yjs server's runtime files under
[`yjs/`](yjs/).

## Architecture & constraints

The plugin talks to two independent endpoints and is the only thing that bridges them:

```
            ┌──────────────── CouchDB   (PouchDB HTTP/HTTPS replication)
plugin      │
(teacher/   ├──────────────── Yjs server (WebSocket / WSS)
 students)  │
            └─ realtime snapshots are written by the plugin → CouchDB
```

- **The Yjs server never connects to CouchDB.** It only uses `ws`/`y-websocket` + HMAC, and persists locally to
  LevelDB. Realtime edits reach CouchDB only because the *plugin* periodically snapshots the live doc back through the
  sync layer — not via any server-to-server link.
- So **CouchDB and the Yjs server have no co-location requirement**: different hosts, providers, or regions are fine.
  Bundling them on one box is purely an operational convenience (one machine, one reverse proxy).
- The real constraints are **reachability** (every client must reach both over the internet — neither can sit on a
  LAN-only address if remote students need it), **HTTPS/WSS** (Obsidian mobile requires secure transport), and
  **`YJS_SECRET` parity** between the Yjs server and the plugin setting.

---

## CouchDB (required)

The central server. Synology NAS Docker example:

```bash
docker run -d --name couchdb -p 5984:5984 \
  -e COUCHDB_USER=admin -e COUCHDB_PASSWORD='****' couchdb:3
```

1. **HTTPS recommended** (e.g. Synology reverse proxy + Let's Encrypt).
2. **No manual schema work.** Student accounts, mirror DBs, and permissions are auto-created by the teacher from the
   plugin (Teacher Mode provisions `_users` accounts + `mirror_*` DBs + `_security` with the admin account).
3. **CORS is optional.** The plugin bypasses CORS via Obsidian's `requestUrl`, so it works without it; enable it only
   for browser tools like Fauxton. Obsidian origins: `app://obsidian.md` (desktop) · `capacitor://localhost` (iOS) ·
   `http://localhost` (Android).

### Hosting options

CouchDB is standard software — the plugin just needs an HTTPS URL + admin account. Pick by what you already have:

- **Other hardware + Docker** — another NAS (QNAP, etc.), a Raspberry Pi 4/5, a mini-PC, or any Linux box: `couchdb:3`.
- **Cloud VPS + Docker** — Hetzner / DigitalOcean / Vultr / Linode / AWS Lightsail / Oracle Cloud Always-Free. Best for
  multi-site or no static home IP.
- **PaaS (one-click container)** — Railway / Render / Fly.io with a **persistent volume** for the data dir.
- **Managed** — IBM Cloudant (CouchDB-compatible, zero server management; minor API/pricing differences).

---

## Yjs realtime server (optional)

Only for **realtime co-editing** — independent of CouchDB file sync; skip it if you only need file sync. The runtime
files live in [`yjs/`](yjs/):

- [`yjs/server.js`](yjs/server.js) — y-websocket server with two auth modes (per-space HMAC `YJS_SECRET`, or legacy
  global `YJS_TOKEN`).
- [`yjs/Dockerfile`](yjs/Dockerfile) / [`yjs/docker-compose.yml`](yjs/docker-compose.yml) /
  [`yjs/package.json`](yjs/package.json) — container build + run (LevelDB persistence in `./data`).
- [`yjs/disable-yjs-accesslog.sh`](yjs/disable-yjs-accesslog.sh) — Synology DSM helper to keep `?token=` out of
  reverse-proxy access logs.

### Run (Docker)

```bash
cd server/yjs
# Recommended: per-space HMAC. Generate a long random secret and set it on the server.
echo "YJS_SECRET=$(openssl rand -hex 32)" >> .env   # or set it in docker-compose.yml / Container Manager
docker compose up -d --build
docker compose logs -f          # startup line shows: auth: hmac (per-space) | global token | off
```

Check `http://<host>:1234` → `Yjs WebSocket server OK`.

### Make it safe (required for real use)

1. **Never expose port 1234 directly.** Put it behind an **HTTPS reverse proxy (`wss://`)** (e.g. Synology reverse
   proxy + Let's Encrypt). Forward the WebSocket `Upgrade`/`Connection` headers.
2. **Set `YJS_SECRET`** (env var) and the **same value** in the plugin's *Yjs space secret (HMAC)*. The teacher then
   deploys spaces, which issue per-space signed tokens to students (a leaked token only grants that space's room).
3. **Keep tokens out of logs.** The token travels as a `?token=` query, so mask/disable query logging on the reverse
   proxy/CDN/monitoring (see [`yjs/disable-yjs-accesslog.sh`](yjs/disable-yjs-accesslog.sh) for Synology DSM). Tokens
   travel over WSS, so they aren't exposed in transit — the risk is plaintext tokens piling up in access logs.

### In the plugin

Settings → enter the **Yjs server URL** (`wss://…`) and **Yjs space secret (HMAC)** (same as `YJS_SECRET`), enable
realtime, and **deploy** a shared space. Set *Space token expiry (days)* to bound how long issued tokens stay valid.

### Hosting options

Run the [`yjs/`](yjs/) image on the infrastructure of your choice:

- Same VPS/home server/PaaS as CouchDB (separate port), or anywhere else with a persistent process + LevelDB volume.
- ⚠️ **Managed Yjs SaaS (PartyKit, Liveblocks, Hocuspocus Cloud, y-sweet) is not a drop-in.** They don't implement this
  server's per-space HMAC `?token=` verification, so the plugin's space-isolation security model wouldn't apply. Stick
  to running this server (porting the auth elsewhere is possible but manual).

**Exposing it over HTTPS/WSS** (alternatives to the Synology reverse proxy):

- **Caddy** — point a domain at it and HTTPS is auto-issued/renewed; WebSocket works out of the box. Simplest option.
  Drop `?token=` from logs with `log { output discard }` (or a query-stripping filter).
- **Cloudflare Tunnel** or **Tailscale Funnel** — expose a home server **without port-forwarding or a static IP**.
- **Traefik / nginx** — container auto-discovery / fine-grained control when running several services.
