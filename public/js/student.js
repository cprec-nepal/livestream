  /* ================================================================
     Student classroom UI — LiveKit + lightweight proctoring
     ================================================================ */
  (function () {
    'use strict';

    // SDK global compat: the locally served UMD build (2.5.9) exposes
    // `LivekitClient`; the legacy CDN min build exposed `LiveKit`.
    window.LiveKit = window.LiveKit || window.LivekitClient;

    // --------------------------------------------------------------
    // DOM refs
    // --------------------------------------------------------------
    const $ = (id) => document.getElementById(id);
    const els = {
      joinScreen:    $('joinScreen'),
      classroom:     $('classroom'),
      name:          $('name'),
      room:          $('room'),
      joinBtn:       $('joinBtn'),
      joinError:     $('joinError'),
      deviceChip:    $('deviceChip'),
      connPill:      $('connPill'),
      roomName:      $('roomNameDisplay'),
      roomMeta:      $('roomMeta'),
      participantsCount: $('participantsCount'),
      videoGrid:     $('videoGrid'),
      micBtn:        $('micBtn'),
      camBtn:        $('camBtn'),
      leaveBtn:      $('leaveBtn'),
      infoIdentity:  $('infoIdentity'),
      infoRoom:      $('infoRoom'),
      infoDevice:    $('infoDevice'),
      infoProfile:   $('infoProfile'),
      infoLatency:   $('infoLatency'),
      telemetryLog:  $('telemetryLog'),
      snapshotCanvas: $('snapshot-canvas'),
      shareBtn:      $('shareBtn'),
      chatBtn:       $('chatBtn'),
      chatLog:       $('chatLog'),
      chatInput:     $('chatInput'),
      chatSend:      $('chatSend'),
      securityWarning: $('securityWarning'),
      instructorRole: $('instructorRole'),
    };

    // --------------------------------------------------------------
    // Device detection — drives the video profile
    // --------------------------------------------------------------
    const ua = navigator.userAgent || '';
    const isMobileUA = /Mobi|Android|iPhone|iPad|iPod|Windows Phone/i.test(ua);
    // Screen width < 768px counts as mobile (min-dimension also catches
    // landscape phones whose width alone would exceed 768px).
    const isSmallScreen = window.innerWidth < 768
      || Math.min(window.screen.width, window.screen.height) <= 768;
    const isMobile = isMobileUA || isSmallScreen;

    // Browsers block camera/mic + WebRTC (and crypto.subtle) on insecure
    // origins — e.g. http://192.168.x.x opened from a phone. localhost
    // counts as secure, so local use is unaffected.
    const isSecure = window.isSecureContext === true;
    if (!isSecure) {
      els.securityWarning.classList.add('show');
    }

    // Video profiles
    const PROFILES = {
      desktop: {
        label: '1280×720 @ 30fps',
        resolution: { width: 1280, height: 720, frameRate: 30 },
        audioOnly: false,
      },
      mobile: {
        label: '640×480 @ 15fps (audio-only default)',
        resolution: { width: 640, height: 480, frameRate: 15 },
        audioOnly: true,
      },
    };
    const profile = isMobile ? PROFILES.mobile : PROFILES.desktop;

    els.deviceChip.textContent = isMobile ? 'Mobile' : 'Desktop';
    els.deviceChip.classList.toggle('mobile', isMobile);

    // --------------------------------------------------------------
    // Socket.io — telemetry channel
    // --------------------------------------------------------------
    const socket = io({
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
    });

    let session = null;        // { roomName, identity, role, isMobile }
    let room = null;           // LiveKit Room instance
    let micEnabled = false;
    let camEnabled = false;
    let screenSharing = false;
    let pinnedTileId = null;   // pinned screen-share tile
    let currentRoom = null;    // room name filter for chat messages
    let lastSnapshotHash = null;
    let snapshotTimer = null;
    let snapshotDisabledNoteShown = false;

    // Screen sharing needs getDisplayMedia — unsupported on most
    // mobile browsers, so the button stays hidden there.
    const canScreenShare = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);

    // Host-managed screen sharing: instructors always can; students are
    // granted live by a host (admin dashboard / instructor) via the
    // share:permission socket event. Enforced server-side by token
    // grants + LiveKit participant permissions.
    let myRole = 'student';
    let shareAllowed = false;

    function updateShareButton() {
      const visible = Boolean(room) && canScreenShare && (myRole === 'instructor' || shareAllowed);
      els.shareBtn.hidden = !visible;
    }

    // --------------------------------------------------------------
    // Status pill helper
    // --------------------------------------------------------------
    function setStatus(state, text) {
      els.connPill.classList.remove('live', 'warn', 'err');
      if (state) els.connPill.classList.add(state);
      els.connPill.querySelector('.text').textContent = text;
    }

    // --------------------------------------------------------------
    // Telemetry log helper
    // --------------------------------------------------------------
    function logTelemetry(msg, level) {
      const now = new Date();
      const ts = now.toTimeString().slice(0, 8);
      const entry = document.createElement('div');
      entry.className = 'entry' + (level ? ' ' + level : '');
      entry.innerHTML = '<span class="ts">' + ts + '</span> ' + msg;
      els.telemetryLog.insertBefore(entry, els.telemetryLog.firstChild);
      // Cap log length
      while (els.telemetryLog.children.length > 60) {
        els.telemetryLog.removeChild(els.telemetryLog.lastChild);
      }
    }

    // --------------------------------------------------------------
    // Join flow
    // --------------------------------------------------------------
    els.joinBtn.addEventListener('click', joinSession);
    els.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') els.room.focus(); });
    els.room.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinSession(); });

    async function joinSession() {
      const identity = els.name.value.trim();
      const roomName = els.room.value.trim();
      els.joinError.classList.remove('show');

      if (!identity) { return showJoinError('Please enter your name.'); }
      if (!roomName) { return showJoinError('Please enter a room name.'); }
      if (typeof LiveKit === 'undefined') {
        return showJoinError('LiveKit SDK failed to load. Check your network connection.');
      }

      els.joinBtn.disabled = true;
      els.joinBtn.textContent = 'Connecting…';
      setStatus('warn', 'Requesting token');
      myRole = els.instructorRole && els.instructorRole.checked ? 'instructor' : 'student';

      try {
        const res = await fetch('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomName, identity, role: myRole }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || 'Token request failed');
        }
        setStatus('warn', 'Connecting to LiveKit');
        await connectLiveKit(data);
      } catch (err) {
        console.error('[join] failed', err);
        setStatus('err', 'Failed');
        showJoinError(err.message || 'Could not join the session.');
        els.joinBtn.disabled = false;
        els.joinBtn.textContent = 'Join session';
      }
    }

    function showJoinError(msg) {
      els.joinError.textContent = msg;
      els.joinError.classList.add('show');
    }

    // --------------------------------------------------------------
    // LiveKit connection
    // --------------------------------------------------------------
    async function connectLiveKit({ token, url, roomName, identity }) {
      const roomOpts = {
        adaptiveStream: true,    // ← required by spec
        dynacast: true,           // publishes layers on demand
        publishDefaults: {
          audioPreset: isMobile
            ? LiveKit.AudioPresets.speech
            : LiveKit.AudioPresets.music,
          audioBitrate: isMobile ? 12_000 : 32_000,
          videoSimulcastLayers: isMobile
            ? [LiveKit.VideoPresets.h90.encoding, LiveKit.VideoPresets.h216.encoding]
            : [LiveKit.VideoPresets.h180.encoding, LiveKit.VideoPresets.h360.encoding, LiveKit.VideoPresets.h720.encoding],
        },
      };

      room = new LiveKit.Room(roomOpts);

      // LiveKit event wiring
      room.on(LiveKit.RoomEvent.ParticipantConnected, onParticipantConnected);
      room.on(LiveKit.RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
      room.on(LiveKit.RoomEvent.TrackSubscribed, onTrackSubscribed);
      room.on(LiveKit.RoomEvent.TrackUnsubscribed, onTrackUnsubscribed);
      room.on(LiveKit.RoomEvent.LocalTrackPublished, onLocalTrackPublished);
      room.on(LiveKit.RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
      room.on(LiveKit.RoomEvent.Disconnected, onDisconnected);
      room.on(LiveKit.RoomEvent.Reconnecting, () => setStatus('warn', 'Reconnecting…'));
      room.on(LiveKit.RoomEvent.Reconnected, () => setStatus('live', 'Live'));
      room.on(LiveKit.RoomEvent.ActiveSpeakerChanged, onActiveSpeakerChanged);

      await room.connect(url, token);

      session = { roomName, identity, role: myRole, isMobile };
      currentRoom = roomName;
      els.joinScreen.style.display = 'none';
      els.classroom.classList.add('active');
      els.roomName.textContent = roomName;
      els.roomMeta.textContent = profile.label + (myRole === 'instructor' ? ' · instructor' : '');
      els.infoIdentity.textContent = identity;
      els.infoRoom.textContent = roomName;
      els.infoDevice.textContent = isMobile ? 'Mobile' : 'Desktop';
      els.infoProfile.textContent = profile.label;

      // Publish local tracks — mobile starts audio-only
      await publishLocalTracks();

      // Chat reset + notice; share button per host policy
      els.chatLog.innerHTML = '';
      addChatMessage({ text: 'Chat started — messages are visible to the session monitor.' }, false, true);
      shareAllowed = false; // fresh room state; instructors bypass below
      updateShareButton();

      // Wire up our socket.io session
      socket.emit('session:join', session);

      // Update participant counter
      updateParticipantsCount();

      setStatus('live', 'Live');
      logTelemetry('Connected to room <b>' + roomName + '</b>', 'ok');

      // Start telemetry collectors
      startVisibilityTracking();
      startSnapshotHashing();
    }

    async function publishLocalTracks() {
      try {
        // Always try mic first
        await room.localParticipant.setMicrophoneEnabled(true, {
          noiseSuppression: true,
          echoCancellation: true,
          autoGainControl: true,
        });
        micEnabled = true;
        els.micBtn.classList.add('active');
        els.micBtn.textContent = '🎙️ Mic on';

        // Camera: on desktop default ON, on mobile default OFF (audio-only)
        if (!profile.audioOnly) {
          await room.localParticipant.setCameraEnabled(true, {
            resolution: profile.resolution,
          });
          camEnabled = true;
          els.camBtn.classList.add('active');
          els.camBtn.textContent = '📷 Cam on';
        } else {
          els.camBtn.textContent = '📷 Enable camera';
        }
      } catch (err) {
        console.warn('[publish] failed', err);
        if (err && err.name === 'NotAllowedError') {
          logTelemetry('Camera/mic permission denied by user', 'err');
        }
      }
    }

    // --------------------------------------------------------------
    // Local + remote tile management
    // --------------------------------------------------------------
    function tileId(participantSid) { return 'tile-' + participantSid; }

    function ensureLocalTile() {
      const localSid = room.localParticipant.sid || room.localParticipant.identity;
      const id = tileId('local-' + localSid);
      let tile = document.getElementById(id);
      if (tile) return tile;

      tile = document.createElement('div');
      tile.id = id;
      tile.className = 'tile';
      tile.innerHTML =
        '<video muted playsinline autoplay></video>' +
        '<div class="label">You</div>' +
        '<div class="muted-badge">🔇</div>';
      els.videoGrid.appendChild(tile);

      // Attach local camera track if present (never the screen-share track)
      const videoEl = tile.querySelector('video');
      const camPub = Array.from(room.localParticipant.videoTrackPublications.values())
        .find((p) => p.track && !isScreenPub(p));
      if (camPub) {
        camPub.track.attach(videoEl);
        tile.classList.remove('audio-only');
      } else {
        showTileAsAudioOnly(tile, room.localParticipant.identity);
      }
      return tile;
    }

    function showTileAsAudioOnly(tile, label) {
      const initial = (label || '?').slice(0, 1).toUpperCase();
      tile.classList.add('audio-only');
      tile.innerHTML =
        '<div class="audio-avatar">' + initial + '</div>' +
        '<div class="label">' + escapeHtml(label) + '</div>' +
        '<div class="muted-badge">🔇</div>';
    }

    function onParticipantConnected(participant) {
      logTelemetry('Participant joined: ' + escapeHtml(participant.identity));
      ensureRemoteTile(participant);
      updateParticipantsCount();
    }

    function onParticipantDisconnected(participant) {
      const tile = document.getElementById(tileId(participant.sid));
      if (tile) tile.remove();
      logTelemetry('Participant left: ' + escapeHtml(participant.identity));
      updateParticipantsCount();
    }

    function ensureRemoteTile(participant) {
      const id = tileId(participant.sid);
      let tile = document.getElementById(id);
      if (tile) return tile;

      tile = document.createElement('div');
      tile.id = id;
      tile.className = 'tile remote';
      tile.innerHTML =
        '<video playsinline autoplay></video>' +
        '<div class="label">' + escapeHtml(participant.identity) + '</div>' +
        '<div class="muted-badge">🔇</div>';
      els.videoGrid.appendChild(tile);

      // Attach any already-published tracks
      let hasCameraVideo = false;
      participant.videoTrackPublications.forEach((pub) => {
        if (!pub.track) return;
        if (isScreenPub(pub)) {
          const st = ensureScreenTile(participant.sid, participant.identity, false);
          pub.track.attach(st.querySelector('video'));
        } else {
          hasCameraVideo = true;
          pub.track.attach(tile.querySelector('video'));
        }
      });
      participant.audioTrackPublications.forEach((pub) => {
        if (pub.track) pub.track.attach();
      });

      // If no camera video, show as audio-only tile
      if (!hasCameraVideo) {
        showTileAsAudioOnly(tile, participant.identity);
      }
      return tile;
    }

    function onTrackSubscribed(track, pub, participant) {
      if (track.kind === LiveKit.Track.Kind.Video) {
        // Screen-share tracks get their own highlighted tile
        if (isScreenPub(pub)) {
          const st = ensureScreenTile(participant.sid, participant.identity, false);
          track.attach(st.querySelector('video'));
          return;
        }
        const tile = ensureRemoteTile(participant);
        // Remove audio-only overlay
        tile.classList.remove('audio-only');
        if (!tile.querySelector('video')) {
          tile.innerHTML =
            '<video playsinline autoplay></video>' +
            '<div class="label">' + escapeHtml(participant.identity) + '</div>' +
            '<div class="muted-badge">🔇</div>';
        }
        track.attach(tile.querySelector('video'));
        // Mute badge state
        tile.classList.toggle('is-muted', pub.isMuted || false);
      } else if (track.kind === LiveKit.Track.Kind.Audio) {
        track.attach();
        const tile = ensureRemoteTile(participant);
        tile.classList.toggle('is-muted', pub.isMuted || false);
      }
    }

    function onTrackUnsubscribed(track, pub, participant) {
      // Screen share ended — drop its tile, keep the camera tile intact
      if (isScreenPub(pub)) {
        const st = document.getElementById('tile-screen-' + participant.sid);
        if (st) st.remove();
        return;
      }
      const tile = document.getElementById(tileId(participant.sid));
      if (!tile) return;
      if (track.kind === LiveKit.Track.Kind.Video) {
        track.detach(tile.querySelector('video'));
        showTileAsAudioOnly(tile, participant.identity);
      } else if (track.kind === LiveKit.Track.Kind.Audio) {
        track.detach();
      }
    }

    // --------------------------------------------------------------
    // Screen sharing (desktop browsers with getDisplayMedia only)
    // --------------------------------------------------------------
    function isScreenPub(pub) {
      return !!pub && pub.source === LiveKit.Track.Source.ScreenShare;
    }

    function ensureScreenTile(sid, label, self) {
      const id = 'tile-screen-' + sid;
      let tile = document.getElementById(id);
      if (!tile) {
        tile = document.createElement('div');
        tile.id = id;
        tile.className = 'tile remote screen-share';
        tile.innerHTML =
          '<video playsinline autoplay></video>' +
          '<div class="label">🖥️ ' + escapeHtml(label) + (self ? ' (you)' : '') + '</div>' +
          '<div class="tile-controls">' +
            '<button type="button" class="tc-pin" title="Pin this screen to the main stage">📌 Pin</button>' +
            '<button type="button" class="tc-fs" title="Fullscreen">⛶</button>' +
          '</div>';
        els.videoGrid.appendChild(tile);

        // Click tile (not its buttons) to pin/unpin
        tile.addEventListener('click', (ev) => {
          if (ev.target.closest('.tile-controls')) return;
          setPinned(tile.id === pinnedTileId ? null : tile.id);
        });
        tile.querySelector('.tc-pin').addEventListener('click', () =>
          setPinned(tile.id === pinnedTileId ? null : tile.id));
        tile.querySelector('.tc-fs').addEventListener('click', () => {
          const video = tile.querySelector('video');
          if (!video) return;
          if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
          } else if (video.requestFullscreen) {
            video.requestFullscreen().catch(() => {});
          }
        });
      }
      return tile;
    }

    // Pin one screen-share tile as the big stage; everything else
    // shrinks into a filmstrip below (CSS via .has-pinned/.pinned).
    function setPinned(tileId) {
      pinnedTileId = tileId || null;
      const grid = els.videoGrid;
      grid.querySelectorAll('.tile.pinned').forEach((t) => t.classList.remove('pinned'));
      grid.classList.toggle('has-pinned', Boolean(pinnedTileId));
      if (pinnedTileId) {
        const tile = document.getElementById(pinnedTileId);
        if (tile) {
          tile.classList.add('pinned');
          const btn = tile.querySelector('.tc-pin');
          if (btn) btn.textContent = '📌 Unpin';
        }
      }
      grid.querySelectorAll('.tile.screen-share:not(.pinned) .tc-pin').forEach((b) => {
        b.textContent = '📌 Pin';
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && pinnedTileId) setPinned(null);
    });

    function onLocalTrackPublished(pub) {
      if (!isScreenPub(pub) || !pub.track) return;
      screenSharing = true;
      els.shareBtn.textContent = '🖥️ Stop sharing';
      els.shareBtn.classList.add('sharing');
      const tile = ensureScreenTile('local', 'Your screen', true);
      pub.track.attach(tile.querySelector('video'));
      logTelemetry('Screen sharing started');
    }

    function onLocalTrackUnpublished(pub) {
      if (!isScreenPub(pub)) return;
      screenSharing = false;
      els.shareBtn.textContent = '🖥️ Share screen';
      els.shareBtn.classList.remove('sharing');
      const tile = document.getElementById('tile-screen-local');
      if (tile) tile.remove();
      logTelemetry('Screen sharing stopped');
    }

    els.shareBtn.addEventListener('click', async () => {
      if (!room || !canScreenShare) return;
      try {
        await room.localParticipant.setScreenShareEnabled(!screenSharing);
        // Button state updates arrive via Local(Un)Published events above
      } catch (err) {
        logTelemetry('Screen share failed: ' + escapeHtml((err && err.message) || 'unknown error'), 'err');
      }
    });

    function onActiveSpeakerChanged(speakers) {
      // Light visual nudge — bump the first speaker's tile
      const tiles = els.videoGrid.querySelectorAll('.tile');
      tiles.forEach(t => t.style.boxShadow = '');
      if (speakers && speakers.length > 0) {
        const sid = speakers[0].sid;
        const tile = document.getElementById(tileId(sid))
                 || ensureLocalTile();
        if (tile) tile.style.boxShadow = '0 0 0 2px var(--accent)';
      }
    }

    function onDisconnected() {
      setStatus('err', 'Disconnected');
      logTelemetry('Disconnected from room', 'err');
      stopSnapshotHashing();
      // Reset share/chat state for the next session
      screenSharing = false;
      currentRoom = null;
      shareAllowed = false;
      setPinned(null);
      els.shareBtn.hidden = true;
      els.shareBtn.textContent = '🖥️ Share screen';
      els.shareBtn.classList.remove('sharing');
    }

    function updateParticipantsCount() {
      const n = room ? room.numParticipants : 0;
      els.participantsCount.textContent = n + ' participant' + (n === 1 ? '' : 's');
    }

    // --------------------------------------------------------------
    // Host-managed screen share permissions
    // --------------------------------------------------------------
    socket.on('share:permission', (event) => {
      if (!event || event.roomName !== currentRoom || !session) return;
      // Instructors always keep the right; events about other users don't
      // affect our own button.
      if (event.identity === session.identity) {
        if (myRole !== 'instructor') {
          shareAllowed = Boolean(event.allowed);
          if (!shareAllowed && screenSharing) {
            // Revoked mid-share — LiveKit also enforces server-side.
            room.localParticipant.setScreenShareEnabled(false).catch(() => {});
          }
        } else {
          shareAllowed = true;
        }
        updateShareButton();
        if (myRole !== 'instructor') {
          logTelemetry(
            shareAllowed
              ? 'Instructor allowed you to share your screen'
              : 'Screen sharing revoked by instructor'
          );
        }
      }
    });

    // --------------------------------------------------------------
    // Room chat — relayed by our server over Socket.io. Room and
    // identity are stamped server-side; the client only sends text.
    // --------------------------------------------------------------
    socket.on('chat:message', (msg) => {
      if (!msg || typeof msg.text !== 'string') return;
      if (!currentRoom || msg.roomName !== currentRoom) return;
      const self = msg.socketId && msg.socketId === socket.id;
      addChatMessage(msg, self, false);
    });

    socket.on('chat:rate_limited', () => {
      addChatMessage({ text: 'Sending too fast — please wait a moment.' }, false, true);
    });

    function sendChat() {
      const text = els.chatInput.value.trim();
      if (!text || !currentRoom) return;
      socket.emit('chat:send', { text: text.slice(0, 500) });
      els.chatInput.value = '';
      els.chatInput.focus();
    }

    function addChatMessage(msg, self, system) {
      const div = document.createElement('div');
      div.className = 'chat-msg' + (self ? ' self' : '') + (system ? ' system' : '');
      if (system) {
        div.textContent = msg.text;
      } else {
        const when = new Date(msg.timestamp || Date.now()).toTimeString().slice(0, 5);
        div.innerHTML =
          '<span class="who">' + escapeHtml(self ? 'You' : msg.identity || '?') + '</span>' +
          escapeHtml(msg.text) +
          '<span class="when">' + when + '</span>';
      }
      els.chatLog.appendChild(div);
      while (els.chatLog.children.length > 200) {
        els.chatLog.removeChild(els.chatLog.firstChild);
      }
      els.chatLog.scrollTop = els.chatLog.scrollHeight;
    }

    els.chatSend.addEventListener('click', sendChat);
    els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    els.chatBtn.addEventListener('click', () => {
      const panel = els.chatLog.closest('.panel');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      els.chatInput.focus({ preventScroll: true });
    });

    // --------------------------------------------------------------
    // Mic / cam / leave controls
    // --------------------------------------------------------------
    els.micBtn.addEventListener('click', async () => {
      if (!room) return;
      try {
        micEnabled = !micEnabled;
        await room.localParticipant.setMicrophoneEnabled(micEnabled);
        els.micBtn.classList.toggle('active', micEnabled);
        els.micBtn.textContent = micEnabled ? '🎙️ Mic on' : '🎙️ Mic off';
        // Update local tile muted badge
        const localTile = ensureLocalTile();
        localTile.classList.toggle('is-muted', !micEnabled);
        logTelemetry('Microphone ' + (micEnabled ? 'enabled' : 'muted'));
      } catch (err) {
        micEnabled = !micEnabled;
        logTelemetry('Mic toggle failed: ' + err.message, 'err');
      }
    });

    els.camBtn.addEventListener('click', async () => {
      if (!room) return;
      try {
        camEnabled = !camEnabled;
        await room.localParticipant.setCameraEnabled(camEnabled, {
          resolution: profile.resolution,
        });
        els.camBtn.classList.toggle('active', camEnabled);
        els.camBtn.textContent = camEnabled ? '📷 Cam on' : '📷 Cam off';
        const localTile = ensureLocalTile();
        if (camEnabled) {
          localTile.classList.remove('audio-only');
          const videoEl = localTile.querySelector('video');
          const pub = Array.from(room.localParticipant.videoTrackPublications.values())[0];
          if (pub && pub.track && videoEl) pub.track.attach(videoEl);
        } else {
          showTileAsAudioOnly(localTile, room.localParticipant.identity);
        }
        logTelemetry('Camera ' + (camEnabled ? 'enabled' : 'disabled'));
      } catch (err) {
        camEnabled = !camEnabled;
        logTelemetry('Camera toggle failed: ' + err.message, 'err');
      }
    });

    els.leaveBtn.addEventListener('click', () => {
      if (room) room.disconnect();
      socket.disconnect();
      els.classroom.classList.remove('active');
      els.joinScreen.style.display = '';
      els.joinBtn.disabled = false;
      els.joinBtn.textContent = 'Join session';
      els.videoGrid.innerHTML = '';
      setStatus(null, 'Idle');
      logTelemetry('Left session');
    });

    // --------------------------------------------------------------
    // Proctoring: visibility tracking (document.visibilitychange)
    // --------------------------------------------------------------
    function startVisibilityTracking() {
      document.addEventListener('visibilitychange', onVisibilityChange);
      // Initial state
      if (document.hidden) onVisibilityChange();
    }

    function onVisibilityChange() {
      const hidden = document.hidden;
      socket.emit('telemetry:visibility', { hidden, timestamp: Date.now() });
      logTelemetry(
        hidden ? 'Tab switched away — flagged' : 'Tab returned to focus',
        hidden ? 'warn' : 'ok'
      );
    }

    // --------------------------------------------------------------
    // Proctoring: canvas snapshot hashing via requestIdleCallback
    //   - 64×48 offscreen canvas
    //   - SHA-256 of pixel data
    //   - only the hash is sent (no images)
    //   - work scheduled in idle time, never blocks the main thread
    // --------------------------------------------------------------
    // Snapshot cadence comes from the server (SNAPSHOT_INTERVAL_MS env
    // var, exposed via GET /api/config). Falls back to 30s if the
    // request fails or the value is unusable.
    let snapshotIntervalMs = 30000;
    fetch('/api/config')
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        const ms = cfg && parseInt(cfg.snapshotIntervalMs, 10);
        if (Number.isFinite(ms) && ms >= 5000) snapshotIntervalMs = ms;
      })
      .catch(() => { /* keep default */ });

    function startSnapshotHashing() {
      stopSnapshotHashing();
      snapshotTimer = setInterval(scheduleSnapshot, snapshotIntervalMs);
      // Also fire one shortly after connect
      setTimeout(scheduleSnapshot, 4000);
    }

    function stopSnapshotHashing() {
      if (snapshotTimer) {
        clearInterval(snapshotTimer);
        snapshotTimer = null;
      }
    }

    // requestIdleCallback with setTimeout(fn, 100) fallback (Safari < 17).
    // Snapshot hashing MUST never block the main thread.
    const ric = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback
      : function (cb) { return setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 100); };
    const cic = typeof window.cancelIdleCallback === 'function'
      ? window.cancelIdleCallback
      : function (id) { clearTimeout(id); };

    let pendingIdleHandle = null;
    function scheduleSnapshot() {
      if (pendingIdleHandle != null) return; // already scheduled
      pendingIdleHandle = ric(async (deadline) => {
        pendingIdleHandle = null;
        // If we're pressed for time, skip this round
        if (deadline.timeRemaining && deadline.timeRemaining() < 4) return;
        try {
          const hash = await captureSnapshotHash();
          if (hash && hash !== lastSnapshotHash) {
            lastSnapshotHash = hash;
            socket.emit('telemetry:snapshot_hash', { hash, timestamp: Date.now() });
            logTelemetry('Snapshot hash sent (' + hash.slice(0, 8) + '…)');
          }
        } catch (err) {
          // Non-fatal — proctoring is best-effort
          console.warn('[snapshot] hash failed', err);
        }
      }, { timeout: 5000 });
    }

    async function captureSnapshotHash() {
      const canvas = els.snapshotCanvas;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      // Find a video source — local first, then any remote participant video
      let sourceVideo = null;
      const localTile = document.getElementById(tileId('local-' + (room?.localParticipant?.sid || room?.localParticipant?.identity)));
      if (localTile) sourceVideo = localTile.querySelector('video');
      if (!sourceVideo || !sourceVideo.videoWidth) {
        const remoteVideos = els.videoGrid.querySelectorAll('.tile.remote video');
        for (const v of remoteVideos) {
          if (v.videoWidth > 0) { sourceVideo = v; break; }
        }
      }
      if (!sourceVideo || !sourceVideo.videoWidth) return null;

      // Draw at the tiny 64×48 size
      try {
        ctx.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
      } catch (err) {
        // CORS-tainted or otherwise unavailable — skip
        return null;
      }

      // Read pixels — this can throw if the source is cross-origin and tainted
      let imageData;
      try {
        imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      } catch (err) {
        return null;
      }

      // SHA-256 hash the pixel buffer (works on Uint8ClampedArray).
      // crypto.subtle only exists in secure contexts — on insecure
      // origins (http over LAN) snapshot hashing is skipped.
      if (!window.crypto || !window.crypto.subtle || !window.isSecureContext) {
        if (!snapshotDisabledNoteShown) {
          snapshotDisabledNoteShown = true;
          logTelemetry('Snapshot hashing disabled (requires HTTPS)', 'err');
        }
        return null;
      }
      const hashBuf = await crypto.subtle.digest('SHA-256', imageData.data);
      const hashArr = Array.from(new Uint8Array(hashBuf));
      return hashArr.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    // --------------------------------------------------------------
    // Latency monitor (best-effort, uses LiveKit quality stats)
    // --------------------------------------------------------------
    setInterval(async () => {
      if (!room) return;
      try {
        const stats = await room.getNetworkStatistics();
        const ms = stats?.publisher?.rtt ?? stats?.subscriber?.rtt;
        if (typeof ms === 'number') {
          els.infoLatency.textContent = ms + ' ms';
        }
      } catch (e) { /* ignore */ }
    }, 5000);

    // --------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    // Initial state
    setStatus(null, 'Idle');

    // Prefill room from ?room= query param, if present
    const params = new URLSearchParams(window.location.search);
    const presetRoom = params.get('room');
    if (presetRoom) els.room.value = presetRoom;
    const presetName = params.get('name');
    if (presetName) els.name.value = presetName;
  })();
