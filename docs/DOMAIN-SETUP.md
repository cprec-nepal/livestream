# Making https://livestream.cprecnepal.org.np work

This guide covers the whole path: deploy the app → attach the domain →
DNS records → HTTPS. Total time once you have the domain and a free
Render account: **~15 minutes + DNS propagation**.

> The app itself needs **zero code changes** for the domain — it is
> already domain-ready (CORS allowlist, proxy-aware rate limiting,
> platform TLS). Everything below is configuration.

---

## 1. Deploy the app (free, no card)

1. Push this repo to GitHub (`cprec-nepal/livestream`, done).
2. Go to [dashboard.render.com](https://dashboard.render.com) → **New → Blueprint**.
3. Select the `livestream` repo — Render reads `render.yaml`.
4. Fill in the prompted secrets (`sync: false` values):

   | Variable | Value |
   |---|---|
   | `LIVEKIT_URL` | `wss://cprec-livestream-7m74ynh2.livekit.cloud` |
   | `LIVEKIT_API_KEY` | your LiveKit key (**rotated** — the old one leaked) |
   | `LIVEKIT_API_SECRET` | your **new** LiveKit secret |
   | `ADMIN_PASSWORD_HASH` | `node -e "console.log(require('crypto').createHash('sha256').update('NEW-PASSWORD').digest('hex'))"` |
   | `ADMIN_JWT_SECRET` | `openssl rand -hex 32` (or `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `INSTRUCTOR_CODE` | a code you share only with instructors, e.g. `node -e "console.log(require('crypto').randomBytes(4).toString('hex'))"` |
   | `CORS_ORIGIN` | `https://livestream.cprecnepal.org.np` |

5. **Create** → first deploy takes ~2 min. You get a URL like
   `https://livestream-proctor-xxxx.onrender.com` that already works.

> Free plan note: the service sleeps after 15 min idle; the first
> visitor waits ~30 s. Paid plans are optional, not required.

---

## 2. Attach the custom domain on Render

1. In your Render service → **Settings → Custom Domains → Add**.
2. Enter `livestream.cprecnepal.org.np`.
3. Render shows the DNS record to create (a **CNAME** to
   `<service>.onrender.com`) and an verify button — leave this page open.

---

## 3. Create the DNS record at your registrar

`.org.np` domains are typically managed at
[register.com.np](https://register.com.np) / Mercantile or another
registrar — wherever you manage DNS for `cprecnepal.org.np`.

Add **one** record (on the DNS page for `cprecnepal.org.np`):

| Type | Host / Name | Value / Target | TTL |
|---|---|---|---|
| CNAME | `livestream` | `livestream-proctor-xxxx.onrender.com` (from step 2) | 3600 |

If your registrar's DNS panel only supports A records for subdomains
(rare), use Render's shown LB IPs instead (Render displays them when a
CNAME isn't possible).

Wait for propagation (usually minutes; up to a few hours) — check with:

```bash
nslookup livestream.cprecnepal.org.np
```

---

## 4. Verify + go live

1. Back on Render, click **Verify** — the domain attaches and a
   **Let's Encrypt certificate is issued automatically** (free HTTPS,
   usually < 1 min). HTTPS is required for camera/mic — it just works.
2. Open `https://livestream.cprecnepal.org.np/health` → `{"ok":true,…}`.
3. Join a test room from a **phone** — mobile now works over the real
   HTTPS origin.
4. In Render's environment settings, confirm:
   - `CORS_ORIGIN=https://livestream.cprecnepal.org.np`
   - `TRUST_PROXY=true` (already set by `render.yaml`)
   - `NODE_ENV=production`

---

## 5. Alternative: your own VPS (nginx + Let's Encrypt)

If you host on a VPS instead of Render:

```nginx
server {
  listen 443 ssl http2;
  server_name livestream.cprecnepal.org.np;

  ssl_certificate     /etc/letsencrypt/live/livestream.cprecnepal.org.np/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/livestream.cprecnepal.org.np/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;        # WebSocket (socket.io + LiveKit)
    proxy_set_header Connection "upgrade";
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

Issue the certificate:

```bash
sudo certbot --nginx -d livestream.cprecnepal.org.np
```

Run the app with `TRUST_PROXY=true` and
`CORS_ORIGIN=https://livestream.cprecnepal.org.np`, keep it alive with
`pm2 start server.js --name livestream`.

DNS is the same CNAME → your VPS IP (an A record: `livestream` →
`<vps-ip>`).

---

## Troubleshooting

| Symptom | Cause → fix |
|---|---|
| `Verify` fails on Render | DNS not propagated yet — wait, then re-check `nslookup` |
| `ERR_SSL_/` certificate error | Certificate still issuing — wait ~2 min, hard refresh |
| Camera/mic blocked | Page must be HTTPS — confirm the lock icon; use the domain, not an IP |
| Token requests fail with CORS errors | `CORS_ORIGIN` doesn't match the domain exactly (including `https://`) |
| Rate limits block everyone (429) | `TRUST_PROXY` not set behind the proxy — set it to `true` |
| Site sleeps / slow first load | Free plan idle-sleep — normal; upgrade or keep a keep-alive ping |
