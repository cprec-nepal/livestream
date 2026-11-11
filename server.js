/**
 * livestream-proctor — server.js
 * ------------------------------------------------------------------
 * Express + Socket.io backend for a mobile-optimized LiveKit
 * online-session platform with lightweight proctoring telemetry.
 *
 * Responsibilities:
 *   1. Serve the student (public/index.html) and admin (public/admin.html) UIs.
 *   2. Mint short-lived LiveKit access tokens SERVER-SIDE only — the
 *      API key / secret are NEVER shipped to the browser.
 *   3. Enforce a per-room capacity limit BEFORE a token is issued.
 *   4. Accept proctoring telemetry (tab visibility, snapshot hashes)
 *      over Socket.io and broadcast alerts to admin clients.
 *
 * Security:
 *   - Helmet for hardened HTTP headers (CSP: jsDelivr + wss:/https:, no eval)
 *   - CORS allowlist via CORS_ORIGIN env var
 *   - Rate limiting on /api/token (10/min/IP) and /admin/login (5/min/IP)
 *   - Admin auth v1.2: SHA-256 password hash + timingSafeEqual + JWT cookie
 *   - In-memory session bookkeeping keyed by socket.id (good enough
 *     for a lightweight proctor; swap for Redis if you need to share
 *     state across multiple app-server instances)
 * ------------------------------------------------------------------
 */

'use strict';

require('dotenv').config();

const path = require('path');
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');          // for timingSafeEqual in admin auth
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');       // for admin session cookies
const cookieParser = require('cookie-parser');
const { Server: SocketIOServer } = require('socket.io');
const { AccessToken } = require('livekit-server-sdk');
const { TrackSource, TrackType } = require('@livekit/protocol');

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'YOUR_LIVEKIT_API_KEY';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'YOUR_LIVEKIT_API_SECRET';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://your-livekit-server.example.com';

// Pin the LiveKit signaling host into CSP connect-src when LIVEKIT_URL
// is a real wss(s) URL (not the placeholder). Returns e.g. 'wss://myproject.livekit.cloud'.
function livekitCspOrigins() {
  try {
    const u = new URL(LIVEKIT_URL);
    if ((u.protocol === 'wss:' || u.protocol === 'https:') && u.hostname && !/example\.com$/i.test(u.hostname)) {
      return [u.origin];
    }
  } catch (e) { /* keep broad fallback below */ }
  return ['wss:'];
}


const MAX_PARTICIPANTS_PER_ROOM = parseInt(process.env.MAX_PARTICIPANTS_PER_ROOM || '50', 10);
const TAB_HIDDEN_ALERT_THRESHOLD_MS = parseInt(process.env.TAB_HIDDEN_ALERT_THRESHOLD_MS || '10000', 10);
const SNAPSHOT_INTERVAL_MS = parseInt(process.env.SNAPSHOT_INTERVAL_MS || '30000', 10);

// ---- Admin authentication (v1.2) ----
// Single-password admin login backed by env vars. Issues a signed JWT
// cookie (admin_session) that the browser sends on every /admin* request.
// For multi-admin with audit trails, see README.md §"Admin authentication".
//
// v1.2 stores only the SHA-256 HASH of the admin password:
//   ADMIN_PASSWORD_HASH = hex( SHA-256( actual_password ) )
// The plaintext password never appears in config, logs, or the repo.
// On login the server hashes the submitted password and compares the two
// digests with crypto.timingSafeEqual (constant-time).
//
// Backward compatibility: deployments still using the legacy plaintext
// ADMIN_PASSWORD variable keep working — the value is hashed once at
// startup and the same constant-time digest comparison is used. A
// deprecation warning is logged; migrate to ADMIN_PASSWORD_HASH.
const ADMIN_PASSWORD_HASH_RAW = (process.env.ADMIN_PASSWORD_HASH || '').trim().toLowerCase();
const ADMIN_PASSWORD_LEGACY = process.env.ADMIN_PASSWORD || '';

function sha256Digest(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest();
}

function parsePasswordHash(hex) {
  if (!/^[a-f0-9]{64}$/.test(hex)) return null;
  return Buffer.from(hex, 'hex');
}

let ADMIN_PASSWORD_HASH = parsePasswordHash(ADMIN_PASSWORD_HASH_RAW);
let ADMIN_AUTH_SOURCE = 'none';
if (ADMIN_PASSWORD_HASH) {
  ADMIN_AUTH_SOURCE = 'hash';
} else if (ADMIN_PASSWORD_HASH_RAW) {
  console.error('[FATAL] ADMIN_PASSWORD_HASH must be a 64-character hex SHA-256 digest.');
  console.error('        Generate one with: echo -n "your-password" | sha256sum');
  process.exit(1);
} else if (ADMIN_PASSWORD_LEGACY) {
  ADMIN_PASSWORD_HASH = sha256Digest(ADMIN_PASSWORD_LEGACY);
  ADMIN_AUTH_SOURCE = 'legacy-plaintext';
  console.warn('[WARN] ADMIN_PASSWORD (plaintext) is deprecated. Migrate to ADMIN_PASSWORD_HASH:');
  console.warn('       echo -n "your-password" | sha256sum  →  set ADMIN_PASSWORD_HASH in .env');
}

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'change-me-in-production';
const ADMIN_COOKIE_TTL_HOURS = parseInt(process.env.ADMIN_COOKIE_TTL_HOURS || '8', 10);

// Unique code required to join a room with the instructor (host) role.
// Without it set, instructor joining is disabled entirely (fail closed)
// — otherwise anyone could tick the instructor box and gain host powers.
const INSTRUCTOR_CODE = (process.env.INSTRUCTOR_CODE || '').trim();
const instructorCodeDigest = INSTRUCTOR_CODE
  ? crypto.createHash('sha256').update(INSTRUCTOR_CODE).digest()
  : null;


const CORS_ORIGIN_RAW = process.env.CORS_ORIGIN || '*';
const CORS_ORIGINS = CORS_ORIGIN_RAW === '*'
  ? '*'
  : CORS_ORIGIN_RAW.split(',').map(s => s.trim()).filter(Boolean);

const TOKEN_TTL_MINUTES = 120; // 2 hours

// ------------------------------------------------------------------
// Scheduled classes (file-backed so schedules survive restarts on the
// self-hosted machine). Stored in data/classes.json — gitignored.
// ------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, 'data');
const CLASSES_FILE = path.join(DATA_DIR, 'classes.json');
const MAX_CONFIRMATIONS_PER_CLASS = 200;

/** @type {Map<string, any>} id -> class record */
const scheduledClasses = new Map();

function loadClasses() {
  try {
    if (fs.existsSync(CLASSES_FILE)) {
      const raw = JSON.parse(fs.readFileSync(CLASSES_FILE, 'utf8'));
      if (Array.isArray(raw)) {
        raw.forEach((c) => scheduledClasses.set(c.id, c));
      }
    }
  } catch (err) {
    console.warn('[classes] failed to load classes.json:', err.message);
  }
}

