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

## 3. Create the DNS record — Cloudflare

Since `cprecnepal.org.np` uses Cloudflare for DNS, the record is created
in the **Cloudflare dashboard**, not at the registrar:

1. [dash.cloudflare.com](https://dash.cloudflare.com) → select **`cprecnepal.org.np`** → **DNS → Records → Add record**:

   | Field | Value |
   |---|---|
   | Type | `CNAME` |
   | Name | `livestream` |
   | Target | `livestream-proctor-xxxx.onrender.com` (from step 2) |
   | Proxy status | **DNS only** (grey cloud) — see note below |
   | TTL | Auto |

2. **Proxy status (orange vs grey cloud):**
   - Start with **DNS only (grey cloud)**. Render then issues its own
     Let's Encrypt certificate directly — simplest, zero surprises.
   - Once it works, you may switch to **Proxied (orange cloud)** for
     Cloudflare's CDN/DDoS protection. If you do, set **SSL/TLS →
     Overview → Full (strict)** (Cloudflare talks HTTPS to Render's
     cert). WebSockets (needed for LiveKit + Socket.io) are supported
     by default — verify **Network → WebSockets** is ON.
   - Recommended extra when proxied: **SSL/TLS → Edge Certificates →
     Always Use HTTPS: ON**.

3. Check propagation:

```bash
nslookup livestream.cprecnepal.org.np
```

> `.org.np` domains registered at register.com.np/Mercantile delegate
> to Cloudflare by pointing the registrar's nameserver entries at the
> two `*.ns.cloudflare.com` values Cloudflare shows when adding the
> site. If the site is already active on Cloudflare, skip that — just
> add the record above.

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

## 5. Alternative: your own VPS + Cloudflare Tunnel (no open ports)

If you host on a VPS (or even your office PC), **Cloudflare Tunnel**
exposes it without opening ports or buying certificates:

```bash
# one-time: install and authenticate (opens a browser link)
cloudflared tunnel login
cloudflared tunnel create livestream
cloudflared tunnel route dns livestream livestream.cprecnepal.org.np
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: livestream
credentials-file: /home/YOU/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: livestream.cprecnepal.org.np
    service: http://localhost:3000
  - service: http_status:404
```

Run the app (`TRUST_PROXY=true`,
`CORS_ORIGIN=https://livestream.cprecnepal.org.np`) and keep both alive:

```bash
pm2 start server.js --name livestream
pm2 start "cloudflared tunnel run livestream" --name tunnel
```

Cloudflare terminates HTTPS at its edge; the app needs no cert at all.
WebSockets work by default through the tunnel.

## 5b. Alternative: plain VPS with nginx + Let's Encrypt

If you prefer a classic setup on a VPS:

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
| Works direct, fails through orange cloud | SSL mode not Full (strict) → SSL/TLS → Overview → **Full (strict)** |
| Socket.io/LiveKit drop behind Cloudflare | WebSockets off → **Network → WebSockets: ON** |
| Redirect loop through Cloudflare | Avoid "Flexible SSL"; use Full (strict) — or grey cloud while testing |
| `Verify` fails on Render | DNS not propagated yet — wait, then re-check `nslookup` |
| `ERR_SSL_/` certificate error | Certificate still issuing — wait ~2 min, hard refresh |
| Camera/mic blocked | Page must be HTTPS — confirm the lock icon; use the domain, not an IP |
| Token requests fail with CORS errors | `CORS_ORIGIN` doesn't match the domain exactly (including `https://`) |
| Rate limits block everyone (429) | `TRUST_PROXY` not set behind the proxy — set it to `true` |
| Site sleeps / slow first load | Free plan idle-sleep — normal; upgrade or keep a keep-alive ping |
