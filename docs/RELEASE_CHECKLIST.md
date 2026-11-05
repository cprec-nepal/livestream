# Release checklist

Use this checklist for each public release and before enabling real classes or exams. A hosted demo is not automatically ready for high-stakes proctoring.

## 1. Repository and release

- [ ] Start from a clean working tree and the intended release branch.
- [ ] Confirm `.env`, credentials, tokens, and local logs are not tracked by Git.
- [ ] Run `npm ci` successfully from the repository root.
- [ ] Run `node --check server.js`.
- [ ] Confirm the README setup instructions match the current repository structure.
- [ ] Review dependency and security updates.
- [ ] Update the version in `package.json` and `package-lock.json` when making a release.
- [ ] Add release notes covering features, fixes, upgrade steps, and known limitations.
- [ ] Tag the release (for example, `v1.1.0`) only after the pull request is merged.

## 2. Production configuration

- [ ] Set `NODE_ENV=production`.
- [ ] Configure the real `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` in the host's secret settings.
- [ ] Generate a unique `ADMIN_PASSWORD` of at least 12 characters.
- [ ] Generate a unique random `ADMIN_JWT_SECRET` of at least 32 characters.
- [ ] Set `CORS_ORIGIN` to the exact HTTPS application origin, without a trailing slash.
- [ ] Review room capacity, admin cookie TTL, and telemetry thresholds.
- [ ] Verify no placeholder values remain.
- [ ] Configure a custom domain, HTTPS, and WSS.
- [ ] Configure `/health` as the hosting provider's health check.

## 3. Security and privacy gates

- [ ] Add student authentication or expiring, single-use join invitations before private classes or assessments.
- [ ] Authorize room access and participant identity on the server; do not trust browser-supplied values alone.
- [ ] Add rate limiting to the admin login endpoint.
- [ ] Test rate limiting and client IP handling behind the production reverse proxy.
- [ ] Keep the admin dashboard private and use unique credentials for each environment.
- [ ] Publish a privacy notice explaining telemetry, its purpose, retention, and user rights.
- [ ] Obtain any required consent for webcam, microphone, and proctoring telemetry.
- [ ] Complete an appropriate security review before high-stakes use.

## 4. Functional smoke tests

- [ ] `GET /health` returns HTTP 200 and `{ "ok": true }`.
- [ ] The student page loads over HTTPS without browser console errors.
- [ ] The admin page redirects signed-out users to `/admin/login`.
- [ ] Valid admin credentials sign in; invalid credentials do not.
- [ ] Admin logout clears access to the dashboard.
- [ ] Two participants can join the same LiveKit room and hear each other.
- [ ] Camera and microphone permissions work on supported desktop and mobile browsers.
- [ ] Mobile participants start audio-only and can opt into camera video.
- [ ] Room capacity is enforced without issuing excess student tokens.
- [ ] Tab-visibility and snapshot-hash telemetry reach only authenticated admins.
- [ ] Participants and Socket.IO connections recover acceptably after a temporary network interruption.
- [ ] The application restarts cleanly and passes its health check.

## 5. Rollout and operations

- [ ] Start with one application instance; current room counts and telemetry are in memory.
- [ ] Run a small private pilot before a public launch or real assessment.
- [ ] Enable hosting logs, uptime monitoring, and error alerts.
- [ ] Document who operates LiveKit, rotates secrets, and responds to incidents.
- [ ] Record the previous release and hosting rollback procedure.
- [ ] Verify rollback on a non-production environment where practical.
- [ ] Announce the release only after the deployed version passes the smoke tests.

## 6. GitHub release

- [ ] Merge the reviewed pull request into `main`.
- [ ] Create an annotated tag matching the package version.
- [ ] Publish a GitHub Release with setup and upgrade notes.
- [ ] Add screenshots or a short demo where useful.
- [ ] Link the demo only if it is intentionally public, capacity-limited, and uses non-production credentials.