function saveClasses() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CLASSES_FILE, JSON.stringify(Array.from(scheduledClasses.values()), null, 2));
  } catch (err) {
    console.warn('[classes] failed to save classes.json:', err.message);
  }
}

function slugifyRoom(title) {
  const base = String(title || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'class';
  let room = base;
  let n = 2;
  // Room names must be unique among scheduled classes
  const taken = new Set(Array.from(scheduledClasses.values()).map((c) => c.room));
  while (taken.has(room)) room = `${base}-${n++}`;
  return room;
}

function classStatus(c, now = Date.now()) {
  const start = new Date(c.startAt).getTime();
  const end = start + c.durationMin * 60000;
  if (now < start) return 'upcoming';
  if (now < end) return 'live';
  return 'ended';
}

function publicClass(c) {
  return {
    id: c.id,
    title: c.title,
    room: c.room,
    startAt: c.startAt,
    durationMin: c.durationMin,
    status: classStatus(c),
    confirmedCount: (c.confirmations || []).length,
  };
}

loadClasses();

// v1.5: students can join only after the instructor has started the
// session. Set REQUIRE_INSTRUCTOR_START=false to restore open joining.
const REQUIRE_INSTRUCTOR_START = (process.env.REQUIRE_INSTRUCTOR_START || 'true').toLowerCase()
  !== 'false';

// ------------------------------------------------------------------
// Fail-fast on missing real credentials in production
// ------------------------------------------------------------------
if (NODE_ENV === 'production') {
  if (LIVEKIT_API_KEY === 'YOUR_LIVEKIT_API_KEY' || LIVEKIT_API_SECRET === 'YOUR_LIVEKIT_API_SECRET') {
    console.error('[FATAL] LIVEKIT_API_KEY / LIVEKIT_API_SECRET are still placeholders.');
    console.error('        Set them in your .env file before running in production.');
    process.exit(1);
  }
  if (LIVEKIT_URL.startsWith('wss://your-livekit-server')) {
    console.error('[FATAL] LIVEKIT_URL is still a placeholder. Set it in your .env file.');
    process.exit(1);
  }
  if (ADMIN_AUTH_SOURCE === 'none') {
    console.error('[FATAL] ADMIN_PASSWORD_HASH is not set.');
    console.error('        Generate one with: echo -n "your-strong-password" | sha256sum');
    console.error('        Then set ADMIN_PASSWORD_HASH in your .env file.');
    process.exit(1);
  }
  if (ADMIN_AUTH_SOURCE === 'legacy-plaintext' && ADMIN_PASSWORD_LEGACY.length < 12) {
    console.error('[FATAL] ADMIN_PASSWORD is shorter than 12 characters.');
    console.error('        Use a stronger password, or migrate to ADMIN_PASSWORD_HASH.');
    process.exit(1);
  }
  if (ADMIN_JWT_SECRET === 'change-me-in-production' || ADMIN_JWT_SECRET.length < 32) {
    console.error('[FATAL] ADMIN_JWT_SECRET is still the default or shorter than 32 characters.');
    console.error('        Generate one with: openssl rand -hex 32');
    process.exit(1);
  }
}

// ------------------------------------------------------------------
// In-memory session state
//   rooms:        Map<roomName, { participantCount, alerts: Alert[], createdAt }>
//   socketToSession: Map<socketId, { roomName, identity, role, joinedAt, hiddenSince }>
// ------------------------------------------------------------------
const rooms = new Map();
const socketToSession = new Map();

function ensureRoom(roomName) {
  if (!rooms.has(roomName)) {
    rooms.set(roomName, {
      name: roomName,
      participantCount: 0,
      alerts: [],
      // Identities explicitly allowed to share their screen by a host
      // (instructor or admin). Instructors are always allowed by role.
      sharers: new Set(),
      // True once an instructor has joined the session. When
      // REQUIRE_INSTRUCTOR_START is on, students cannot get tokens
      // until this flips.
      hasInstructor: false,
      createdAt: Date.now(),
    });
  }
  return rooms.get(roomName);
}

// Instructor sockets per room, for relaying proctoring telemetry to
// the instructor's in-class view (the admin dashboard has its own
// channel). Maps roomName -> Set<socketId>.
const instructorSocketsByRoom = new Map();

function addInstructorSocket(roomName, socketId) {
  if (!instructorSocketsByRoom.has(roomName)) {
    instructorSocketsByRoom.set(roomName, new Set());
  }
  instructorSocketsByRoom.get(roomName).add(socketId);
}

function removeInstructorSocket(roomName, socketId) {
  const set = instructorSocketsByRoom.get(roomName);
  if (set) {
    set.delete(socketId);
    if (set.size === 0) instructorSocketsByRoom.delete(roomName);
  }
  // If no instructor sockets remain live for the room, the instructor
  // has left — new students must wait for them to come back.
  const hasLiveInstructor = Array.from(socketToSession.values())
    .some((s) => s.roomName === roomName && s.role === 'instructor');
  const room = rooms.get(roomName);
  if (room) room.hasInstructor = hasLiveInstructor;
}

// Relay a proctoring/telemetry event to instructor sockets in a room
// (wrapped as a generic envelope) plus the admin broadcast channel.
function emitTelemetry(roomName, type, payload) {
  const event = { type, ...payload };
  const instructors = instructorSocketsByRoom.get(roomName);
  if (instructors) {
    instructors.forEach((socketId) => io.to(socketId).emit('telemetry:event', event));
  }
  io.to(ADMIN_ROOM).emit(type, payload);
}

// All live participant sessions in a room (from the socket registry).
function participantsInRoom(roomName) {
  const out = [];
  for (const session of socketToSession.values()) {
    if (session.roomName === roomName) {
      out.push({
        identity: session.identity,
        role: session.role,
        isMobile: Boolean(session.isMobile),
        joinedAt: session.joinedAt,
      });
    }
  }
  return out;
}

function incrementRoomCount(roomName) {
  ensureRoom(roomName).participantCount += 1;
}

function decrementRoomCount(roomName) {
  const room = rooms.get(roomName);
  if (!room) return;
  room.participantCount = Math.max(0, room.participantCount - 1);
}

function pushAlert(roomName, alert) {
  const room = ensureRoom(roomName);
  room.alerts.push(alert);
  // Cap stored alerts per room to prevent unbounded growth
  if (room.alerts.length > 500) {
    room.alerts.splice(0, room.alerts.length - 500);
  }
}

// ------------------------------------------------------------------
// Screen-share permission control (host-managed)
//   Policy: instructors can always share; students need an explicit
//   grant from a host. Enforcement is two-layered:
//     1. JWT grants: student tokens only allow camera+mic unless the
//        identity is in the room's sharers set at mint time.
//     2. Live API: RoomServiceClient.updateParticipant flips the
//        permission of a *connected* participant without a rejoin.
// ------------------------------------------------------------------
let roomServiceClient = null;
function getRoomService() {
  if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) return null;
  if (!roomServiceClient) {
    const { RoomServiceClient } = require('livekit-server-sdk');
    roomServiceClient = new RoomServiceClient(LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET);
  }
  return roomServiceClient;
}

