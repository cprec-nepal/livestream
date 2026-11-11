/**
 * Functional socket tests — classroom flow + moderation.
 * Run: node tests/socket-flows.js   (server must be on PORT, default 3100,
 * started with REQUIRE_INSTRUCTOR_START=true and INSTRUCTOR_CODE set)
 *
 * Exits 0 when all assertions pass, 1 otherwise.
 */
const path = require('path');
const { io } = require(path.join(__dirname, '..', 'node_modules', 'socket.io-client'));

const PORT = process.env.PORT || 3100;
const BASE = `http://localhost:${PORT}`;
const INSTRUCTOR_CODE = process.env.INSTRUCTOR_CODE || 'test-instructor-code';

const results = [];
const check = (name, cond) => results.push([name, !!cond]);
const waitFor = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(extra) { return io(BASE, { transports: ['websocket'], ...extra }); }

async function token(room, identity, role, code) {
  const body = { roomName: room, identity, role };
  if (code) body.code = code;
  const res = await fetch(BASE + '/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function main() {
  // ---- 1. Join gate ---------------------------------------------
  const before = await token('class-room', 'alice', 'student');
  check('student token blocked before instructor (403)', before.status === 403 && before.data.code === 'SESSION_NOT_STARTED');

  const inst = connect();
  const instTelemetry = [];
  inst.on('telemetry:event', (e) => instTelemetry.push(e));
  await new Promise((r) => inst.on('connect', r));
  inst.emit('session:join', { roomName: 'class-room', identity: 'teach', role: 'instructor', isMobile: false });
  inst.emit('telemetry:subscribe');
  await waitFor(300);

  check('student token allowed after instructor joins', (await token('class-room', 'alice', 'student')).status === 200);

  const s1 = connect();
  let endedEvents = 0;
  s1.on('session:ended', () => endedEvents++);
  await new Promise((r) => s1.on('connect', r));
  s1.emit('session:join', { roomName: 'class-room', identity: 'alice', role: 'student', isMobile: false });
  await waitFor(300);

  // ---- 2. Telemetry relay (instructor-scoped) ---------------------
  s1.emit('telemetry:visibility', { hidden: true, timestamp: Date.now() });
  await waitFor(250);
  s1.emit('telemetry:visibility', { hidden: false, timestamp: Date.now() });
  await waitFor(300);
  check('instructor receives visibility relay', instTelemetry.some((e) => e.type === 'telemetry:visibility' && e.identity === 'alice'));
  check('relay carries roomName for filtering', instTelemetry.every((e) => e.roomName === 'class-room'));

  // ---- 3. Moderation permissions ---------------------------------
  let s1Muted = null, s1Kicked = null;
  s1.on('mod:muted', (e) => { s1Muted = e; });
  s1.on('mod:kicked', (e) => { s1Kicked = e; });
  s1.emit('mod:mute', { roomName: 'class-room', identity: 'teach', mute: true });
  await waitFor(400);
  check('student cannot mod-mute', !s1Muted);

  inst.emit('mod:mute', { roomName: 'class-room', identity: 'alice', mute: true });
  await waitFor(400);
  check('instructor mute reaches student', s1Muted && s1Muted.muted === true);
  inst.emit('mod:mute', { roomName: 'class-room', identity: 'alice', mute: false });
  await waitFor(400);
  check('instructor unmute reaches student', s1Muted && s1Muted.muted === false);

  inst.emit('mod:mute', { roomName: 'other-room', identity: 'x', mute: true });
  await waitFor(300);
  check('instructor cannot moderate other rooms', !instTelemetry.some((e) => e.roomName === 'other-room'));

  // ---- 4. End session: single broadcast + clean teardown ---------
  inst.emit('session:end', { roomName: 'class-room' });
  inst.emit('session:end', { roomName: 'class-room' }); // double-click
  await waitFor(600);
  check('double end-click delivers exactly ONE session:ended', endedEvents === 1);

  let chatLeak = 0;
  s1.on('chat:message', () => chatLeak++);
  s1.emit('chat:send', { text: 'dropped — deregistered' });
  await waitFor(400);
  check('post-end chat from old sockets is dropped', chatLeak === 0);

  // ---- 5. Room reuse after end -----------------------------------
  check('re-created room gated again (fresh state)', (await token('class-room', 'bob', 'student')).status === 403);
  const inst2 = connect();
  let inst2Ended = 0;
  inst2.on('session:ended', () => inst2Ended++);
  await new Promise((r) => inst2.on('connect', r));
  inst2.emit('session:join', { roomName: 'class-room', identity: 'teach2', role: 'instructor', isMobile: false });
  await waitFor(300);
  check('same-name room reusable after instructor rejoins', (await token('class-room', 'carol', 'student')).status === 200);

  // ---- 6. Students cannot end ------------------------------------
  const s2 = connect();
  await new Promise((r) => s2.on('connect', r));
  s2.emit('session:join', { roomName: 'class-room', identity: 'eve', role: 'student', isMobile: false });
  await waitFor(300);
  s2.emit('session:end', { roomName: 'class-room' });
  await waitFor(400);
  check('student cannot end session', inst2Ended === 0);

  // ---- 7. Kick ----------------------------------------------------
  let eveKicked = false;
  s2.on('mod:kicked', () => { eveKicked = true; });
  inst2.emit('mod:kick', { roomName: 'class-room', identity: 'eve' });
  await waitFor(400);
  check('kicked student receives mod:kicked', eveKicked);

  inst.disconnect(); inst2.disconnect(); s1.disconnect(); s2.disconnect();
  await waitFor(200);

  let pass = 0, fail = 0;
  for (const [name, ok] of results) { console.log((ok ? '  ✓ ' : '  ✗ ') + name); ok ? pass++ : fail++; }
  console.log(`\nSocket flow tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
