# 🎓 Livestream Proctor

A mobile-optimized, WebRTC-based online session platform built on [LiveKit](https://livekit.io/) with lightweight, privacy-respecting proctoring telemetry.

Built for **CPREC Nepal**.

---

## ✨ Features

- **Live video sessions** powered by LiveKit (WebRTC under the hood)
- **Mobile-first graceful degradation** — auto-detects mobile devices and applies lower video constraints (640×480 @ 15fps), defaults to audio-only, and enables `adaptiveStream: true`
- **Lightweight proctoring telemetry**
  - `document.visibilitychange` tracking → tab-switch alerts fired to the admin dashboard in real time
  - Periodic **canvas snapshot hashing** scheduled with `requestIdleCallback` so the main thread is never blocked — only SHA-256 *hashes* are sent, never the raw frames
- **Server-side token issuance** with **capacity limits** enforced *before* a LiveKit token is ever minted
- **Admin dashboard** — live view of active rooms, participant counts, and a streaming alert feed
- **Security hardened** — Helmet headers, CORS allowlist, rate-limited token endpoint, zero client-side secrets
- **Dark, responsive UI** that works flawlessly from 320px phones to 4K desktops

---

## 🏗️ Architecture

```
┌────────────────────┐         ┌──────────────────────────────┐
│  Student Browser   │         │        Admin Browser          │
│  (public/          │         │  (public/admin.html)          │
│   index.html)      │         │                               │
│                    │         │                               │
│  LiveKit JS SDK    │◄────────┤  Socket.io (admin channel)    │
│  + telemetry       │  HTTPS  │                               │
└─────────┬──────────┘  WSS    └───────────────┬───────────────┘
          │                              │
          │  REST: POST /api/token         │  Socket.io
          │  WSS:  LiveKit media stream   │  (telemetry + alerts)
          ▼                              ▼
┌─────────────────────────────────────────────────────────────┐
│                     Node.js / Express                       │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  Helmet  •  CORS  •  Rate Limit                      │    │
│  │  LiveKit AccessToken (server-side) + capacity check   │    │
│  │  Socket.io telemetry ingress + admin broadcast       │    │
│  └─────────────────────────────────────────────────────┘    │
└────────────────────────────────┬────────────────────────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │   LiveKit Server      │
                     │   (media SFU)         │
                     └───────────────────────┘
```

---

## 📁 Project structure

```
livestream/
├── .gitignore
├── .env.example
├── package.json
├── README.md
├── server.js               # Express + Socket.io + LiveKit token generation
└── public/
    ├── index.html          # Student classroom UI
    └── admin.html          # Admin monitoring dashboard
```

---

## 🚀 Quick start

### 1. Prerequisites

- Node.js **18+**
- A running [LiveKit server](https://docs.livekit.io/getting-started/deploy/vm/) (self-hosted or LiveKit Cloud)
- API key + secret from your LiveKit instance

### 2. Install

```bash
git clone https://github.com/cprec-nepal/livestream.git
cd livestream
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env and fill in your real LiveKit credentials
```

| Variable                      | Description                                              | Default                              |
| ----------------------------- | -------------------------------------------------------- | ------------------------------------ |
| `LIVEKIT_API_KEY`             | LiveKit API key                                          | `YOUR_LIVEKIT_API_KEY`               |
| `LIVEKIT_API_SECRET`          | LiveKit API secret                                       | `YOUR_LIVEKIT_API_SECRET`            |
| `LIVEKIT_URL`                 | LiveKit WebSocket URL                                    | `wss://your-livekit-server…`         |
| `PORT`                        | HTTP port for the app server                            | `3000`                               |
| `NODE_ENV`                    | Node environment                                         | `production`                         |
| `CORS_ORIGIN`                | Comma-separated allowed origins, or `*`                | `*`                                  |
| `MAX_PARTICIPANTS_PER_ROOM`  | Hard cap before token issuance is refused               | `50`                                 |
| `TAB_HIDDEN_ALERT_THRESHOLD_MS` | Time a tab can stay hidden before an elevated alert | `10000`                              |
| `SNAPSHOT_INTERVAL_MS`       | Interval between client snapshot-hash reports            | `30000`                              |
| `ADMIN_PASSWORD`             | Password to access `/admin.html` (≥ 12 chars in prod)   | `unset`                              |
| `ADMIN_JWT_SECRET`           | Secret used to sign the `admin_session` JWT cookie (≥ 32 chars in prod) | `change-me-in-production` |
| `ADMIN_COOKIE_TTL_HOURS`     | Admin session cookie TTL in hours                         | `8`                                  |

### 4. Run

```bash
npm start
# or, for hot-reload during development:
npm run dev
```

Then open:

- **Student classroom:** http://localhost:3000/
- **Admin dashboard:** http://localhost:3000/admin.html

---

## 📱 Mobile graceful degradation

The student UI runs a small device probe on load:

```js
const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)
              || Math.min(window.screen.width, window.screen.height) <= 768;
```

Based on the result it picks one of two profiles:

| Profile          | Video resolution | Frame rate | Audio | Default camera | `adaptiveStream` |
| ---------------- | ---------------- | ---------- | ----- | -------------- | ----------------- |
| **Desktop**      | 1280×720         | 30 fps     | on    | on             | `true`            |
| **Mobile**       | 640×480          | 15 fps     | on    | **off (audio-only)** | `true`     |

A "Enable camera" toggle on mobile lets the user opt back into video when bandwidth allows.

---

## 🔭 Proctoring telemetry

Two lightweight signals are streamed from the student's browser to the admin dashboard via Socket.io:

### 1. Tab visibility (`document.visibilitychange`)

Every time the student switches away from the session tab (or back), a `telemetry:visibility` event is sent. If the tab stays hidden longer than `TAB_HIDDEN_ALERT_THRESHOLD_MS`, the server upgrades the alert to **`prolonged_absence`** so admins can act on it.

### 2. Snapshot hashing (`requestIdleCallback` + SHA-256)

On a fixed cadence (default 30s) the student UI draws the current local video frame to a tiny **64×48** offscreen canvas and computes a SHA-256 hash of its pixel buffer. Only the **hash** (64 hex chars) is sent to the server — never the image — so a different hash across consecutive intervals indicates movement / camera coverage without ever exfiltrating a picture.

Crucially, the capture + hash work is scheduled with `requestIdleCallback` (with a 5s timeout fallback), so it **never blocks the main thread** during active WebRTC rendering. A polyfill falls back to `setTimeout` on browsers without `requestIdleCallback`.

---

## 🔐 Security model

- **No client-side secrets.** The student UI never sees the LiveKit API key/secret. It requests a short-lived (2 h) JWT from `POST /api/token`, which the server signs with the secret.
- **Capacity enforced before token issuance.** The server tracks per-room participant counts in memory and refuses to mint a token for students when a room is at `MAX_PARTICIPANTS_PER_ROOM`, returning HTTP 503.
- **Admin authentication (since v1.1).** The admin dashboard at `/admin.html` is protected by a single-password login backed by the `ADMIN_PASSWORD` env var. Successful authentication issues a signed `admin_session` JWT cookie (HttpOnly, Secure in production, SameSite=Strict, 8 h TTL by default). See §"Admin authentication" below.
- **Socket.io auth guard.** Every Socket.io connection is checked for the `admin_session` cookie by `io.use()`. Sockets without a valid cookie can still connect as students (telemetry only) but the `admin:join` event is rejected unless the socket is marked `isAdmin` by the middleware — so a malicious user can't open a console and listen to admin events.
- **Helmet** sets a sane set of HTTP security headers.
- **CORS allowlist** via `CORS_ORIGIN` — set this to your real origins in production.
- **Rate limiting** on `/api/token` (10 requests / minute / IP) prevents token-grinding.
- **Per-socket session binding** — every telemetry event is matched to the authenticated socket session, so a student can't spoof alerts for another identity without first obtaining that identity's token.

---

## 🔑 Admin authentication

Since v1.1 the admin dashboard is password-protected. The flow is:

1. Admin visits `/admin.html` in a browser.
2. The `requireAdmin` middleware checks for a valid `admin_session` cookie. If none (or expired), the browser is redirected to `/admin/login`.
3. The login form is rendered (dark-themed, matches the dashboard). Admin enters the password and submits.
4. The server compares the submitted password against `ADMIN_PASSWORD` using `crypto.timingSafeEqual` (constant-time, defends against timing attacks).
5. On success: a signed JWT cookie is set and the browser is redirected to `/admin.html`.
6. On failure: the login form re-renders with an error message and the failed attempt is logged with the source IP.

### Configuration

Add these to your `.env` (see `.env.example`):

```bash
ADMIN_PASSWORD=replace-with-a-strong-password       # ≥ 12 chars, required in prod
ADMIN_JWT_SECRET=replace-with-a-long-random-secret  # ≥ 32 chars, required in prod
ADMIN_COOKIE_TTL_HOURS=8                            # optional, default 8
```

Generate strong values with:

```bash
openssl rand -hex 16   # → ADMIN_PASSWORD
openssl rand -hex 32   # → ADMIN_JWT_SECRET
```

### Endpoints

| Method | Path              | Purpose                                       |
| ------ | ----------------- | --------------------------------------------- |
| `GET`  | `/admin/login`    | Render the login form                         |
| `POST` | `/admin/login`    | Verify password, set `admin_session` cookie   |
| `POST` | `/admin/logout`   | Clear cookie, redirect to login                |
| `GET`  | `/admin.html`     | Protected — requires valid cookie (else 302)   |
| `GET`  | `/admin/*`        | Protected — requires valid cookie (else 302)   |

### Upgrade path (multi-admin, audit trail)

The single-password approach is appropriate for a single admin or a small team that shares one password. When you need per-administrator accountability:

1. Replace `ADMIN_PASSWORD` with a `users.json` store: `[{ username, passwordHash (bcrypt), displayName, role }]`.
2. Extend the login form to ask for username + password; bcrypt-compare the hash on POST.
3. Include `{ sub: username, name: displayName, role }` in the JWT payload so the admin UI can show who is currently signed in.
4. Append every login attempt (success or failure) to `audit.log` with timestamp + IP + username.

---

## 🛰️ Deployment

This is a stateless-friendly Node app (the only in-memory state is room telemetry, which is fine to lose on restart for a lightweight proctor). Recommended deployment:

1. **LiveKit server** — run LiveKit separately (VM, Docker, or LiveKit Cloud).
2. **App server** — `npm install && npm start` behind a reverse proxy (nginx / Caddy) that terminates TLS and proxies WebSocket upgrades for `/socket.io/`.
3. **Static assets** in `public/` are served by Express — no separate CDN needed for small deployments.

Example systemd unit (excerpt):

```ini
[Service]
WorkingDirectory=/opt/livestream
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/opt/livestream/.env
```

---

## 🧭 Endpoints

| Method | Path              | Purpose                                                |
| ------ | ----------------- | ------------------------------------------------------ |
| `GET`  | `/`               | Student classroom UI (`index.html`)                    |
| `GET`  | `/admin/login`    | Admin login form (no auth required)                    |
| `POST` | `/admin/login`    | Verify password, set `admin_session` cookie            |
| `POST` | `/admin/logout`   | Clear cookie, redirect to `/admin/login`              |
| `GET`  | `/admin.html`     | Admin dashboard UI (requires valid cookie)            |
| `GET`  | `/health`         | Liveness probe — returns `{ ok: true, rooms, uptime }` |
| `POST` | `/api/token`      | Mint a LiveKit access token (rate-limited)             |

### `POST /api/token`

Request body:

```json
{ "roomName": "math-101", "identity": "student-42", "role": "student" }
```

Response 200:

```json
{ "token": "eyJhbGciOi...", "url": "wss://your-livekit-server", "roomName": "math-101", "identity": "student-42" }
```

Response 503 when room is full:

```json
{ "error": "Room is at capacity" }
```

---

## 📜 License

MIT © CPREC Nepal
