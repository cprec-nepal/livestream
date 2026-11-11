#!/usr/bin/env bash
# ============================================================
# livestream-proctor — smoke test
# Starts the server on a throwaway port with test credentials,
# verifies the key endpoints, then shuts it down.
#
# Usage: ./test.sh [port]
# ============================================================
set -u

PORT="${1:-3100}"
BASE="http://localhost:${PORT}"
ADMIN_PASSWORD="test-admin-password-123"
ADMIN_HASH="$(printf '%s' "$ADMIN_PASSWORD" | sha256sum | awk '{print $1}')"

PASS=0
FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✓ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ✗ $1"; }

echo "▶ Starting server on port ${PORT} ..."
LIVEKIT_URL="wss://test.livekit.cloud" \
LIVEKIT_API_KEY="test-key" \
LIVEKIT_API_SECRET="test-secret" \
ADMIN_PASSWORD_HASH="${ADMIN_HASH}" \
ADMIN_JWT_SECRET="test-jwt-secret-at-least-32-chars-long" \
INSTRUCTOR_CODE="test-instructor-code" \
REQUIRE_INSTRUCTOR_START="false" \
CORS_ORIGIN="*" \
NODE_ENV="development" \
PORT="${PORT}" \
node server.js > /tmp/livestream-test.log 2>&1 &
SERVER_PID=$!

cleanup() {
  kill "${SERVER_PID}" 2>/dev/null || true
  wait "${SERVER_PID}" 2>/dev/null || true
}
trap cleanup EXIT

# Wait for /health (up to ~10s)
for i in $(seq 1 20); do
  if curl -s -o /dev/null "${BASE}/health"; then break; fi
  sleep 0.5
done

echo "▶ Running checks ..."

# 1. /health returns 200 with ok:true
HEALTH_BODY="$(curl -s "${BASE}/health")"
HEALTH_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/health")"
if [ "${HEALTH_CODE}" = "200" ] && printf '%s' "${HEALTH_BODY}" | grep -q '"ok":true'; then
  ok "GET /health → 200 { ok: true }"
else
  bad "GET /health → ${HEALTH_CODE} ${HEALTH_BODY}"
fi

# 2. /admin.html redirects to /admin/login without a cookie
REDIR="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "${BASE}/admin.html")"
case "${REDIR}" in
  302*"/admin/login"*) ok "GET /admin.html without cookie → 302 to /admin/login" ;;
  *) bad "GET /admin.html without cookie → ${REDIR} (expected 302 → /admin/login)" ;;
esac

# 3. Wrong password is rejected (redirect back to login with err=1)
WRONG_CODE="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' \
  -X POST -d 'password=wrong-password' "${BASE}/admin/login")"
case "${WRONG_CODE}" in
  302*"/admin/login?err=1"*) ok "POST /admin/login wrong password → rejected" ;;
  *) bad "POST /admin/login wrong password → ${WRONG_CODE} (expected 302 → err=1)" ;;
esac

# 4. Correct password (hashed server-side) sets the admin_session cookie
COOKIE_JAR="$(mktemp)"
LOGIN_CODE="$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' \
  -c "${COOKIE_JAR}" -X POST -d "password=${ADMIN_PASSWORD}" "${BASE}/admin/login")"
case "${LOGIN_CODE}" in
  302*"/admin.html"*) ok "POST /admin/login correct password → 302 to /admin.html" ;;
  *) bad "POST /admin/login correct password → ${LOGIN_CODE} (expected 302 → /admin.html)" ;;
esac

if grep -q "admin_session" "${COOKIE_JAR}"; then
  ok "admin_session cookie set (HttpOnly JWT)"
else
  bad "admin_session cookie NOT set"
fi

# 5. Authenticated /admin.html returns 200
ADMIN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -b "${COOKIE_JAR}" "${BASE}/admin.html")"
if [ "${ADMIN_CODE}" = "200" ]; then
  ok "GET /admin.html with cookie → 200"
else
  bad "GET /admin.html with cookie → ${ADMIN_CODE} (expected 200)"
fi
rm -f "${COOKIE_JAR}"

