# 📦 Install & GitHub setup — Livestream Proctor

This guide covers local setup, environment configuration, verification,
and pushing the project to GitHub.

---

## 1. Prerequisites

- **Node.js 18+** (`node --version`)
- A running **LiveKit server** (LiveKit Cloud or self-hosted) with an API key + secret
- `git` (for the GitHub steps in §5)

---

## 2. Clone & install

```bash
git clone https://github.com/cprec-nepal/livestream.git
cd livestream
npm ci
```

Or use the helper script (installs deps + creates `.env`):

```bash
./quickstart.sh
```

---

## 3. Configure `.env`

```bash
cp .env.example .env
```

Open `.env` and fill in real values:

| Variable | What to put |
| --- | --- |
| `LIVEKIT_URL` | Your LiveKit `wss://` URL, e.g. `wss://your-project.livekit.cloud` |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `ADMIN_PASSWORD_HASH` | SHA-256 hex digest of the admin password (see below) |
| `ADMIN_JWT_SECRET` | Random secret, ≥ 32 chars: `openssl rand -hex 32` |
| `INSTRUCTOR_CODE` | Unique code instructors must enter to join as host. Empty = instructor joining disabled |
| `REQUIRE_INSTRUCTOR_START` | `true` (default): students wait until the instructor joins. `false` = open joining |
| `CORS_ORIGIN` | `*` for local dev; exact HTTPS origin in production |

Generate the admin password hash (use a password of ≥ 12 characters):

```bash
echo -n "your-strong-password" | sha256sum
# → paste the 64-char hex digest into ADMIN_PASSWORD_HASH
```

> The plaintext password is **never** stored — the server hashes each
> submitted password and compares digests with `crypto.timingSafeEqual`.

---

## 4. Run & verify

```bash
npm start
# hot-reload during development:
npm run dev
```

Open:

- **Student UI:** http://localhost:3000/
- **Admin login:** http://localhost:3000/admin/login
- **Health:** http://localhost:3000/health

Run the automated smoke test (starts a throwaway server on port 3100):

```bash
./test.sh
```

It verifies:

1. `GET /health` returns `200` with `{ "ok": true }`
2. `GET /admin.html` redirects to `/admin/login` without a cookie
3. `POST /admin/login` accepts the correct password (hashed) and sets the cookie
4. Wrong passwords are rejected; `GET /api/config` exposes telemetry settings

---

## 5. Push to GitHub

### 5a. Existing repo (this project)

```bash
git add .
git commit -m "Initial commit"
git push -u origin main
```

### 5b. Brand-new repo from scratch

```bash
# 1. Initialize git (skip if the repo already exists)
git init

# 2. Add the GitHub remote (replace <USER> and <REPO>)
git remote add origin https://github.com/<USER>/<REPO>.git

# 3. Stage, commit, and push
git add .
git commit -m "Initial commit"
git push -u origin main
```

> If the branch is named `master` instead of `main`, rename it first:
> `git branch -M main`

### 5c. Verify the push

```bash
git status
git log --oneline -3
```

Then open `https://github.com/<USER>/<REPO>` in your browser to confirm
the files are on GitHub. GitHub Actions will run the CI workflow
(`.github/workflows/deploy.yml`) on every push.

---

## 6. Deploy (Render)

The repo ships a `render.yaml` blueprint. In Render, create a
**Blueprint Instance** from this repository and supply the
`sync: false` values (`LIVEKIT_*`, `ADMIN_PASSWORD_HASH`,
`ADMIN_JWT_SECRET`, `CORS_ORIGIN`) in the dashboard. Render runs
`npm ci`, starts with `npm start`, and health-checks `/health`.

See `docs/DEPLOYMENT.md` for VM/Caddy and other hosting options.

---

## 7. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `FATAL] LIVEKIT_API_KEY … still placeholders` | Fill in real LiveKit credentials in `.env` |
| `FATAL] ADMIN_PASSWORD_HASH is not set` | Generate + set the SHA-256 hash (see §3) |
| `FATAL] ADMIN_PASSWORD_HASH must be a 64-char hex…` | Paste only the hex digest, no quotes/spaces |
| Admin login always fails | Check the hash was generated from the exact password (`echo -n`, no trailing newline) |
| `Room is at capacity` (503) | Room hit `MAX_PARTICIPANTS_PER_ROOM`; instructors bypass the cap |
| Camera/mic blocked | Serve over HTTPS (or `localhost`) — required by browsers |
