#!/usr/bin/env bash
# ============================================================
# livestream-proctor — quick start script
# Run this from a local clone after installing Node.js 18+.
# ============================================================
set -e

cd "$(dirname "$0")"

echo "▶ 1. Installing dependencies ..."
npm ci --no-audit --no-fund

echo ""
echo "▶ 2. Creating .env from .env.example ..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "   ✓ .env created"
  echo ""
  echo "   ⚠  Open .env in your editor and fill in:"
  echo "      - LIVEKIT_API_KEY"
  echo "      - LIVEKIT_API_SECRET"
  echo "      - LIVEKIT_URL"
  echo "      - ADMIN_PASSWORD_HASH  (SHA-256 of your admin password)"
  echo "      - ADMIN_JWT_SECRET     (≥ 32 chars;  e.g. openssl rand -hex 32)"
  echo ""
  echo "   Generate the admin password hash with:"
  echo "      echo -n \"your-strong-password\" | sha256sum"
  echo ""
  echo "   Then run:  npm start"
else
  echo "   ✓ .env already exists"
fi

echo ""
echo "▶ 3. Smoke-test (skipped — run 'npm start' when ready)"
echo ""
echo "   Student UI:    http://localhost:3000/"
echo "   Admin login:   http://localhost:3000/admin/login"
echo "   Admin UI:      http://localhost:3000/admin.html  (after login)"
echo "   Health check:  http://localhost:3000/health"
echo "   Verify all:    ./test.sh"
echo ""
echo "Done. Edit .env, then run:  npm start"