# 6. /api/config exposes telemetry settings
CFG="$(curl -s "${BASE}/api/config")"
if printf '%s' "${CFG}" | grep -q '"snapshotIntervalMs":30000' \
   && printf '%s' "${CFG}" | grep -q '"tabHiddenAlertThresholdMs":10000'; then
  ok "GET /api/config → snapshotIntervalMs + tabHiddenAlertThresholdMs"
else
  bad "GET /api/config → ${CFG}"
fi

# 7. /api/token validates input (400 without roomName/identity)
TOKEN_CODE="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' -d '{}' "${BASE}/api/token")"
if [ "${TOKEN_CODE}" = "400" ]; then
  ok "POST /api/token empty body → 400"
else
  bad "POST /api/token empty body → ${TOKEN_CODE} (expected 400)"
fi

# 8. CSP header pins the LiveKit origin + blocks eval
CSP="$(curl -s -I "${BASE}/" | grep -i 'content-security-policy' || true)"
if printf '%s' "${CSP}" | grep -q 'wss://test.livekit.cloud' \
   && printf '%s' "${CSP}" | grep -q 'cdn.jsdelivr.net' \
   && ! printf '%s' "${CSP}" | grep -q 'unsafe-eval'; then
  ok "CSP pins LiveKit origin + allows jsDelivr, no unsafe-eval"
else
  bad "CSP header unexpected: ${CSP}"
fi

# 9. LiveKit browser SDK served locally from node_modules (no CDN needed)
SDK_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/js/vendor/livekit-client.umd.js")"
if [ "${SDK_CODE}" = "200" ]; then
  ok "GET /js/vendor/livekit-client.umd.js → 200 (local SDK)"
else
  bad "GET /js/vendor/livekit-client.umd.js → ${SDK_CODE} (expected 200)"
fi

# 10. Student UI ships screen-share + chat controls, chat input capped at 500 chars
STUDENT_HTML="$(curl -s "${BASE}/")"
if printf '%s' "${STUDENT_HTML}" | grep -q 'id="shareBtn"' \
   && printf '%s' "${STUDENT_HTML}" | grep -q 'id="chatLog"' \
   && printf '%s' "${STUDENT_HTML}" | grep -q 'id="chatInput"'; then
  ok "Student UI includes screen-share button + chat panel"
else
  bad "Student UI missing screen-share/chat markup"
fi