function publishSourcesFor(role, roomName, identity) {
  const sources = [TrackSource.CAMERA, TrackSource.MICROPHONE];
  if (role === 'instructor' || ensureRoom(roomName).sharers.has(identity)) {
    sources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
  }
  return sources;
}

// Best-effort live permission flip for a participant currently in the
// room. Fails gracefully when LiveKit is unreachable (state change and
// UI events still apply; the grant also persists in the room's sharers
// set so tokens minted afterwards include the source).
async function setLiveSharePermission(roomName, identity, allowed) {
  const svc = getRoomService();
  if (!svc) return { livekitUpdated: false, reason: 'no-credentials' };
  try {
    await svc.updateParticipant(roomName, identity, {
      permission: {
        canSubscribe: true,
        canPublish: true,
        canPublishData: true,
        canPublishSources: allowed
          ? [TrackSource.CAMERA, TrackSource.MICROPHONE, TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO]
          : [TrackSource.CAMERA, TrackSource.MICROPHONE],
      },
    });
    return { livekitUpdated: true };
  } catch (err) {
    console.warn(`[share] LiveKit updateParticipant failed for ${identity}@${roomName}: ${err.message}`);
    return { livekitUpdated: false, reason: err.message };
  }
}

async function applyShareGrant(roomName, identity, allowed) {
  const room = ensureRoom(roomName);
  if (allowed) room.sharers.add(identity);
  else room.sharers.delete(identity);

  const live = await setLiveSharePermission(roomName, identity, allowed);
  const event = {
    roomName,
    identity,
    allowed,
    enforcedByLiveKit: live.livekitUpdated,
    timestamp: Date.now(),
  };
  io.to(roomName).emit('share:permission', event);
  io.to(ADMIN_ROOM).emit('share:permission', event);
  return event;
}

// ------------------------------------------------------------------
// Express app
// ------------------------------------------------------------------
const app = express();

// Behind a reverse proxy (Render, Caddy, nginx, …) the real client IP
// arrives in X-Forwarded-For. Only trust it when TRUST_PROXY=true so
// rate limiting keys on the client IP instead of the proxy IP.
if (process.env.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

app.use(helmet({
  // One year, subdomains included. `preload` is deliberately NOT set:
  // it is near-irreversible and would force HTTPS on every subdomain of
  // the registrable domain — enable it only once the org is ready.
  hsts: { maxAge: 31536000, includeSubDomains: true },
  // Balanced referrer policy: origin sent cross-origin, full URL only
  // same-origin (no-referrer broke legitimate deep-link flows).
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        // LiveKit client SDK via jsDelivr CDN (single-file HTML UI)
        'https://cdn.jsdelivr.net',
        // Cloudflare injects its Web Analytics (RUM) beacon + inline
        // bootstrap when the site is served through the orange-cloud
        // proxy (e.g. behind cloudflared tunnel + proxied DNS).
        'https://static.cloudflareinsights.com',
        // The inline bootstrap loader Cloudflare injects. If Cloudflare
        // changes it, the console shows the new hash to add here.
        'sha256-49lfgPG8HNEabLofSHUlsPZlsBnNVnuB+zZ6RpMMkc0=',
      ],
      // socket.io + LiveKit signaling. The LiveKit host is pinned from
      // LIVEKIT_URL when it looks real, so a rogue subdomain cannot
      // become a signaling endpoint; 'wss:' remains only as a fallback
      // when the URL is still a placeholder.
      connectSrc: [
        "'self'",
        ...livekitCspOrigins(),
        'https:',
        // Cloudflare RUM beacon reporting endpoint
        'https://cloudflareinsights.com',
      ],
      imgSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'", 'blob:', 'https:'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", 'data:'],
      // LiveKit client workers (blob-based); no 'unsafe-eval' anywhere.
      workerSrc: ["'self'", 'blob:'],
    },
  },
}));

app.use(cors({
  origin: CORS_ORIGINS === '*' ? true : CORS_ORIGINS,
  methods: ['GET', 'POST'],
}));

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false }));   // for the login form POST
app.use(cookieParser());                            // populates req.cookies

// ------------------------------------------------------------------
// Admin authentication
//   GET  /admin/login   — render the login form
//   POST /admin/login   — verify password, set admin_session cookie
//   POST /admin/logout  — clear cookie, redirect to login
//   requireAdmin middleware — protects /admin.html and /admin/*
// ------------------------------------------------------------------

// Constant-time password check (v1.2): hash the submitted password with
// SHA-256 and compare the two 32-byte digests with crypto.timingSafeEqual
// so response timing never leaks how much of the password was correct.
function passwordMatches(submitted) {
  if (!ADMIN_PASSWORD_HASH) return false;
  const submittedDigest = sha256Digest(submitted || '');
  if (submittedDigest.length !== ADMIN_PASSWORD_HASH.length) return false;
  return crypto.timingSafeEqual(submittedDigest, ADMIN_PASSWORD_HASH);
}

function requireAdmin(req, res, next) {
  const token = req.cookies && req.cookies.admin_session;
  if (!token) return res.redirect('/admin/login');
  try {
    jwt.verify(token, ADMIN_JWT_SECRET, { algorithms: ['HS256'] });
    return next();
  } catch (err) {
    res.clearCookie('admin_session');
    return res.redirect('/admin/login');
  }
}

