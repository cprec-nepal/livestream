  /* ================================================================
     Admin dashboard — real-time session & proctoring monitor
     ================================================================ */
  (function () {
    'use strict';

    const $ = (id) => document.getElementById(id);
    const els = {
      connPill:       $('connPill'),
      statRooms:      $('statRooms'),
      statParticipants:$('statParticipants'),
      statTabSwitches:$('statTabSwitches'),
      statProlonged:  $('statProlonged'),
      roomsCount:     $('roomsCount'),
      roomsList:      $('roomsList'),
      alertsCount:    $('alertsCount'),
      alertsList:     $('alertsList'),
      filters:        $('filters'),
      clearAlertsBtn: $('clearAlertsBtn'),
    };

    // --------------------------------------------------------------
    // State
    //   rooms: Map<roomName, { name, participantCount, participants: Map<socketId, {...}>, createdAt }>
    //   alerts: Array<Alert>
    // --------------------------------------------------------------
    const rooms = new Map();
    const alerts = [];
    let activeFilter = 'all';
    let stats = {
      tabSwitches: 0,
      prolongedAbsences: 0,
    };

    // --------------------------------------------------------------
    // Status pill
    // --------------------------------------------------------------
    function setStatus(state, text) {
      els.connPill.classList.remove('live', 'err');
      if (state) els.connPill.classList.add(state);
      els.connPill.querySelector('.text').textContent = text;
    }

    // --------------------------------------------------------------
    // Socket.io
    // --------------------------------------------------------------
    const socket = io({ transports: ['websocket'] });

    socket.on('connect', () => {
      setStatus('live', 'Connected');
      socket.emit('admin:join');
    });
    socket.on('disconnect', () => setStatus('err', 'Disconnected'));
    socket.on('connect_error', (err) => {
      setStatus('err', 'Connection error');
      // If the server rejected our socket (admin cookie missing/expired),
      // the page-level middleware will redirect us. Otherwise show the error.
      if (err && /unauthorized/i.test(err.message || '')) {
        window.location.href = '/admin/login?err=2';
      }
    });

    // ---- admin:state — initial snapshot on connect ----------------
    socket.on('admin:state', (payload) => {
      // Reset
      rooms.clear();
      alerts.length = 0;
      stats.tabSwitches = 0;
      stats.prolongedAbsences = 0;

      if (payload && Array.isArray(payload.rooms)) {
        payload.rooms.forEach((r) => {
          rooms.set(r.name, {
            name: r.name,
            participantCount: r.participantCount,
            participants: new Map(),
            createdAt: r.createdAt,
          });
          if (Array.isArray(r.alerts)) {
            r.alerts.forEach((a) => {
              alerts.push(a);
              if (a.type === 'tab_switch') stats.tabSwitches++;
              if (a.type === 'prolonged_absence') stats.prolongedAbsences++;
            });
          }
        });
      }
      renderAll();
    });

    // ---- session:join / session:leave ------------------------------
    socket.on('session:join', (s) => {
      let room = rooms.get(s.roomName);
      if (!room) {
        room = {
          name: s.roomName,
          participantCount: 0,
          participants: new Map(),
          createdAt: Date.now(),
        };
        rooms.set(s.roomName, room);
      }
      room.participants.set(s.socketId, {
        identity: s.identity,
        role: s.role,
        isMobile: s.isMobile,
        hidden: false,
        joinedAt: s.joinedAt,
      });
      room.participantCount = room.participants.size;
      renderRooms();
      renderStats();
    });

    socket.on('session:leave', (s) => {
      const room = rooms.get(s.roomName);
      if (!room) return;
      room.participants.delete(s.socketId);
      room.participantCount = room.participants.size;
      if (room.participantCount === 0) {
        // Keep the room card visible briefly so admins can see who left
        setTimeout(() => {
          if (rooms.has(s.roomName) && rooms.get(s.roomName).participantCount === 0) {
            rooms.delete(s.roomName);
            renderRooms();
            renderStats();
          }
        }, 5000);
      }
      renderRooms();
      renderStats();
    });

    // ---- telemetry:visibility (live state updates) -----------------
    socket.on('telemetry:visibility', (e) => {
      const room = rooms.get(e.roomName);
      if (!room) return;
      const p = room.participants.get(e.socketId);
      if (!p) return;
      p.hidden = e.hidden;
      renderRooms();
    });

    // ---- proctor:alert ---------------------------------------------
    socket.on('proctor:alert', (a) => {
      alerts.unshift(a);
      if (alerts.length > 300) alerts.length = 300;
      if (a.type === 'tab_switch') stats.tabSwitches++;
      if (a.type === 'prolonged_absence') stats.prolongedAbsences++;
      renderAlerts();
      renderStats();
    });

    // ---- telemetry:snapshot_hash (kept in alerts stream) ----------
    socket.on('telemetry:snapshot_hash', (e) => {
      alerts.unshift({
        type: 'snapshot_hash',
        roomName: e.roomName,
        identity: e.identity,
        hash: e.hash,
        timestamp: e.timestamp,
      });
      if (alerts.length > 300) alerts.length = 300;
      renderAlerts();
    });

    // --------------------------------------------------------------
    // Filters
    // --------------------------------------------------------------
    els.filters.addEventListener('click', (ev) => {
      const chip = ev.target.closest('.filter-chip');
      if (!chip) return;
      activeFilter = chip.dataset.filter;
      els.filters.querySelectorAll('.filter-chip').forEach(c =>
        c.classList.toggle('active', c.dataset.filter === activeFilter)
      );
      renderAlerts();
    });

    els.clearAlertsBtn.addEventListener('click', () => {
      alerts.length = 0;
      stats.tabSwitches = 0;
      stats.prolongedAbsences = 0;
      renderAlerts();
      renderStats();
    });

    // --------------------------------------------------------------
    // Rendering
    // --------------------------------------------------------------
    function renderAll() { renderStats(); renderRooms(); renderAlerts(); }

    function renderStats() {
      els.statRooms.textContent = rooms.size;
      let total = 0;
      rooms.forEach(r => total += r.participantCount);
      els.statParticipants.textContent = total;
      els.statTabSwitches.textContent = stats.tabSwitches;
      els.statProlonged.textContent = stats.prolongedAbsences;
      els.roomsCount.textContent = rooms.size;
    }

    function renderRooms() {
      if (rooms.size === 0) {
        els.roomsList.innerHTML =
          '<div class="empty"><div class="big">📡</div>Waiting for sessions…</div>';
        return;
      }

      // Sort rooms: most participants first
      const sorted = Array.from(rooms.values()).sort((a, b) =>
        b.participantCount - a.participantCount
      );

      els.roomsList.innerHTML = sorted.map((r) => {
        const max = parseInt(window.__maxPerRoom || '50', 10);
        const pct = Math.min(100, (r.participantCount / max) * 100);
        const capClass = pct >= 100 ? 'full' : (pct >= 80 ? 'warn' : '');
        const fillClass = pct >= 100 ? 'full' : (pct >= 80 ? 'warn' : '');
        const participants = Array.from(r.participants.values()).map((p) => {
          const cls = ['participant'];
          if (p.hidden) cls.push('hidden');
          if (p.isMobile) cls.push('mobile');
          const label = escapeHtml(p.identity)
            + (p.isMobile ? ' · 📱' : '')
            + (p.hidden ? ' · hidden' : '');
          return '<span class="' + cls.join(' ') + '"><span class="pdot"></span>' + label + '</span>';
        }).join('');
        return '' +
          '<div class="room-card">' +
            '<div class="room-head">' +
              '<div><div class="room-name">' + escapeHtml(r.name) + '</div>' +
                '<div class="room-meta">since ' + fmtTime(r.createdAt) + '</div></div>' +
              '<div class="capacity ' + capClass + '">' + r.participantCount + ' / ' + max + '</div>' +
            '</div>' +
            '<div class="capacity-bar"><div class="fill ' + fillClass + '" style="width:' + pct + '%"></div></div>' +
            '<div class="participants">' + (participants || '<span class="participant"><span class="pdot"></span>no live telemetry yet</span>') + '</div>' +
          '</div>';
      }).join('');
    }

    function renderAlerts() {
      els.alertsCount.textContent = alerts.length;
      if (alerts.length === 0) {
        els.alertsList.innerHTML =
          '<div class="empty"><div class="big">✅</div>No alerts yet</div>';
        return;
      }
      const filtered = activeFilter === 'all'
        ? alerts
        : alerts.filter(a => a.type === activeFilter);

      if (filtered.length === 0) {
        els.alertsList.innerHTML =
          '<div class="empty"><div class="big">🔍</div>No alerts match this filter</div>';
        return;
      }

      els.alertsList.innerHTML = filtered.slice(0, 100).map((a) => {
        let body = '';
        if (a.type === 'tab_switch') {
          body = 'Tab hidden for <strong>' + (a.durationMs/1000).toFixed(1) + 's</strong>';
        } else if (a.type === 'prolonged_absence') {
          body = 'Absent for <strong>' + (a.durationMs/1000).toFixed(1) + 's</strong>'
               + (a.note ? ' · ' + escapeHtml(a.note) : '');
        } else if (a.type === 'snapshot_hash') {
          body = 'Hash <strong>' + escapeHtml(a.hash.slice(0, 16)) + '…</strong>';
        }
        return '' +
          '<div class="alert ' + a.type + '">' +
            '<div class="a-head">' +
              '<span class="a-type">' + escapeHtml(a.type.replace(/_/g, ' ')) + '</span>' +
              '<span class="a-time">' + fmtTime(a.timestamp) + '</span>' +
            '</div>' +
            '<div class="a-body">' +
              '<strong>' + escapeHtml(a.identity || '?') + '</strong> · room ' +
              '<strong>' + escapeHtml(a.roomName || '?') + '</strong><br>' +
              body +
            '</div>' +
          '</div>';
      }).join('');
    }

    // --------------------------------------------------------------
    // Helpers
    // --------------------------------------------------------------
    function fmtTime(ts) {
      if (!ts) return '--:--:--';
      const d = new Date(ts);
      return d.toTimeString().slice(0, 8);
    }

    function escapeHtml(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
      }[c]));
    }

    // Periodic UI tick so the rooms list "since" time stays fresh
    setInterval(() => { renderRooms(); }, 30000);

    // Expose config for capacity bar calculation
    window.__maxPerRoom = '50';
  })();
