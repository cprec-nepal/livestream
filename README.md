# 🎓 Livestream Proctor

A mobile-optimized, WebRTC-based online session platform built on [LiveKit](https://livekit.io/) with lightweight, privacy-respecting proctoring telemetry.

Built for **CPREC Nepal**.

---

## ✨ Features

- **Live video sessions** powered by LiveKit (WebRTC under the hood)
- **Host-controlled screen sharing** — instructors always can share; students only after an instructor/admin grants them (per participant or room-wide), enforced by LiveKit participant permissions *and* token grants — not just hidden buttons
- **Instructor-started sessions** — students can join a room only after the instructor joins it (disable with `REQUIRE_INSTRUCTOR_START=false`); the instructor's in-class strip shows live telemetry, and **End session** disconnects everyone while **Leave** just exits
- **No proctoring UI for students** — the telemetry panel is instructor/admin-only; students see a clean classroom (collection continues silently)
- **Chat everywhere** — collapsible sidebar chat with an unread badge, and the same chat moves into a floating overlay inside fullscreen video with its own open/close
- **Instructor moderation** — mute/unmute and remove (kick) any participant from the admin dashboard or the instructor's own tiles; enforced server-side via LiveKit's Mute/RemoveParticipant APIs
- **Scheduled classes & shareable links** — schedule classes (title, date/time, duration) from the dashboard; every class gets a shareable student link (`/?room=…`) that shows a class card with a **Confirm attendance** button; instructors copy an invite link for live rooms with one click. Schedules persist in `data/classes.json` (gitignored)
- **Accessible & polished** — zoom allowed on mobile, `role="alert"` announcements, visible keyboard focus, WebRTC-unsupported messaging, reconnect banner, preconnect to the signaling host, pinned CSP `connect-src`, 1-year HSTS
- **Code-gated instructor role** — joining as host requires the unique `INSTRUCTOR_CODE` (server-validated with a constant-time comparison); without it configured, instructor joining is disabled (fail closed)
- **Pinned shared screen** — pin any video tile (screen share or camera) as the big stage with a filmstrip below; ⛶ true fullscreen; Esc to unpin. Available to **every participant** — pinning only changes your own view
- **Room chat** — real-time text chat relayed by the server over Socket.io, rate-limited and length-capped, fully visible in the admin monitor
- **Mobile-first graceful degradation** — auto-detects mobile devices and applies lower video constraints (640×480 @ 15fps), defaults to audio-only, and enables `adaptiveStream: true`
- **Insecure-origin warnings + optional HTTPS** — the join screen explains when a browser will block camera/mic (non-HTTPS LAN access), and the server can serve TLS directly via `TLS_CERT`/`TLS_KEY`
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
├── .env.example            # Documented configuration placeholders
├── .gitignore
├── .github/workflows/
│   └── deploy.yml          # CI: install + syntax check + smoke test
├── INSTALL.md              # Setup & GitHub push instructions
├── LICENSE
├── package.json
├── package-lock.json
├── quickstart.sh           # Local dependency/configuration helper
├── render.yaml             # Render deployment blueprint
├── server.js               # Express + Socket.io + LiveKit token generation
├── test.sh                 # Smoke test: /health, admin auth, /api/config
├── public/
│   ├── index.html          # Student classroom UI
│   └── admin.html          # Admin monitoring dashboard
└── docs/
    ├── DEPLOYMENT.md       # Hosting, TLS, and operations guide
    └── RELEASE_CHECKLIST.md
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
npm ci
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
| `NODE_ENV`                    | Node environment                                         | `development`                        |
| `CORS_ORIGIN`                | Comma-separated allowed origins, or `*`                | `*`                                  |
| `MAX_PARTICIPANTS_PER_ROOM`  | Hard cap before token issuance is refused               | `50`                                 |
| `TAB_HIDDEN_ALERT_THRESHOLD_MS` | Time a tab can stay hidden before an elevated alert | `10000`                              |
| `SNAPSHOT_INTERVAL_MS`       | Canvas snapshot-hash cadence (exposed via `/api/config`) | `30000`                              |
| `ADMIN_PASSWORD_HASH`        | SHA-256 hex digest of the admin password (v1.2)          | `unset`                              |
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

Verify the deployment with the smoke test:

```bash
./test.sh
```

### Joining from phones / other devices

Browsers only allow camera/mic + WebRTC on **secure origins** (`https://…` or `localhost`). Opening `http://192.168.x.x:3000` from a phone on your Wi-Fi will be blocked — the join screen shows a clear warning when this happens. Pick one:

1. **HTTPS via the server** — set `TLS_CERT` + `TLS_KEY` to PEM file paths and restart (e.g. certificates from Let's Encrypt). The server then serves `https://` directly.
2. **Quick test tunnel** — `cloudflared tunnel --url http://localhost:3000` prints a temporary `https://…trycloudflare.com` URL phones can join.
3. **Real hosting** — deploy behind a reverse proxy with TLS (Render does this automatically). Planned address: `https://livestream.cprecnepal.org.np` — follow **[docs/DOMAIN-SETUP.md](docs/DOMAIN-SETUP.md)** for the complete step-by-step (deploy → custom domain → DNS → HTTPS).
4. **Host from your own PC** (no Render, no VPS) — **[docs/SELF-HOST-CLOUDFLARE.md](docs/SELF-HOST-CLOUDFLARE.md)** walks through Cloudflare Tunnel on Windows: your computer serves the domain with automatic HTTPS, no open ports. Includes `scripts/selfhost-start.ps1` to launch server + tunnel together.

See **[INSTALL.md](INSTALL.md)** for full setup + GitHub push instructions.

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
- **Admin authentication (v1.2).** The admin dashboard at `/admin.html` is protected by a single-password login backed by the `ADMIN_PASSWORD_HASH` env var (SHA-256 digest of the password — the plaintext is never stored). The server hashes each submitted password and compares digests with `crypto.timingSafeEqual`. Successful authentication issues a signed `admin_session` JWT cookie (HttpOnly, Secure in production, SameSite=Strict, 8 h TTL by default). See §"Admin authentication" below.
- **Socket.io auth guard.** Every Socket.io connection is checked for the `admin_session` cookie by `io.use()`. Sockets without a valid cookie can still connect as students (telemetry only) but the `admin:join` event is rejected unless the socket is marked `isAdmin` by the middleware — so a malicious user can't open a console and listen to admin events.
- **Helmet** sets a sane set of HTTP security headers (CSP allows `https://cdn.jsdelivr.net` + `wss:`/`https:`; no `eval()`).
- **CORS allowlist** via `CORS_ORIGIN` — set this to your real origins in production.
- **Rate limiting** on `/api/token` (10 requests / minute / IP) prevents token-grinding, and on `/admin/login` (5 attempts / minute / IP) prevents password brute-force.
- **Per-socket session binding** — every telemetry event is matched to the authenticated socket session, so a student can't spoof alerts for another identity without first obtaining that identity's token.

---

## 🔑 Admin authentication

Since v1.2 the admin dashboard is password-protected with a **hashed** password. The flow is:

1. Admin visits `/admin.html` in a browser.
2. The `requireAdmin` middleware checks for a valid `admin_session` cookie. If none (or expired), the browser is redirected to `/admin/login`.
3. The login form is rendered (dark-themed, matches the dashboard). Admin enters the password and submits.
4. The server computes `SHA-256(submitted)` and compares the digest against `ADMIN_PASSWORD_HASH` using `crypto.timingSafeEqual` (constant-time, defends against timing attacks).
5. On success: a signed JWT cookie is set and the browser is redirected to `/admin.html`.
6. On failure: the login form re-renders with an error message and the failed attempt is logged with the source IP. After 5 attempts/minute/IP, further attempts are throttled.

### Configuration

Add these to your `.env` (see `.env.example`):

```bash
ADMIN_PASSWORD_HASH=<64-char hex SHA-256 digest>    # required in prod
ADMIN_JWT_SECRET=replace-with-a-long-random-secret  # ≥ 32 chars, required in prod
ADMIN_COOKIE_TTL_HOURS=8                            # optional, default 8
```

Generate the values with:

```bash
echo -n "your-strong-password" | sha256sum   # → ADMIN_PASSWORD_HASH
openssl rand -hex 32                         # → ADMIN_JWT_SECRET
```

> **Migrating from v1.1:** deployments still using the plaintext `ADMIN_PASSWORD` variable keep working (it is hashed once at startup), but a deprecation warning is logged. Migrate to `ADMIN_PASSWORD_HASH` and remove `ADMIN_PASSWORD` from your environment.

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

1. Replace `ADMIN_PASSWORD_HASH` with a `users.json` store: `[{ username, passwordHash (bcrypt), displayName, role }]`.
2. Extend the login form to ask for username + password; bcrypt-compare the hash on POST.
3. Include `{ sub: username, name: displayName, role }` in the JWT payload so the admin UI can show who is currently signed in.
4. Append every login attempt (success or failure) to `audit.log` with timestamp + IP + username.

---

## 🛰️ Deployment

Use a persistent Node.js host with WebSocket support, plus LiveKit Cloud or a separate LiveKit server. Static-only hosting is not sufficient.

The included `render.yaml` provides a Render blueprint with reproducible installs, a production start command, and a `/health` check. Railway, a VM, and similar Node hosts can also run the app.

1. Copy `.env.example` values into your host's environment/secret settings.
2. Set `NODE_ENV=production` and replace every LiveKit and admin placeholder.
3. Set `CORS_ORIGIN` to the exact public HTTPS origin.
4. Deploy with `npm ci && npm start`, then verify `/health` and test real audio/video between two browsers.

See the complete **[deployment guide](docs/DEPLOYMENT.md)**, **[domain setup](docs/DOMAIN-SETUP.md)**, **[self-hosting via Cloudflare Tunnel](docs/SELF-HOST-CLOUDFLARE.md)**, and **[release checklist](docs/RELEASE_CHECKLIST.md)**.

> **Before real classes or assessments:** add student authentication or signed invitations and server-side room authorization. Start with one application instance because room counts and telemetry are stored in memory. Review privacy and consent requirements before enabling proctoring telemetry.

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
| `GET`  | `/api/config`     | Public client config (`snapshotIntervalMs`, thresholds) |
| `POST` | `/api/token`      | Mint a LiveKit access token (rate-limited + capacity check) |

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

Released under the [MIT License](LICENSE) © CPREC Nepal.