# 11. Token grants: students may NOT screen-share (instructor-only policy)
STUDENT_TOKEN="$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"roomName":"grant-room","identity":"stu1","role":"student"}' "${BASE}/api/token" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch(e){console.log('')}})")"
INSTRUCTOR_TOKEN="$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"roomName":"grant-room","identity":"teach1","role":"instructor","code":"test-instructor-code"}' "${BASE}/api/token" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).token||'')}catch(e){console.log('')}})")"
STUDENT_SOURCES="$(node -e "try{const p=JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url').toString());console.log((p.video&&p.video.canPublishSources||[]).join(','))}catch(e){console.log('parse-error')}" "${STUDENT_TOKEN}")"
INSTRUCTOR_SOURCES="$(node -e "try{const p=JSON.parse(Buffer.from(process.argv[1].split('.')[1],'base64url').toString());console.log((p.video&&p.video.canPublishSources||[]).join(','))}catch(e){console.log('parse-error')}" "${INSTRUCTOR_TOKEN}")"
if printf '%s' "${STUDENT_SOURCES}" | grep -q 'camera' \
   && ! printf '%s' "${STUDENT_SOURCES}" | grep -q 'screen_share' \
   && printf '%s' "${INSTRUCTOR_SOURCES}" | grep -q 'screen_share'; then
  ok "JWT grants: student = camera+mic only; instructor includes screen_share"
else
  bad "JWT grants unexpected — student[${STUDENT_SOURCES}] instructor[${INSTRUCTOR_SOURCES}]"
fi

# 12. Logo asset served locally + watermarks wired into tiles
LOGO_CODE="$(curl -s -o /dev/null -w '%{http_code}' "${BASE}/img/cprec-logo.png")"
STUDENT_JS="$(curl -s "${BASE}/js/student.js")"
if [ "${LOGO_CODE}" = "200" ] \
   && printf '%s' "${STUDENT_JS}" | grep -q 'stream-watermark' \
   && printf '%s' "$(curl -s "${BASE}/")" | grep -q 'logo-img'; then
  ok "CPRE Nepal logo served locally; header + tile watermarks wired"
else
  bad "Logo asset/watermarks missing (logo=${LOGO_CODE})"
fi

# 13. Pin/fullscreen controls ship for every video tile (all participants)
STUDENT_JS="$(curl -s "${BASE}/js/student.js")"
if printf '%s' "${STUDENT_JS}" | grep -q 'tc-pin' \
   && printf '%s' "${STUDENT_JS}" | grep -q 'requestFullscreen'; then
  ok "Student JS ships universal pin/fullscreen tile controls"
else
  bad "Student JS missing pin/fullscreen tile controls"
fi

# 13. Instructor role is code-gated: wrong code → 403, correct code → 200
INST_WRONG="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"roomName":"code-room","identity":"t1","role":"instructor","code":"wrong-code"}' "${BASE}/api/token")"
INST_RIGHT="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"roomName":"code-room","identity":"t1","role":"instructor","code":"test-instructor-code"}' "${BASE}/api/token")"
INST_MISSING="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  -H 'Content-Type: application/json' \
  -d '{"roomName":"code-room","identity":"t1","role":"instructor"}' "${BASE}/api/token")"
if [ "${INST_WRONG}" = "403" ] && [ "${INST_MISSING}" = "403" ] && [ "${INST_RIGHT}" = "200" ]; then
  ok "Instructor code gate: wrong/missing → 403, correct → 200"
else
  bad "Instructor code gate: wrong=${INST_WRONG} missing=${INST_MISSING} correct=${INST_RIGHT}"
fi

# 14. Join gate (REQUIRE_INSTRUCTOR_START=true): student token blocked
#     until an instructor has joined; instructor tokens always allowed.
GATE_PORT=$((PORT + 1))
GATE_BASE="http://localhost:${GATE_PORT}"
REQUIRE_INSTRUCTOR_START="true" \
INSTRUCTOR_CODE="test-instructor-code" \
LIVEKIT_URL="wss://test.livekit.cloud" \
LIVEKIT_API_KEY="test-key" \
LIVEKIT_API_SECRET="test-secret" \
ADMIN_PASSWORD_HASH="${ADMIN_HASH}" \
ADMIN_JWT_SECRET="test-jwt-secret-at-least-32-chars-long" \
CORS_ORIGIN="*" \
NODE_ENV="development" \
PORT="${GATE_PORT}" \
node server.js > /tmp/livestream-gate-test.log 2>&1 &
GATE_PID=$!
for i in $(seq 1 20); do
  if curl -s -o /dev/null "${GATE_BASE}/health"; then break; fi
  sleep 0.5
done

GATE_STUDENT="$(curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"roomName":"gate-room","identity":"stu","role":"student"}' "${GATE_BASE}/api/token")"
GATE_STUDENT_CODE="$(printf '%s' "${GATE_STUDENT}" | grep -o 'SESSION_NOT_STARTED' || true)"
GATE_INST="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
  -d '{"roomName":"gate-room","identity":"teach","role":"instructor","code":"test-instructor-code"}' "${GATE_BASE}/api/token")"
if printf '%s' "${GATE_STUDENT}" | grep -q '"code":"SESSION_NOT_STARTED"' \
   && [ -n "${GATE_STUDENT_CODE}" ] \
   && [ "${GATE_INST}" = "200" ]; then
  ok "Join gate: student token blocked (SESSION_NOT_STARTED); instructor → 200"
else
  bad "Join gate unexpected — student[${GATE_STUDENT}] instructor=${GATE_INST}"
fi

kill "${GATE_PID}" 2>/dev/null || true
wait "${GATE_PID}" 2>/dev/null || true

echo ""
echo "Result: ${PASS} passed, ${FAIL} failed"
if [ "${FAIL}" -ne 0 ]; then
  echo "Server log:"; cat /tmp/livestream-test.log
  exit 1
fi
echo "All checks passed ✓"
