# Self-hosting on your own PC via Cloudflare Tunnel (Windows)

Host `https://livestream.cprecnepal.org.np` **directly from your
computer** — no Render, no VPS, no port forwarding, no certificates to
buy. A small Cloudflare agent (`cloudflared`) runs on your PC and makes
an **outbound** connection to Cloudflare's edge; visitors reach your
machine through it with automatic HTTPS.

```
student browser ──> Cloudflare edge (HTTPS, your domain)
                          │
                          └── cloudflared tunnel (outbound from your PC)
                                    │
                                    └── node server.js (localhost:3000)
```

**Honest requirements before you start:**

| Requirement | Why |
|---|---|
| Your PC stays **on and awake** during class hours | When it sleeps or shuts down, the site goes offline |
| It needs **outbound internet** | Tunnel + LiveKit connection; students' video flows via LiveKit Cloud directly, so your upload only carries your own streams + chat/telemetry (light) |
| Domain's DNS on **Cloudflare** (free plan is fine) | The tunnel route is created as a CNAME in your Cloudflare zone |
| Windows 10/11 with admin PowerShell once | To install cloudflared as an auto-start service |

Media notes: students connect to LiveKit Cloud (`wss://…livekit.cloud`)
directly for audio/video. Your PC only serves the web app, chat relay,
tokens, and admin dashboard — a laptop handles dozens of participants
fine.

---

## 0. One-time prerequisites

```powershell
# 1. Node.js already working (fnm activated) — check:
node -v

# 2. Install the Cloudflare agent:
winget install Cloudflare.cloudflared
# close & reopen PowerShell so PATH refreshes, then:
cloudflared --version

# 3. Your app runs locally with a filled .env (see INSTALL.md) and
#    these two lines added for domain serving:
#      NODE_ENV=production
#      CORS_ORIGIN=https://livestream.cprecnepal.org.np
#      TRUST_PROXY=true
```

> If your domain's DNS is **not yet on Cloudflare**: dash.cloudflare.com
> → **Add a site** → `cprecnepal.org.np` (Free plan) → Cloudflare shows
> two nameservers → set them at your registrar (register.com.np /
> Mercantile panel) → wait for activation. Skip if already active.

---

## 1. One-minute test (temporary URL, no account)

```powershell
cd $HOME\Downloads\livestream-v144\livestream-main   # project folder
npm start          # window 1: keep running

# window 2:
cloudflared tunnel --url http://localhost:3000
```

It prints a random `https://<random>.trycloudflare.com` URL — open it on
your phone: the app works fully (HTTPS, camera/mic OK). **This URL
changes every run** — it's just a smoke test. The real domain is next.

---

## 2. Named tunnel on your real domain (one-time, ~5 minutes)

Run these in a normal PowerShell window. Step 2.1 opens a browser to
log in to Cloudflare and authorize the certificate.

```powershell
# 2.1 Log in (browser opens — pick cprecnepal.org.np)
cloudflared tunnel login

# 2.2 Create the tunnel (prints an ID + credentials file path)
cloudflared tunnel create livestream

# 2.3 Route your domain to the tunnel — this CREATES the DNS record
#     in your Cloudflare zone automatically (CNAME -> <tunnel-id>.cfargotunnel.com)
cloudflared tunnel route dns livestream livestream.cprecnepal.org.np
```

## 3. Tunnel configuration file

Create `C:\Users\<YOU>\.cloudflared\config.yml` (Notepad):

```yaml
tunnel: livestream
credentials-file: C:\Users\<YOU>\.cloudflared\<TUNNEL-ID>.json
ingress:
  - hostname: livestream.cprecnepal.org.np
    service: http://localhost:3000
  - service: http_status:404
```

- Replace `<YOU>` and `<TUNNEL-ID>` (from step 2.2's output; the
  credentials file is in the same folder).
- Test it right now: `cloudflared tunnel run livestream` — then open
  `https://livestream.cprecnepal.org.np/health` → `{"ok":true,…}` 🎉

## 4. Make it auto-start (so classes survive reboots)

Open PowerShell **as Administrator**:

```powershell
# Install cloudflared as a Windows service (starts on boot, auto-restarts)
cloudflared service install --config "C:\Users\<YOU>\.cloudflared\config.yml"
Start-Service cloudflared
Get-Service cloudflared   # should say Running
```

For the Node app, use the provided starter (or a Task Scheduler job):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\selfhost-start.ps1
```

Optional hardening for a daily-driver classroom PC:
- **Settings → System → Power**: Screen off is fine, but **Sleep: Never**
  while plugged in (a sleeping PC = offline site)
- Run `npm start` via Task Scheduler "At startup", or just launch
  `selfhost-start.ps1` each morning

## 5. Final `.env` for domain serving

```ini
NODE_ENV=production
PORT=3000
TRUST_PROXY=true
CORS_ORIGIN=https://livestream.cprecnepal.org.np
LIVEKIT_URL=wss://cprec-livestream-7m74ynh2.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...        # rotated!
ADMIN_PASSWORD_HASH=...
ADMIN_JWT_SECRET=...
INSTRUCTOR_CODE=...
```

`TRUST_PROXY=true` makes rate limiting see real visitor IPs (cloudflared
forwards `X-Forwarded-For`). Restart with `npm start` after edits.

## 6. Updating the app later

```powershell
cd $HOME\Downloads
curl.exe -L -o livestream.zip https://github.com/cprec-nepal/livestream/archive/refs/heads/main.zip
Expand-Archive livestream.zip -DestinationPath livestream-new -Force
cd livestream-new\livestream-main
copy "$HOME\Downloads\<previous-folder>\.env" .
npm ci
```

The tunnel config never changes — it just keeps pointing at
`localhost:3000`.

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `service install` complains about config | Run PowerShell **as Administrator**; pass `--config "C:\…\config.yml"` as shown |
| Domain shows Cloudflare error 1033 | Tunnel not running — `Start-Service cloudflared`, check `Get-Service cloudflared` |
| Works on PC, not on phone | You opened `localhost` — use the domain; phone joins are the point of the tunnel |
| 429 Too Many Requests | `TRUST_PROXY=true` missing in `.env` — without it all visitors share one rate-limit bucket |
| Camera/mic blocked | Page must be the HTTPS domain (lock icon), not an IP or `localhost` from the phone |
| Admin login loops back to login | Cookie requires HTTPS — you're on the domain, right? If testing locally use `http://localhost:3000` |
| Site dies at night | PC slept or rebooted and `npm start` wasn't running — see §4 |
