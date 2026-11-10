# Deployment guide

Livestream Proctor has two deployable parts:

1. **This Node.js application**, which serves the UI, issues LiveKit tokens, and handles Socket.IO telemetry.
2. **LiveKit**, which carries audio and video. Use LiveKit Cloud or operate a separate LiveKit server.

The application requires a persistent Node.js process and WebSocket support. Static-only hosting is not sufficient. Start with one application instance because participant counts and telemetry currently live in process memory.

## Before production

This repository is suitable for a hosted demo or controlled pilot after deployment testing. Before private classes or high-stakes assessments, add student authentication or signed invitations and server-side room authorization. Browser-supplied room names and identities are not an enrollment system.

Review the complete [release checklist](RELEASE_CHECKLIST.md), including privacy and consent requirements.

## Option A: Render blueprint

The included `render.yaml` defines a Node web service with a `/health` check.

### 1. Prepare LiveKit

Create a LiveKit Cloud project or use an existing self-hosted deployment. Keep its API key and secret in the hosting provider's secret settings, never in Git.

The LiveKit URL must use secure WebSockets in production:

```text
wss://your-project.livekit.cloud
```

### 2. Create the web service

In Render, create a **Blueprint Instance** from this repository. Render will detect `render.yaml` and prompt for values marked `sync: false`.

Generate admin secrets locally:

```bash
echo -n "your-strong-password" | sha256sum  # ADMIN_PASSWORD_HASH
openssl rand -hex 32                         # ADMIN_JWT_SECRET
```

Configure:

| Variable | Production value |
| --- | --- |
| `LIVEKIT_URL` | Your LiveKit `wss://` URL |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `ADMIN_PASSWORD_HASH` | SHA-256 hex digest of a unique password (≥ 12 chars) |
| `ADMIN_JWT_SECRET` | Unique generated secret, at least 32 characters |
| `CORS_ORIGIN` | Exact app origin, such as `https://sessions.example.org` |

The blueprint sets `NODE_ENV=production`, runs `npm ci`, starts the app with `npm start`, and checks `/health`. Render supplies `PORT`; do not override it.

If you create a Web Service manually instead, use:

```text
Build command: npm ci
Start command: npm start
Health check path: /health
```

### 3. Verify the deployment

After the service starts:

```bash
curl --fail https://your-app-domain/health
```

Confirm the response contains `"ok":true`, then test the student page and admin login. Complete a real two-browser LiveKit audio/video test before announcing the URL.

### 4. Add a custom domain

Point your DNS records to Render using the values shown in its dashboard. After HTTPS is active, set `CORS_ORIGIN` to the exact public origin with no path or trailing slash, then redeploy.

Camera and microphone access require a secure browser context in production. Both the application and LiveKit should use HTTPS/WSS.

## Option B: Another Node.js host

Railway, a VM, or another persistent Node host can run the same application with:

```bash
npm ci
npm start
```

Requirements:

- Node.js 18 or newer
- A host-assigned `PORT`, or port `3000` by default
- Long-lived connections and WebSocket upgrades for `/socket.io/`
- HTTPS at the public entry point
- `/health` configured for liveness checks
- Environment variables from `.env.example`, with production secrets stored outside Git
- One application instance unless in-memory state is moved to shared storage such as Redis

Do not use a serverless function or static-only host for this server in its current form.

## Option C: VM with Caddy

Install the application under a dedicated service account, copy `.env.example` to `.env`, and replace every placeholder. Install dependencies with `npm ci`.

A minimal systemd service:

```ini
[Unit]
Description=Livestream Proctor
After=network.target

[Service]
Type=simple
User=livestream
WorkingDirectory=/opt/livestream
EnvironmentFile=/opt/livestream/.env
ExecStart=/usr/bin/node /opt/livestream/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now livestream
sudo systemctl status livestream
```

Caddy can terminate HTTPS and proxy both HTTP and WebSocket traffic:

```caddyfile
sessions.example.org {
    reverse_proxy 127.0.0.1:3000
}
```

Restrict direct public access to port 3000 so traffic passes through Caddy. Set `CORS_ORIGIN=https://sessions.example.org` and test proxy/client-IP behavior before relying on rate limits.

## Operational notes

- **State is ephemeral:** room membership and alert history are lost on restart. Keep one replica for the initial release.
- **LiveKit is separate:** an application health check does not prove media connectivity. Always perform an end-to-end media test.
- **Logs:** monitor application logs and hosting health checks; avoid logging secrets or LiveKit tokens.
- **Updates:** redeploy with `npm ci`, then repeat health, login, and media smoke tests.
- **Rollback:** retain the previous release and roll back through the hosting provider if health or media tests fail.

Continue with the [release checklist](RELEASE_CHECKLIST.md) before tagging and announcing the release.
