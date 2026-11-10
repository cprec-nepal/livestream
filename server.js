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
const crypto = require('crypto');          // for timingSafeEqual in admin auth
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');       // for admin session cookies
const cookieParser = require('cookie-parser');
const { Server: SocketIOServer } = require('socket.io');
const { AccessToken } = require('livekit-server-sdk');

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3000', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'YOUR_LIVEKIT_API_KEY';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'YOUR_LIVEKIT_API_SECRET';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://your-livekit-server.example.com';

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

const CORS_ORIGIN_RAW = process.env.CORS_ORIGIN || '*';
const CORS_ORIGINS = CORS_ORIGIN_RAW === '*'
  ? '*'
  : CORS_ORIGIN_RAW.split(',').map(s => s.trim()).filter(Boolean);

const TOKEN_TTL_MINUTES = 120; // 2 hours

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
      createdAt: Date.now(),
    });
  }
  return rooms.get(roomName);
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
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        // LiveKit client SDK via jsDelivr CDN (single-file HTML UI)
        'https://cdn.jsdelivr.net',
      ],
      // socket.io + LiveKit must talk back over secure channels
      connectSrc: ["'self'", 'wss:', 'https:'],
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
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  extensions: ['html'],
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
app.get('/api/config', (req, res) => {
  res.json({
    maxParticipantsPerRoom: MAX_PARTICIPANTS_PER_ROOM,
    tabHiddenAlertThresholdMs: TAB_HIDDEN_ALERT_THRESHOLD_MS,
    snapshotIntervalMs: SNAPSHOT_INTERVAL_MS,
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

    // Capacity check — only students count against the cap, instructors
    // are always allowed in (they need to start the session).
    if (safeRole === 'student') {
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

    io.to(ADMIN_ROOM).emit('session:join', {
      socketId: socket.id,
      ...session,
    });
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
      io.to(ADMIN_ROOM).emit('proctor:alert', alert);
      return;
    }

    // Always broadcast a lightweight visibility state event so the
    // admin can show "currently hidden" badges live.
    io.to(ADMIN_ROOM).emit('telemetry:visibility', {
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
    io.to(ADMIN_ROOM).emit('telemetry:snapshot_hash', {
      socketId: socket.id,
      roomName: session.roomName,
      identity: session.identity,
      hash: data.hash.toLowerCase(),
      timestamp: data.timestamp || Date.now(),
    });
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
        io.to(ADMIN_ROOM).emit('proctor:alert', alert);
      }
      decrementRoomCount(session.roomName);
      io.to(ADMIN_ROOM).emit('session:leave', {
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
  server.listen(PORT, () => {
    console.log('─────────────────────────────────────────────────────');
    console.log(`  livestream-proctor  ·  ${NODE_ENV}`);
    console.log(`  HTTP:           http://localhost:${PORT}`);
    console.log(`  Student UI:     http://localhost:${PORT}/`);
    console.log(`  Admin login:    http://localhost:${PORT}/admin/login`);
    console.log(`  Admin UI:       http://localhost:${PORT}/admin.html`);
    console.log(`  Health:         http://localhost:${PORT}/health`);
    console.log(`  LiveKit URL:    ${LIVEKIT_URL}`);
    console.log(`  Max/room:       ${MAX_PARTICIPANTS_PER_ROOM}`);
    console.log(`  CORS origin:    ${CORS_ORIGINS === '*' ? '*' : CORS_ORIGINS.join(', ')}`);
    console.log(`  Admin auth:     ${ADMIN_AUTH_SOURCE === 'none' ? 'DISABLED (set ADMIN_PASSWORD_HASH)' : 'enabled (' + ADMIN_AUTH_SOURCE + ')'}`);
    console.log('─────────────────────────────────────────────────────');
  });
}

module.exports = { app, server, io };
