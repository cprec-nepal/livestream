# ============================================================
# livestream-proctor — self-host starter (Windows PowerShell)
# Opens two windows: the Node server + the cloudflared tunnel.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\selfhost-start.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\selfhost-start.ps1 -TunnelName livestream
#
# Prerequisites (see docs/SELF-HOST-CLOUDFLARE.md):
#   - Node.js working in a fresh window (fnm activated)
#   - cloudflared installed + logged in
#   - tunnel created + DNS routed to your domain
#   - .env filled in (NODE_ENV=production, CORS_ORIGIN=https://…)
# ============================================================
param(
    [string]$TunnelName = "livestream"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot   # project root (parent of scripts\)

# --- 1. Sanity checks ------------------------------------------------
if (-not (Test-Path (Join-Path $Root ".env"))) {
    Write-Error ".env not found in $Root. Copy .env.example to .env and fill it in first."
}

if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
    Write-Error "cloudflared not found. Install it with:  winget install Cloudflare.cloudflared  then reopen PowerShell."
}

# --- 2. Window 1: the Node server ------------------------------------
$serverCmd = "cd '$Root'; " +
             "fnm env --use-on-cd --shell powershell | Out-String | Invoke-Expression; " +
             "Write-Host '── livestream-proctor server ──' -ForegroundColor Cyan; " +
             "npm start"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $serverCmd

# --- 3. Window 2: the cloudflared tunnel ------------------------------
$tunnelCmd = "Write-Host '── cloudflared tunnel: $TunnelName ──' -ForegroundColor Cyan; " +
             "cloudflared tunnel run $TunnelName"
Start-Process powershell -ArgumentList "-NoExit", "-Command", $tunnelCmd

Write-Host ""
Write-Host "Two windows launched:" -ForegroundColor Green
Write-Host "  1. Node server   (http://localhost:3000)"
Write-Host "  2. Tunnel        ($TunnelName -> your domain via Cloudflare)"
Write-Host ""
Write-Host "Check https://<your-domain>/health once both windows are up."
Write-Host "Keep both windows open during class. Close them to stop."