app.get('/admin/login', (req, res) => {
  let errMsg = '';
  if (req.query.err === '1') {
    errMsg = '<div class="err">Invalid password. Please try again.</div>';
  } else if (req.query.err === '2') {
    errMsg = '<div class="err">Your session has expired. Please sign in again.</div>';
  } else if (req.query.err === '3') {
    errMsg = '<div class="err">Too many sign-in attempts. Please wait a minute and try again.</div>';
  }
  res.type('html').send(
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Admin login · LiveSession Proctor</title>' +
    '<style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;' +
    'background:#0b0f1a;color:#e7ecf5;display:grid;place-items:center;' +
    'min-height:100vh;margin:0;padding:20px;box-sizing:border-box}' +
    'form{background:linear-gradient(180deg,#111726,#0b0f1a);padding:32px;' +
    'border-radius:14px;border:1px solid rgba(255,255,255,.08);width:100%;' +
    'max-width:340px;box-shadow:0 8px 32px rgba(0,0,0,.45)}' +
    'h1{margin:0 0 6px;font-size:20px;font-weight:700}' +
    'p.lead{margin:0 0 20px;color:#94a1b8;font-size:13px;line-height:1.5}' +
    'label{display:block;font-size:11px;color:#94a1b8;text-transform:uppercase;' +
    'letter-spacing:.6px;margin-bottom:6px}' +
    'input{width:100%;padding:12px 14px;border-radius:9px;' +
    'border:1px solid #1a2235;background:#0b0f1a;color:#fff;font-size:14px;' +
    'margin-bottom:16px;box-sizing:border-box;transition:border-color .15s,box-shadow .15s}' +
    'input:focus{outline:none;border-color:#4f7cff;box-shadow:0 0 0 3px rgba(79,124,255,.35)}' +
    'button{width:100%;padding:12px 18px;border-radius:9px;border:0;' +
    'background:linear-gradient(135deg,#4f7cff,#6f5cff);color:#fff;' +
    'font-size:14px;font-weight:600;cursor:pointer;' +
    'box-shadow:0 8px 24px rgba(79,124,255,.35)}' +
    'button:hover{filter:brightness(1.08)}' +
    '.err{color:#ff5a6a;font-size:13px;margin-bottom:14px;padding:8px 12px;' +
    'background:rgba(255,90,106,.08);border:1px solid rgba(255,90,106,.25);' +
    'border-radius:7px}' +
    '.brand{display:flex;align-items:center;gap:10px;margin-bottom:18px}' +
    '.brand .logo{width:32px;height:32px;border-radius:8px;' +
    'background:linear-gradient(135deg,#4f7cff,#8a5cff);display:grid;place-items:center;' +
    'color:#fff;font-weight:700;box-shadow:0 0 0 1px rgba(255,255,255,.16)}' +
    '.brand .title{font-size:14px;font-weight:600}' +
    '.brand .subtitle{font-size:11px;color:#94a1b8}' +
    '</style></head>' +
    '<body><form method="POST" action="/admin/login">' +
    '<div class="brand"><div class="logo">A</div>' +
    '<div><div class="title">Admin Dashboard</div>' +
    '<div class="subtitle">CPREC Nepal · LiveSession Proctor</div></div></div>' +
    '<h1>Sign in</h1>' +
    '<p class="lead">Enter the admin password to access the monitoring dashboard.</p>' +
    errMsg +
    '<label for="password">Password</label>' +
    '<input id="password" name="password" type="password" placeholder="Admin password" autofocus required>' +
    '<button type="submit">Sign in</button>' +
    '</form></body></html>'
  );
});

// Rate limit: 5 login attempts / minute / IP (brute-force guard).
// The handler redirects back to the form so browser users see a friendly
// message instead of a raw JSON error.
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    console.warn('[admin] login rate limit hit for ' + (req.ip || 'unknown'));
    return res.redirect('/admin/login?err=3');
  },
});

app.post('/admin/login', loginLimiter, (req, res) => {
  const submitted = (req.body && req.body.password) || '';
  if (!passwordMatches(submitted)) {
    console.warn('[admin] failed login attempt from ' + (req.ip || 'unknown'));
    return res.redirect('/admin/login?err=1');
  }
  const token = jwt.sign({ role: 'admin' }, ADMIN_JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: ADMIN_COOKIE_TTL_HOURS * 3600,
  });
  res.cookie('admin_session', token, {
    httpOnly: true,
    secure: NODE_ENV === 'production',
    sameSite: 'strict',
    maxAge: ADMIN_COOKIE_TTL_HOURS * 3600 * 1000,
    path: '/',
  });
  console.log('[admin] successful login from ' + (req.ip || 'unknown'));
  return res.redirect('/admin.html');
});

app.post('/admin/logout', (req, res) => {
  res.clearCookie('admin_session', { path: '/' });
  return res.redirect('/admin/login');
});

// Protect /admin.html and anything under /admin/* BEFORE express.static runs.
// Order matters: this MUST come before `app.use(express.static(...))`.
app.use('/admin.html', requireAdmin);
app.use('/admin', requireAdmin);

// Serve the LiveKit browser SDK from node_modules instead of the jsDelivr CDN
// so rooms keep working on networks where the CDN is blocked or unreachable.
// (Package exports map "." -> dist/livekit-client.umd.js for `require`.)
const LIVEKIT_CLIENT_UMD = require.resolve('livekit-client');
app.get('/js/vendor/livekit-client.umd.js', (_req, res) => {
  res.sendFile(LIVEKIT_CLIENT_UMD);
});

// Now serve static files (public/index.html, public/admin.html, /socket.io/)
// Cache-Control: no-cache for app files so Cloudflare's edge (orange
// cloud / tunnel) revalidates with ETags instead of serving stale JS —
// otherwise deploys don't reach visitors until the edge cache expires.
// The logo is content-stable, so it gets a day of shared caching.
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (filePath.includes(path.join('public', 'img'))) {
      res.setHeader('Cache-Control', 'public, max-age=86400');
    } else {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ------------------------------------------------------------------
// Token endpoint rate limiter (10 requests / minute / IP)
// ------------------------------------------------------------------
const tokenLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many token requests, please slow down.' },
});

// ------------------------------------------------------------------
// Health check
// ------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    rooms: rooms.size,
    totalParticipants: Array.from(rooms.values())
      .reduce((acc, r) => acc + r.participantCount, 0),
    maxParticipantsPerRoom: MAX_PARTICIPANTS_PER_ROOM,
    timestamp: Date.now(),
  });
});

// ------------------------------------------------------------------
// Public client config (no secrets — safe for the browser)
// The student UI reads SNAPSHOT_INTERVAL_MS from here so the cadence is
// controlled server-side via env var without a redeploy of the HTML.
// ------------------------------------------------------------------
// ------------------------------------------------------------------
// Scheduled classes API
//   Admin (cookie-authenticated, JSON 401): create / list / cancel
//   Public: class info card for a room, attendance confirmation
// ------------------------------------------------------------------
function requireAdminApi(req, res, next) {
  const token = req.cookies && req.cookies.admin_session;
  if (!token) return res.status(401).json({ error: 'Admin authentication required' });
  try {
    jwt.verify(token, ADMIN_JWT_SECRET, { algorithms: ['HS256'] });
    return next();
  } catch (err) {
    res.clearCookie('admin_session');
    return res.status(401).json({ error: 'Admin session expired' });
  }
}

const confirmLimiter = rateLimit({
  windowMs: 60000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many confirmation attempts — try again in a minute' },
});

// Create a scheduled class
app.post('/api/classes', requireAdminApi, (req, res) => {
  const { title, room, startAt, durationMin } = req.body || {};
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title is required' });
  }
  if (title.trim().length > 120) {
    return res.status(400).json({ error: 'title too long (max 120 chars)' });
  }
  const start = new Date(startAt || '');
  if (!startAt || Number.isNaN(start.getTime())) {
    return res.status(400).json({ error: 'startAt must be a valid date/time' });
  }
  const dur = parseInt(durationMin, 10);
  if (!Number.isFinite(dur) || dur < 5 || dur > 600) {
    return res.status(400).json({ error: 'durationMin must be 5-600' });
  }

  let roomName = typeof room === 'string' && room.trim()
    ? room.trim().slice(0, 128)
    : slugifyRoom(title);
  const roomTaken = () => Array.from(scheduledClasses.values())
    .some((c) => c.room === roomName && classStatus(c) !== 'ended');
  if (roomTaken() && !room) roomName = slugifyRoom(title);
  if (roomTaken()) {
    return res.status(409).json({ error: `A scheduled class already uses room "${roomName}"`, room: roomName });
  }

  const record = {
    id: crypto.randomUUID(),
    title: title.trim(),
    room: roomName,
    startAt: start.toISOString(),
    durationMin: dur,
    createdAt: Date.now(),
    confirmations: [],
  };
  scheduledClasses.set(record.id, record);
  saveClasses();
  console.log(`[classes] created "${record.title}" room=${record.room} at ${record.startAt}`);
  return res.status(201).json({ ok: true, class: publicClass(record) });
});

