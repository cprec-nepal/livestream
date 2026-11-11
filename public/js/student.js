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
      instructorCodeField: $('instructorCodeField'),
      instructorCode: $('instructorCode'),
      chatPanel:      $('chatPanel'),
      chatBody:       $('chatBody'),
      chatUnread:     $('chatUnread'),
      endBtn:         $('endBtn'),
      instructorStrip: $('instructorStrip'),
      stripParticipants: $('stripParticipants'),
      stripHidden:    $('stripHidden'),
      stripTabSwitches: $('stripTabSwitches'),
      stripAbsences:  $('stripAbsences'),
      stripLatest:    $('stripLatest'),
      endedOverlay:   $('endedOverlay'),
      endedBackBtn:   $('endedBackBtn'),
      reconnectBanner: $('reconnectBanner'),
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

    // Mobile users can opt into video (uses more data)
    let mobileVideoOptIn = false;
    if (isMobile) {
      const row = document.getElementById('mobileVideoRow');
      const box = document.getElementById('mobileVideo');
      if (row && box) {
        row.hidden = false;
        box.addEventListener('change', () => { mobileVideoOptIn = box.checked; });
      }
    }

    // WebRTC support check — friendly message in unsupported browsers
    if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
      els.securityWarning.classList.add('show');
      els.securityWarning.innerHTML =
        '<strong>⚠️ Live video is not supported by this browser.</strong> Please use the latest version of Chrome, Firefox, or Safari to join the classroom.';
    }

    // Browsers block camera/mic + WebRTC (and crypto.subtle) on insecure
    // origins — e.g. http://192.168.x.x opened from a phone. localhost
    // counts as secure, so local use is unaffected.
    const isSecure = window.isSecureContext === true;
    if (!isSecure) {
      els.securityWarning.classList.add('show');
    }

    // Instructor code field appears only when joining as host
    if (els.instructorRole && els.instructorCodeField) {
      els.instructorRole.addEventListener('change', () => {
        els.instructorCodeField.hidden = !els.instructorRole.checked;
        if (els.instructorRole.checked) els.instructorCode.focus();
      });
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

    // Chat panel state (collapsible; moves into fullscreen overlay)
    let chatOpen = true;
    let unreadCount = 0;

    // Instructor strip stats (reset per session)
    let stripStats = { tabSwitches: 0, absences: 0 };

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
      els.joinBtn.classList.add('loading');
      els.joinBtn.textContent = 'Joining…';
      setStatus('warn', 'Requesting token');
      myRole = els.instructorRole && els.instructorRole.checked ? 'instructor' : 'student';

      try {
        const payload = { roomName, identity, role: myRole };
        if (myRole === 'instructor') {
          payload.code = els.instructorCode ? els.instructorCode.value.trim() : '';
        }
        const res = await fetch('/api/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
          // Specific, user-friendly messaging per failure type
          if (data.code === 'SESSION_NOT_STARTED') {
            throw new Error('The session has not started yet — please wait for your instructor to join.');
          }
          if (/instructor code/i.test(data.error || '')) {
            throw new Error('Invalid instructor code. Please check the code and try again.');
          }
          throw new Error(data.error || 'Token request failed');
        }
        setStatus('warn', 'Connecting to LiveKit');
        await connectLiveKit(data);
      } catch (err) {
        console.error('[join] failed', err);
        setStatus('err', 'Failed');
        const networkFail = err instanceof TypeError; // fetch() itself failed
        showJoinError(networkFail
          ? 'Connection failed. Please check your internet and try again.'
          : (err.message || 'Could not join the session.'));
        els.joinBtn.disabled = false;
        els.joinBtn.classList.remove('loading');
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
      room.on(LiveKit.RoomEvent.Reconnecting, () => {
        setStatus('warn', 'Reconnecting…');
        els.reconnectBanner.classList.add('show');
      });
      room.on(LiveKit.RoomEvent.Reconnected, () => {
        setStatus('live', 'Live');
        els.reconnectBanner.classList.remove('show');
      });
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
      unreadCount = 0;
      updateChatBadge();
      setChatOpen(true);
      addChatMessage(
        { text: myRole === 'instructor'
          ? 'Chat started — messages are visible to the session monitor.'
          : 'Chat started.' },
        false,
        true
      );
      shareAllowed = false; // fresh room state; instructors bypass below
      updateShareButton();

      // Role-scoped UI: students see no proctoring UI at all;
      // instructors get the live strip + End session control.
      const isInstructor = myRole === 'instructor';
      els.telemetryPanel.hidden = !isInstructor;
      els.instructorStrip.hidden = !isInstructor;
      els.endBtn.hidden = !isInstructor;
      if (isInstructor) {
        stripStats = { tabSwitches: 0, absences: 0 };
        els.stripTabSwitches.textContent = '0';
        els.stripAbsences.textContent = '0';
        els.stripLatest.textContent = 'monitoring…';
      }

      // Wire up our socket.io session
      socket.emit('session:join', session);
      if (isInstructor) socket.emit('telemetry:subscribe');

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

    // Pin/fullscreen controls — available on EVERY video tile for every
    // participant. Pinning is purely local: each viewer pins what they
    // see without affecting anyone else.
    const TILE_CONTROLS_HTML =
      '<div class="tile-controls">' +
        '<button type="button" class="tc-pin" title="Pin this video to the main stage">📌 Pin</button>' +
        '<button type="button" class="tc-fs" title="Fullscreen">⛶</button>' +
      '</div>';

    // Instructor-only moderation controls on remote tiles
    const MOD_CONTROLS_HTML =
      '<div class="mod-controls">' +
        '<button type="button" class="mc-mute" title="Mute or unmute this participant">🎤</button>' +
        '<button type="button" class="mc-kick" title="Remove from session">👋</button>' +
      '</div>';

    function attachModControls(tile, identity) {
      if (myRole !== 'instructor') return;
      tile.classList.add('with-mod');
      const muteBtn = tile.querySelector('.mc-mute');
      const kickBtn = tile.querySelector('.mc-kick');
      if (!muteBtn || !kickBtn) return;
      const refresh = () => {
        muteBtn.textContent = mutedIdentities.has(identity) ? '🔇' : '🎤';
        muteBtn.title = mutedIdentities.has(identity)
          ? 'Ask this participant to unmute'
          : 'Mute this participant';
      };
      refresh();
      muteBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const mute = !mutedIdentities.has(identity);
        if (mute) mutedIdentities.add(identity); else mutedIdentities.delete(identity);
        refresh();
        socket.emit('mod:mute', { roomName: currentRoom, identity, mute });
      });
      kickBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (!confirm('Remove ' + identity + ' from this session?')) return;
        socket.emit('mod:kick', { roomName: currentRoom, identity });
      });
    }

    function attachTileControls(tile) {
      const pinBtn = tile.querySelector('.tc-pin');
      const fsBtn = tile.querySelector('.tc-fs');
      if (!pinBtn || !fsBtn) return;
      // Clicking the tile body (not the buttons) toggles pin
      tile.addEventListener('click', (ev) => {
        if (ev.target.closest('.tile-controls')) return;
        setPinned(tile.id === pinnedTileId ? null : tile.id);
      });
      pinBtn.addEventListener('click', () =>
        setPinned(tile.id === pinnedTileId ? null : tile.id));
      fsBtn.addEventListener('click', () => {
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          enterFullscreenWithChat(tile);
        }
      });
    }

    function setPinned(tileIdToPin) {
      pinnedTileId = tileIdToPin || null;
      const grid = els.videoGrid;
      grid.querySelectorAll('.tile.pinned').forEach((t) => t.classList.remove('pinned'));
      grid.classList.toggle('has-pinned', Boolean(pinnedTileId));
      // Reset every pin button label, then mark the pinned one
      grid.querySelectorAll('.tc-pin').forEach((b) => { b.textContent = '📌 Pin'; });
      if (pinnedTileId) {
        const tile = document.getElementById(pinnedTileId);
        if (tile) {
          tile.classList.add('pinned');
          const btn = tile.querySelector('.tc-pin');
          if (btn) btn.textContent = '📌 Unpin';
        }
      }
    }

    // If a tile that is currently pinned is removed (participant left,
    // share stopped), drop the pin so the layout returns to normal.
    function clearPinIfRemoved(removedTileId) {
      if (pinnedTileId && removedTileId === pinnedTileId) setPinned(null);
    }

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
        '<div class="muted-badge">🔇</div>' +
        TILE_CONTROLS_HTML;
      els.videoGrid.appendChild(tile);
      attachTileControls(tile);

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
      if (tile) {
        clearPinIfRemoved(tile.id);
        tile.remove();
      }
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
        '<div class="muted-badge">🔇</div>' +
        TILE_CONTROLS_HTML +
        MOD_CONTROLS_HTML;
      els.videoGrid.appendChild(tile);
      attachTileControls(tile);
      attachModControls(tile, participant.identity);

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
            '<div class="muted-badge">🔇</div>' +
            TILE_CONTROLS_HTML;
          attachTileControls(tile);
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
        if (st) {
          clearPinIfRemoved(st.id);
          st.remove();
        }
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
          TILE_CONTROLS_HTML;
        els.videoGrid.appendChild(tile);
        attachTileControls(tile);
      }
      return tile;
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
      if (tile) {
        clearPinIfRemoved(tile.id);
        tile.remove();
      }
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
    // Instructor moderation — server-enforced mute + remove
    // --------------------------------------------------------------
    // The muted student's mic was toggled server-side. Mute applies
    // immediately; unmute asks the client to re-enable its mic (media
    // capture is user-controlled, the server cannot force it on).
    socket.on('mod:muted', (event) => {
      if (!event || !room) return;
      if (event.muted) {
        room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
        micEnabled = false;
        els.micBtn.classList.remove('active');
        els.micBtn.disabled = true;
        els.micBtn.textContent = '🎙️ Muted by instructor';
        addChatMessage({ text: 'Your microphone was muted by the instructor.' }, false, true);
      } else {
        els.micBtn.disabled = false;
        els.micBtn.textContent = '🎙️ Mic on';
        room.localParticipant.setMicrophoneEnabled(true).then(() => {
          micEnabled = true;
          els.micBtn.classList.add('active');
          els.micBtn.textContent = '🎙️ Mic on';
        }).catch(() => {
          addChatMessage({ text: 'The instructor unmuted you — tap the Mic button to speak.' }, false, true);
        });
      }
    });

    // Removed from the session by the instructor
    socket.on('mod:kicked', (event) => {
      if (!event) return;
      if (room) {
        try { room.disconnect(); } catch (e) { /* already gone */ }
      }
      const title = document.getElementById('endedCardTitle');
      const text = document.getElementById('endedCardText');
      if (title) title.textContent = 'Removed from session';
      if (text) text.textContent = 'The instructor has removed you from this session.';
      els.endedOverlay.hidden = false;
    });

    // Identities currently force-muted (drives tile button labels)
    const mutedIdentities = new Set();

    // --------------------------------------------------------------
    // Instructor in-class telemetry strip + End session
    // (instructor-only; students receive no such events)
    // --------------------------------------------------------------
    // Track hidden state per identity from visibility events
    let hiddenMap = new Map();
    let hiddenCount = 0;

    function updateStripCounts() {
      hiddenCount = 0;
      hiddenMap.forEach((v) => { if (v) hiddenCount++; });
      els.stripHidden.textContent = String(hiddenCount);
      els.stripParticipants.textContent = String(room ? room.numParticipants : 0);
    }

    socket.on('telemetry:event', (event) => {
      if (!event || !currentRoom || event.roomName !== currentRoom) return;
      if (myRole !== 'instructor') return; // belt & braces; server gates too

      switch (event.type) {
        case 'session:join':
          hiddenMap.set(event.identity, false);
          updateStripCounts();
          els.stripLatest.textContent = event.identity + ' joined';
          break;
        case 'session:leave':
          hiddenMap.delete(event.identity);
          updateStripCounts();
          els.stripLatest.textContent = (event.identity || 'Someone') + ' left';
          break;
        case 'telemetry:visibility':
          hiddenMap.set(event.identity, Boolean(event.hidden));
          updateStripCounts();
          els.stripLatest.textContent = (event.identity || '?') + (event.hidden ? ' is hidden' : ' is back');
          break;
        case 'proctor:alert': {
          const dur = event.durationMs || 0;
          if ((event.note && /disconnected/.test(event.note)) || dur >= 10000) {
            stripStats.absences++;
          } else {
            stripStats.tabSwitches++;
          }
          els.stripTabSwitches.textContent = String(stripStats.tabSwitches);
          els.stripAbsences.textContent = String(stripStats.absences);
          els.stripLatest.textContent = (event.identity || '?') + ' · ' + (dur / 1000).toFixed(1) + 's away';
          break;
        }
        case 'telemetry:snapshot_hash':
          els.stripLatest.textContent = (event.identity || '?') + ' snapshot ok';
          break;
        default:
          break;
      }
    });

    // End session — instructor only, with confirmation
    els.endBtn.addEventListener('click', () => {
      if (!currentRoom) return;
      if (!confirm('End the session for EVERYONE? Students will be disconnected.')) return;
      socket.emit('session:end', { roomName: currentRoom });
    });

    // Everyone: the instructor ended the session — leave LiveKit and
    // show the overlay.
    socket.on('session:ended', (event) => {
      if (!event || (currentRoom && event.roomName !== currentRoom)) return;
      if (room) {
        try { room.disconnect(); } catch (e) { /* already gone */ }
      }
      els.endedOverlay.hidden = false;
    });

    els.endedBackBtn.addEventListener('click', () => {
      els.endedOverlay.hidden = true;
      // Reset to the join screen for the next session
      els.classroom.classList.remove('active');
      els.joinScreen.style.display = '';
      setStatus('idle', 'Idle');
      if (typeof onDisconnected === 'function') onDisconnected();
    });


    // End session — instructor only, with confirmation
    els.endBtn.addEventListener('click', () => {
      if (!currentRoom) return;
      if (!confirm('End the session for EVERYONE? Students will be disconnected.')) return;
      socket.emit('session:end', { roomName: currentRoom });
    });

    // Everyone: the instructor ended the session — leave LiveKit and
    // show the overlay.
    socket.on('session:ended', (event) => {
      if (!event || (currentRoom && event.roomName !== currentRoom)) return;
      if (room) {
        try { room.disconnect(); } catch (e) { /* already gone */ }
      }
      els.endedOverlay.hidden = false;
    });

    els.endedBackBtn.addEventListener('click', () => {
      els.endedOverlay.hidden = true;
      // Reset to the join screen for the next session
      els.classroom.classList.remove('active');
      els.joinScreen.style.display = '';
      setStatus('idle', 'Idle');
      if (typeof onDisconnected === 'function') onDisconnected();
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

    // ---- Chat open/close (sidebar) + unread badge ------------------
    function setChatOpen(open) {
      chatOpen = open;
      els.chatBody.style.display = open ? 'flex' : 'none';
      if (open) {
        unreadCount = 0;
        updateChatBadge();
      }
    }

    function updateChatBadge() {
      els.chatUnread.hidden = chatOpen || unreadCount === 0;
      els.chatUnread.textContent = unreadCount > 9 ? '9+' : String(unreadCount);
    }

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
      if (!chatOpen && !self) {
        unreadCount++;
        updateChatBadge();
      }
    }

    els.chatSend.addEventListener('click', sendChat);
    els.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
    els.chatBtn.addEventListener('click', () => {
      setChatOpen(!chatOpen);
      if (chatOpen) {
        const panel = els.chatLog.closest('.panel');
        if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        els.chatInput.focus({ preventScroll: true });
      }
    });

    // ---- Chat inside fullscreen video ------------------------------
    // The fullscreen element is the TILE, and the real chat nodes
    // (log + input row) move into an overlay inside it for the
    // duration — same history, no duplicates, returned on exit.
    const fsChat = document.createElement('div');
    fsChat.className = 'fs-chat open';
    fsChat.innerHTML =
      '<div class="fs-chat-head"><span>💬 Chat</span><span class="fs-chat-toggle">▼</span></div>' +
      '<div class="fs-chat-body"></div>';
    const fsChatBody = fsChat.querySelector('.fs-chat-body');
    const fsChatHead = fsChat.querySelector('.fs-chat-head');
    let fsChatOpen = true;
    let fullscreenTile = null;
    let chatHome = els.chatBody; // where the chat nodes live when not fullscreen

    fsChatHead.addEventListener('click', () => {
      fsChatOpen = !fsChatOpen;
      fsChat.classList.toggle('open', fsChatOpen);
      fsChat.querySelector('.fs-chat-toggle').textContent = fsChatOpen ? '▼' : '▲';
    });

    function moveChatInto(target) { target.appendChild(els.chatLog); target.appendChild(els.chatInput.closest('.chat-input-row')); }
    function moveChatHome() { moveChatInto(chatHome); }

    function enterFullscreenWithChat(tile) {
      if (!tile.requestFullscreen) {
        // Fallback: video-only fullscreen (no chat overlay possible)
        const video = tile.querySelector('video');
        if (video && video.requestFullscreen) video.requestFullscreen().catch(() => {});
        return;
      }
      fullscreenTile = tile;
      tile.appendChild(fsChat);
      moveChatInto(fsChatBody);
      fsChatOpen = true;
      fsChat.classList.add('open');
      tile.requestFullscreen().catch(() => {
        fullscreenTile = null;
        moveChatHome();
      });
    }

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && fullscreenTile) {
        fullscreenTile = null;
        moveChatHome();
      }
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
        // Preconnect to the LiveKit signaling host — saves ~100-300ms
        // on the first WebSocket handshake.
        if (cfg && typeof cfg.livekitUrl === 'string') {
          try {
            const u = new URL(cfg.livekitUrl);
            if (u.protocol === 'wss:' || u.protocol === 'https:') {
              const link = document.createElement('link');
              link.rel = 'preconnect';
              link.href = u.origin;
              link.crossOrigin = 'anonymous';
              document.head.appendChild(link);
            }
          } catch (e) { /* ignore malformed URL */ }
        }
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