// List all scheduled classes (admin) — soonest first
app.get('/api/classes', requireAdminApi, (req, res) => {
  const list = Array.from(scheduledClasses.values())
    .sort((a, b) => new Date(a.startAt) - new Date(b.startAt))
    .map((c) => ({ ...publicClass(c), confirmations: c.confirmations || [] }));
  return res.json({ classes: list });
});

// Cancel (delete) a scheduled class
app.delete('/api/classes/:id', requireAdminApi, (req, res) => {
  const rec = scheduledClasses.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Class not found' });
  scheduledClasses.delete(req.params.id);
  saveClasses();
  return res.json({ ok: true });
});

// Public: class info for the student join screen (no personal data)
app.get('/api/classes/public', (req, res) => {
  const room = String(req.query.room || '').trim().slice(0, 128);
  if (!room) return res.status(400).json({ error: 'room is required' });
  const forRoom = Array.from(scheduledClasses.values())
    .filter((c) => c.room === room)
    .sort((a, b) => new Date(b.startAt) - new Date(a.startAt));
  const rec = forRoom.find((c) => classStatus(c) !== 'ended') || forRoom[0];
  if (!rec) return res.status(404).json({ error: 'No scheduled class for this room' });
  return res.json({ class: publicClass(rec) });
});

// Public: confirm attendance for an upcoming/live class
app.post('/api/classes/:id/confirm', confirmLimiter, (req, res) => {
  const rec = scheduledClasses.get(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Class not found' });
  if (classStatus(rec) === 'ended') {
    return res.status(409).json({ error: 'This class has already ended' });
  }

  const name = typeof req.body && typeof req.body.name === 'string'
    ? req.body.name.trim().slice(0, 64)
    : '';
  if (!name) return res.status(400).json({ error: 'name is required to confirm attendance' });

  rec.confirmations = rec.confirmations || [];
  // Same name confirming twice just refreshes the timestamp
  const existing = rec.confirmations.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.at = Date.now();
  } else {
    if (rec.confirmations.length >= MAX_CONFIRMATIONS_PER_CLASS) {
      return res.status(503).json({ error: 'Confirmation list is full for this class' });
    }
    rec.confirmations.push({ name, at: Date.now() });
  }
  saveClasses();
  return res.json({ ok: true, confirmedCount: rec.confirmations.length, status: classStatus(rec) });
});

app.get('/api/config', (req, res) => {
  res.json({
    maxParticipantsPerRoom: MAX_PARTICIPANTS_PER_ROOM,
    tabHiddenAlertThresholdMs: TAB_HIDDEN_ALERT_THRESHOLD_MS,
    snapshotIntervalMs: SNAPSHOT_INTERVAL_MS,
    // Public info (also sent in every token response) — the client uses
    // it to preconnect to the signaling host.
    livekitUrl: LIVEKIT_URL,
  });
});

// ------------------------------------------------------------------
// Token issuance
//   Body: { roomName: string, identity: string, role?: 'student'|'instructor' }
// ------------------------------------------------------------------
app.post('/api/token', tokenLimiter, async (req, res) => {
  try {
    const { roomName, identity, role } = req.body || {};

    if (!roomName || typeof roomName !== 'string' || roomName.trim().length === 0) {
      return res.status(400).json({ error: 'roomName is required' });
    }
    if (!identity || typeof identity !== 'string' || identity.trim().length === 0) {
      return res.status(400).json({ error: 'identity is required' });
    }
    if (roomName.length > 128 || identity.length > 128) {
      return res.status(400).json({ error: 'roomName / identity too long' });
    }

    const safeRoom = roomName.trim();
    const safeIdentity = identity.trim();
    const safeRole = role === 'instructor' ? 'instructor' : 'student';

    // Instructor role requires the unique instructor code (constant-time
    // compared). Fail closed when no code is configured.
    if (safeRole === 'instructor') {
      if (!instructorCodeDigest) {
        return res.status(503).json({
          error: 'Instructor joining is disabled (no INSTRUCTOR_CODE configured)',
        });
      }
      const provided = typeof req.body.code === 'string' ? req.body.code.trim() : '';
      const providedDigest = crypto.createHash('sha256').update(provided).digest();
      if (!crypto.timingSafeEqual(providedDigest, instructorCodeDigest)) {
        return res.status(403).json({ error: 'Invalid instructor code' });
      }
    }

    // Capacity check — only students count against the cap, instructors
    // are always allowed in (they need to start the session).
    if (safeRole === 'student') {
      // Join gate: students can enter only after the instructor has
      // started the session (v1.5). Disable with REQUIRE_INSTRUCTOR_START=false.
      if (REQUIRE_INSTRUCTOR_START) {
        const room = rooms.get(safeRoom);
        if (!room || !room.hasInstructor) {
          return res.status(403).json({
            error: 'The session has not started yet — please wait for your instructor to join.',
            code: 'SESSION_NOT_STARTED',
            roomName: safeRoom,
          });
        }
      }
      const room = ensureRoom(safeRoom);
      if (room.participantCount >= MAX_PARTICIPANTS_PER_ROOM) {
        return res.status(503).json({
          error: 'Room is at capacity',
          roomName: safeRoom,
          current: room.participantCount,
          max: MAX_PARTICIPANTS_PER_ROOM,
        });
      }
    }

    // Build the LiveKit access token server-side.
    // In livekit-server-sdk v2, VideoGrant is just a plain object passed
    // to addGrant() — there's no separate grant class.
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: safeIdentity,
      ttl: TOKEN_TTL_MINUTES * 60,
      metadata: JSON.stringify({
        role: safeRole,
        issuedAt: Date.now(),
        issuedBy: 'livestream-proctor',
      }),
    });

    at.addGrant({
      room: safeRoom,
      roomJoin: true,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      // Host-managed screen sharing: instructors always can; students
      // only when a host has granted them in this room.
      canPublishSources: publishSourcesFor(safeRole, safeRoom, safeIdentity),
    });

    const token = await at.toJwt();

    // NOTE: we do NOT increment the count here — the real participant
    // count is driven by socket.io session:join / disconnect. This
    // avoids drift when a client gets a token but never connects.
    return res.json({
      token,
      url: LIVEKIT_URL,
      roomName: safeRoom,
      identity: safeIdentity,
      role: safeRole,
      expiresIn: TOKEN_TTL_MINUTES * 60,
    });
  } catch (err) {
    console.error('[token] generation failed:', err);
    return res.status(500).json({ error: 'Failed to generate LiveKit token' });
  }
});

// ------------------------------------------------------------------
// HTTP + Socket.io server
// ------------------------------------------------------------------
const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: {
    origin: CORS_ORIGINS === '*' ? true : CORS_ORIGINS,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e5, // 100kb — hashes are tiny
});

// ------------------------------------------------------------------
// Socket.io auth guard — verify admin_session cookie on every connection.
// Without this, a malicious user could open a Socket.io connection directly
// to /socket.io/ and emit `admin:join` from a console, bypassing the
// page-level guard.
// ------------------------------------------------------------------
io.use((socket, next) => {
  const cookieHeader = socket.handshake.headers.cookie || '';
  const m = cookieHeader.match(/admin_session=([^;]+)/);
  if (!m) {
    // Allow student telemetry sockets (they have no admin cookie) — the
    // admin-broadcast room is only joined on explicit `admin:join` which
    // we now also gate below.
    socket.handshake.isAdmin = false;
    return next();
  }
  try {
    jwt.verify(m[1], ADMIN_JWT_SECRET, { algorithms: ['HS256'] });
    socket.handshake.isAdmin = true;
    return next();
  } catch (err) {
    return next(new Error('unauthorized'));
  }
});

const ADMIN_ROOM = 'admin-broadcast';

// Room chat limits (server-side relay)
const CHAT_MAX_LENGTH = 500;        // max characters per message
const CHAT_WINDOW_MS = 10000;       // rate-limit window
const CHAT_MAX_PER_WINDOW = 8;      // max messages per window per socket

// ------------------------------------------------------------------
// Socket.io telemetry handlers
// ------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log(`[io] connected socket=${socket.id}`);

  // ---- session:join ---------------------------------------------
  // Sent by the student UI right after LiveKit.connect() succeeds.
  // { roomName, identity, role, isMobile }
  socket.on('session:join', (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const { roomName, identity, role, isMobile } = payload;
    if (!roomName || !identity) return;

    const session = {
      roomName,
      identity,
      role: role || 'student',
      isMobile: Boolean(isMobile),
      joinedAt: Date.now(),
      hiddenSince: null,
    };
    socketToSession.set(socket.id, session);

    socket.join(roomName);
    incrementRoomCount(roomName);

    if (session.role === 'instructor') {
      // The instructor has started the session — students may join now.
      ensureRoom(roomName).hasInstructor = true;
      addInstructorSocket(roomName, socket.id);
    }

    io.to(ADMIN_ROOM).emit('session:join', {
      socketId: socket.id,
      ...session,
    });
    // Keep the instructor's in-class strip up to date too.
    emitTelemetry(roomName, 'session:join', {
      socketId: socket.id,
      ...session,
    });
  });

  // ---- telemetry:subscribe ----------------------------------------
  // Instructor-only: receive proctoring/telemetry events for their own
  // room in the in-class strip (students never receive these).
  socket.on('telemetry:subscribe', () => {
    const session = socketToSession.get(socket.id);
    if (!session || session.role !== 'instructor') return;
    addInstructorSocket(session.roomName, socket.id);
  });

  // ---- telemetry:visibility ------------------------------------
  // { hidden: boolean, timestamp: number }
  socket.on('telemetry:visibility', (data) => {
    const session = socketToSession.get(socket.id);
    if (!session || !data) return;

    const now = data.timestamp || Date.now();
    const hidden = Boolean(data.hidden);

    if (hidden) {
      session.hiddenSince = now;
    } else if (session.hiddenSince) {
      const wasHiddenFor = now - session.hiddenSince;
      session.hiddenSince = null;

      const alert = {
        socketId: socket.id,
        roomName: session.roomName,
        identity: session.identity,
        type: wasHiddenFor >= TAB_HIDDEN_ALERT_THRESHOLD_MS
          ? 'prolonged_absence'
          : 'tab_switch',
        durationMs: wasHiddenFor,
        timestamp: now,
      };
      pushAlert(session.roomName, alert);
      emitTelemetry(session.roomName, 'proctor:alert', alert);
      return;
    }

    // Always broadcast a lightweight visibility state event so the
    // admin can show "currently hidden" badges live.
    emitTelemetry(session.roomName, 'telemetry:visibility', {
      socketId: socket.id,
      roomName: session.roomName,
      identity: session.identity,
      hidden,
      timestamp: now,
    });
  });

  // ---- telemetry:snapshot_hash ----------------------------------
  // { hash: string, timestamp: number }
  socket.on('telemetry:snapshot_hash', (data) => {
    const session = socketToSession.get(socket.id);
    if (!session || !data || typeof data.hash !== 'string') return;
    // Only accept well-formed SHA-256 hex digests (64 hex chars).
    if (!/^[a-f0-9]{64}$/i.test(data.hash)) return;
    emitTelemetry(session.roomName, 'telemetry:snapshot_hash', {
      socketId: socket.id,
      roomName: session.roomName,
      identity: session.identity,
      hash: data.hash.toLowerCase(),
      timestamp: data.timestamp || Date.now(),
    });
  });

  // ---- chat:send -------------------------------------------------
  // Relayed room chat. Room and identity are stamped server-side from
  // the registered session (the payload text is the only trusted-here
  // field), length-capped and rate-limited, then fanned out to the
  // room's participants and the admin console.
  let chatTimes = [];
  socket.on('chat:send', (data) => {
    const session = socketToSession.get(socket.id);
    if (!session || !data) return;

    const text = typeof data.text === 'string' ? data.text.trim().slice(0, CHAT_MAX_LENGTH) : '';
    if (!text) return;

    // Rate limit: CHAT_MAX_PER_WINDOW messages per CHAT_WINDOW_MS.
    const now = Date.now();
    chatTimes = chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (chatTimes.length >= CHAT_MAX_PER_WINDOW) {
      socket.emit('chat:rate_limited', { retryAfterMs: CHAT_WINDOW_MS });
      return;
    }
    chatTimes.push(now);

    const msg = {
      socketId: socket.id,
      roomName: session.roomName,
      identity: session.identity,
      text,
      timestamp: now,
    };
    io.to(session.roomName).emit('chat:message', msg);
    io.to(ADMIN_ROOM).emit('chat:message', msg);
  });

  // ---- share:grant -----------------------------------------------
  // Host-controlled screen sharing. Admin sockets (dashboard) may grant
  // any room; instructor sockets only their own room. Students cannot.
  socket.on('share:grant', (data) => {
    const isAdmin = socket.handshake.isAdmin === true;
    const session = socketToSession.get(socket.id);
    const isInstructor = Boolean(session && session.role === 'instructor');
    if (!isAdmin && !isInstructor) return;
    if (!data || typeof data !== 'object') return;

    const roomName = typeof data.roomName === 'string' ? data.roomName.trim().slice(0, 128) : '';
    const identity = typeof data.identity === 'string' ? data.identity.trim().slice(0, 128) : '';
    if (!roomName || !identity) return;
    if (!isAdmin && session.roomName !== roomName) return; // instructors: own room only

    applyShareGrant(roomName, identity, Boolean(data.allow));
  });

  // ---- share:grantAll --------------------------------------------
  // Bulk grant/revoke every student currently in a room. Instructors
  // are untouched — they are always allowed by role.
  socket.on('share:grantAll', async (data) => {
    const isAdmin = socket.handshake.isAdmin === true;
    const session = socketToSession.get(socket.id);
    const isInstructor = Boolean(session && session.role === 'instructor');
    if (!isAdmin && !isInstructor) return;
    if (!data || typeof data !== 'object') return;

    const roomName = typeof data.roomName === 'string' ? data.roomName.trim().slice(0, 128) : '';
    if (!roomName) return;
    if (!isAdmin && session.roomName !== roomName) return;

    const allow = Boolean(data.allow);
    const room = ensureRoom(roomName);
    const students = participantsInRoom(roomName).filter((p) => p.role !== 'instructor');
    for (const p of students) {
      if (allow) room.sharers.add(p.identity);
      else room.sharers.delete(p.identity);
      await setLiveSharePermission(roomName, p.identity, allow);
      const event = {
        roomName,
        identity: p.identity,
        allowed: allow,
        enforcedByLiveKit: false, // events below carry the real flag
        timestamp: Date.now(),
      };
      io.to(roomName).emit('share:permission', event);
      io.to(ADMIN_ROOM).emit('share:permission', event);
    }
  });

  // ---- admin:join -----------------------------------------------
  // Admin dashboard subscribes to the broadcast channel and gets a
  // current state snapshot on connect. Refuse unless the socket was
  // authenticated by the io.use() middleware above.
  socket.on('admin:join', () => {
    if (!socket.handshake.isAdmin) {
      // Not a verified admin — silently ignore but log the attempt.
      console.warn('[admin] non-admin socket attempted admin:join:', socket.id);
      return;
    }
    socket.join(ADMIN_ROOM);
    const roomsSnapshot = Array.from(rooms.entries()).map(([name, r]) => ({
      name,
      participantCount: r.participantCount,
      alerts: r.alerts.slice(-50),
      sharers: Array.from(r.sharers || []),
      participants: participantsInRoom(name),
      createdAt: r.createdAt,
    }));
    socket.emit('admin:state', {
      rooms: roomsSnapshot,
      config: {
        maxParticipantsPerRoom: MAX_PARTICIPANTS_PER_ROOM,
        tabHiddenAlertThresholdMs: TAB_HIDDEN_ALERT_THRESHOLD_MS,
        snapshotIntervalMs: SNAPSHOT_INTERVAL_MS,
      },
      timestamp: Date.now(),
    });
  });

  // ---- mod:mute / mod:muteAll ------------------------------------
  // Instructor/admin moderation. Server-side mute of a participant's
  // audio tracks via LiveKit's MutePublishedTrack API, plus a targeted
  // socket event so the client UI reflects the forced state. Unmute
  // requests ask the client to re-enable its own mic (media capture
  // is user-controlled; the server cannot force it on).
  async function moderateMute(roomName, identity, mute) {
    const results = { livekitUpdated: false, tracksMuted: 0 };
    const svc = getRoomService();
    if (svc) {
      try {
        const participants = await svc.listParticipants(roomName);
        const target = participants.find((p) => p.identity === identity);
        if (target && Array.isArray(target.tracks)) {
          for (const track of target.tracks) {
            if (track.type === TrackType.AUDIO) {
              await svc.mutePublishedTrack(roomName, identity, track.sid, mute);
              results.tracksMuted++;
            }
          }
        }
        results.livekitUpdated = true;
      } catch (err) {
        console.warn(`[mod] mutePublishedTrack failed for ${identity}@${roomName}: ${err.message}`);
      }
    }
    // Targeted client event(s): every socket registered with this
    // identity in this room.
    for (const [socketId, sess] of socketToSession.entries()) {
      if (sess.roomName === roomName && sess.identity === identity) {
        io.to(socketId).emit('mod:muted', {
          roomName,
          muted: Boolean(mute),
          timestamp: Date.now(),
        });
      }
    }
    const notice = {
      roomName,
      identity,
      muted: Boolean(mute),
      enforcedByLiveKit: results.livekitUpdated,
      timestamp: Date.now(),
    };
    emitTelemetry(roomName, 'mod:notice', { action: 'mute', ...notice });
    io.to(ADMIN_ROOM).emit('mod:notice', { action: 'mute', ...notice });
    return results;
  }

  socket.on('mod:mute', (data) => {
    const isAdmin = socket.handshake.isAdmin === true;
    const session = socketToSession.get(socket.id);
    const isInstructor = Boolean(session && session.role === 'instructor');
    if (!isAdmin && !isInstructor) return;
    if (!data || typeof data !== 'object') return;
    const roomName = typeof data.roomName === 'string' ? data.roomName.trim().slice(0, 128) : '';
    const identity = typeof data.identity === 'string' ? data.identity.trim().slice(0, 128) : '';
    if (!roomName || !identity) return;
    if (!isAdmin && session.roomName !== roomName) return;
    moderateMute(roomName, identity, Boolean(data.mute));
  });

  socket.on('mod:muteAll', (data) => {
    const isAdmin = socket.handshake.isAdmin === true;
    const session = socketToSession.get(socket.id);
    const isInstructor = Boolean(session && session.role === 'instructor');
    if (!isAdmin && !isInstructor) return;
    if (!data || typeof data !== 'object') return;
    const roomName = typeof data.roomName === 'string' ? data.roomName.trim().slice(0, 128) : '';
    if (!roomName) return;
    if (!isAdmin && session.roomName !== roomName) return;
    const mute = Boolean(data.mute);
    participantsInRoom(roomName)
      .filter((p) => p.role !== 'instructor' && p.identity !== session.identity)
      .forEach((p) => moderateMute(roomName, p.identity, mute));
  });

  // ---- mod:kick ---------------------------------------------------
  // Instructor/admin removes a participant: LiveKit removeParticipant
  // disconnects their media, and a targeted socket event tells our UI
  // to show the "removed" overlay.
  socket.on('mod:kick', (data) => {
    const isAdmin = socket.handshake.isAdmin === true;
    const session = socketToSession.get(socket.id);
    const isInstructor = Boolean(session && session.role === 'instructor');
    if (!isAdmin && !isInstructor) return;
    if (!data || typeof data !== 'object') return;
    const roomName = typeof data.roomName === 'string' ? data.roomName.trim().slice(0, 128) : '';
    const identity = typeof data.identity === 'string' ? data.identity.trim().slice(0, 128) : '';
    if (!roomName || !identity) return;
    if (!isAdmin && session.roomName !== roomName) return;
    if (identity === session.identity) return; // don't kick yourself

    const svc = getRoomService();
    if (svc) {
      svc.removeParticipant(roomName, identity).catch((err) => {
        console.warn(`[mod] removeParticipant failed for ${identity}@${roomName}: ${err.message}`);
      });
    }
    for (const [socketId, sess] of socketToSession.entries()) {
      if (sess.roomName === roomName && sess.identity === identity) {
        io.to(socketId).emit('mod:kicked', {
          roomName,
          by: session ? session.identity : 'admin',
          timestamp: Date.now(),
        });
      }
    }
    const notice = {
      roomName,
      identity,
      kickedBy: session ? session.identity : 'admin',
      timestamp: Date.now(),
    };
    emitTelemetry(roomName, 'mod:notice', { action: 'kick', ...notice });
    io.to(ADMIN_ROOM).emit('mod:notice', { action: 'kick', ...notice });
  });

  // ---- session:end ------------------------------------------------
  // Instructor-only: end the session for EVERYONE. Disconnects all
  // LiveKit participants (deleteRoom), notifies the room and admin,
  // and clears the room's live state. Compare with plain "Leave",
  // which only exits the instructor's own session.
  socket.on('session:end', async (data) => {
    const session = socketToSession.get(socket.id);
    if (!session || session.role !== 'instructor') return;
    const roomName = data && typeof data.roomName === 'string'
      ? data.roomName.trim().slice(0, 128)
      : session.roomName;
    if (roomName !== session.roomName) return;
    // Double-end guard: claim the room synchronously so a second click
    // (or duplicate event arriving during the async LiveKit call below)
    // cannot re-broadcast.
    if (!rooms.has(roomName)) return;
    rooms.delete(roomName);

    console.log(`[session] ${session.identity} ended room=${roomName}`);
    io.to(roomName).emit('session:ended', {
      roomName,
      endedBy: session.identity,
      timestamp: Date.now(),
    });
    io.to(ADMIN_ROOM).emit('session:ended', {
      roomName,
      endedBy: session.identity,
      timestamp: Date.now(),
    });

    // Full teardown so nothing leaks into the NEXT session with the
    // same name: remove every socket from the socket.io room and drop
    // their session registrations (they must re-emit session:join).
    io.in(roomName).socketsLeave(roomName);
    for (const [socketId, sess] of Array.from(socketToSession.entries())) {
      if (sess.roomName === roomName) {
        socketToSession.delete(socketId);
      }
    }
    instructorSocketsByRoom.delete(roomName);

    // Force-disconnect every LiveKit participant (best-effort, after
    // local teardown; our clients have already left via the event).
    const svc = getRoomService();
    if (svc) {
      try {
        await svc.deleteRoom(roomName);
      } catch (err) {
        console.warn(`[session] LiveKit deleteRoom failed for ${roomName}: ${err.message}`);
      }
    }
  });

  // ---- disconnect -----------------------------------------------
  socket.on('disconnect', () => {
    const session = socketToSession.get(socket.id);
    console.log(`[io] disconnected socket=${socket.id}`);
    if (session) {
      // If they were hidden when they left, flush a final alert.
      if (session.hiddenSince) {
        const alert = {
          socketId: socket.id,
          roomName: session.roomName,
          identity: session.identity,
          type: 'prolonged_absence',
          durationMs: Date.now() - session.hiddenSince,
          timestamp: Date.now(),
          note: 'disconnected while hidden',
        };
        pushAlert(session.roomName, alert);
        emitTelemetry(session.roomName, 'proctor:alert', alert);
      }
      if (session.role === 'instructor') {
        // Remove the session from the registry FIRST so the live
        // instructor check inside removeInstructorSocket sees only
        // *other* remaining instructors.
        socketToSession.delete(socket.id);
        removeInstructorSocket(session.roomName, socket.id);
      }
      decrementRoomCount(session.roomName);
      io.to(ADMIN_ROOM).emit('session:leave', {
        socketId: socket.id,
        roomName: session.roomName,
        identity: session.identity,
        leftAt: Date.now(),
      });
      emitTelemetry(session.roomName, 'session:leave', {
        socketId: socket.id,
        roomName: session.roomName,
        identity: session.identity,
        leftAt: Date.now(),
      });
    }
    socketToSession.delete(socket.id);
  });
});

// ------------------------------------------------------------------
// Graceful shutdown
// ------------------------------------------------------------------
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] received ${signal}, closing gracefully…`);
  io.close(() => {
    server.close(() => {
      console.log('[shutdown] http server closed.');
      process.exit(0);
    });
  });
  // Hard exit after 10s if something is stuck
  setTimeout(() => {
    console.error('[shutdown] forcing exit after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// ------------------------------------------------------------------
// Start (only when run directly — importing this module for tests does
// not bind a port)
// ------------------------------------------------------------------
if (require.main === module) {
  // Optional HTTPS: set TLS_CERT + TLS_KEY to PEM file paths to serve
  // https directly (needed for camera/mic on phones without a proxy).
  const tlsCertPath = process.env.TLS_CERT || '';
  const tlsKeyPath = process.env.TLS_KEY || '';
  const useTls = Boolean(tlsCertPath && tlsKeyPath && fs.existsSync(tlsCertPath) && fs.existsSync(tlsKeyPath));

  const listenServer = useTls
    ? https.createServer({ cert: fs.readFileSync(tlsCertPath), key: fs.readFileSync(tlsKeyPath) }, app)
    : server;
  const scheme = useTls ? 'https' : 'http';

  listenServer.listen(PORT, () => {
    console.log('─────────────────────────────────────────────────────');
    console.log(`  livestream-proctor  ·  ${NODE_ENV}`);
    console.log(`  HTTP:           ${scheme}://localhost:${PORT}`);
    console.log(`  Student UI:     ${scheme}://localhost:${PORT}/`);
    console.log(`  Admin login:    ${scheme}://localhost:${PORT}/admin/login`);
    console.log(`  Admin UI:       ${scheme}://localhost:${PORT}/admin.html`);
    console.log(`  Health:         ${scheme}://localhost:${PORT}/health`);
    console.log(`  LiveKit URL:    ${LIVEKIT_URL}`);
    console.log(`  Max/room:       ${MAX_PARTICIPANTS_PER_ROOM}`);
    console.log(`  Screen share:   instructor-only until granted (host-controlled)`);
    console.log(`  Join gate:      ${REQUIRE_INSTRUCTOR_START ? 'students wait for instructor to start' : 'off (open joining)'}`);
    console.log(`  Instructor code: ${instructorCodeDigest ? 'required (set)' : 'NOT SET — instructor joining disabled'}`);
    console.log(`  CORS origin:    ${CORS_ORIGINS === '*' ? '*' : CORS_ORIGINS.join(', ')}`);
    console.log(`  Admin auth:     ${ADMIN_AUTH_SOURCE === 'none' ? 'DISABLED (set ADMIN_PASSWORD_HASH)' : 'enabled (' + ADMIN_AUTH_SOURCE + ')'}`);
    if (!useTls) {
      console.log('  TLS:            off (set TLS_CERT + TLS_KEY for https)');
    }
    console.log('─────────────────────────────────────────────────────');
  });
}

module.exports = { app, server, io };
