/* Open Stremio Party: playback adapter. Leave native player controls untouched. */
(() => {
  'use strict';
  if (window.__OPEN_STREMIO_PARTY_LOADED__) return;
  window.__OPEN_STREMIO_PARTY_LOADED__ = true;

  // Invitations carry their own server. No deployment URL is bundled in releases.
  function validServer(value) {
    try {
      const u = new URL(value);
      if (u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return null;
      return u.origin;
    } catch { return null; }
  }
  const socketUrl = server => new URL('/ws', server).href.replace(/^http/, 'ws');
  const ROOM_PATTERN = /^[A-HJ-NP-Z2-9]{10}$/;
  const storage = chrome.storage.local;
  const clientId = sessionStorage.getItem('openStremioPartyClientId') || crypto.randomUUID();
  sessionStorage.setItem('openStremioPartyClientId', clientId);
  const state = {
    ws: null, connected: false, code: null, create: false, host: false, mode: 'host',
    hostOnline: false, nickname: 'Guest', hostKeys: {}, peers: [], messages: [],
    pending: null, video: null, suppressUntil: 0, lastSeq: 0, retry: null,
    retryCount: 0, manualDisconnect: false, bubble: null, server: null, inviteUrl: null, showSettings: false,
  };

  const host = document.createElement('div');
  host.id = 'open-stremio-party-root';
  // Only the visible 42px button has a clickable footprint.
  host.style.cssText = 'position:fixed;top:40vh;right:12px;width:42px;height:42px;z-index:2147483600;pointer-events:auto;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const stylesheet = document.createElement('style');
  stylesheet.textContent = `
    :host{color-scheme:dark;font:13px/1.35 system-ui,Arial,sans-serif;color:#ebedf5}
    *{box-sizing:border-box}button,input,select{font:inherit}button{cursor:pointer}
    .bubble{pointer-events:auto;user-select:none;touch-action:none;display:flex;align-items:center;justify-content:center;width:42px;height:42px;background:#625ce0;color:white;border:1px solid #ffffff66;border-radius:15px;box-shadow:0 10px 25px #0008;font-weight:800;letter-spacing:-1px}
    button:disabled{opacity:.5;cursor:default}.bubble.online{background:#297f75}.bubble:focus-visible,.panel button:focus-visible,.panel input:focus-visible,.panel select:focus-visible{outline:2px solid #c8befc;outline-offset:2px}
    .panel{pointer-events:auto;position:absolute;right:50px;top:0;width:min(300px,calc(100vw - 78px));max-height:min(74vh,600px);overflow:auto;background:#111522;border:1px solid #40435c;border-radius:17px;padding:14px;box-shadow:0 16px 60px #000b;color:#eaeef6}
    .panel[hidden]{display:none}.head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}.title{font-size:16px;font-weight:800;letter-spacing:-.3px}
    .muted{color:#aab2c9}.sub{font-size:11px;color:#aaaeba;margin:4px 0 12px}label{display:block;margin:11px 0 5px;color:#cbd1e1}
    input,select{width:100%;background:#202638;color:#fafaff;border:1px solid #51596e;border-radius:8px;padding:9px;min-width:0}
    button:not(.bubble){background:#6558ba;color:white;border:0;border-radius:9px;padding:9px 12px}button.secondary{background:#2b3247}.row{display:flex;align-items:center;gap:7px}.row>button{flex:1}
    .pill{font-size:11px;padding:4px 8px;border-radius:15px;background:#242d42;color:#b5dacf}.section{border-top:1px solid #ffffff20;padding-top:12px;margin-top:12px}
    .room-code{font-size:22px;font-weight:900;letter-spacing:.13em;margin:6px 0}.notice{background:#342a40;padding:8px;border-radius:9px;margin-top:10px;color:#ffdae5;overflow-wrap:anywhere}
    .messages{height:145px;overflow:auto;border:1px solid #ffffff16;border-radius:10px;padding:8px;background:#0b0f1b;margin:10px 0}
    .message{margin-bottom:6px;overflow-wrap:anywhere;white-space:pre-wrap}.message b{color:#b8a5fc}
    .tiny{font-size:11px}.hidden{display:none!important}#members{white-space:normal;overflow-wrap:anywhere}
  `;
  shadow.append(stylesheet);
  const root = document.createElement('div');
  root.style.cssText = 'width:42px;height:42px;pointer-events:none;';
  root.innerHTML = `
    <button class="bubble" id="toggle" title="Party" aria-label="Open Party" aria-expanded="false">◉</button>
    <section class="panel" id="panel" hidden aria-label="Party">
      <div class="head"><span class="title">Party</span><div class="row"><button class="secondary" id="settings" title="Server settings" aria-label="Server settings">⚙</button><button class="secondary" id="close" aria-label="Close">×</button></div></div>
      <div id="setup">
        <div id="serverSetup" hidden><input id="server" type="url" placeholder="Your party server URL" aria-label="Party server URL"><div class="sub">Your server's HTTPS address</div></div>
        <input id="nickname" maxlength="24" autocomplete="nickname" placeholder="Your name" aria-label="Your name">
        <input id="room" maxlength="10" placeholder="Room code" aria-label="Room code" spellcheck="false" autocapitalize="characters" style="margin-top:8px">
        <div class="row" style="margin-top:12px"><button id="create">Create</button><button class="secondary" id="join">Join</button></div>
      </div>
      <div id="inside" hidden>
        <div class="room-code" id="code"></div>
        <div class="row"><button id="copy">Invite</button><button id="resync" class="secondary">Sync</button><button id="leave" class="secondary">Leave</button></div>
        <div class="section"><div class="muted tiny" id="members"></div><div class="sub" id="playerState" hidden>Open a video to sync</div></div>
        <div class="section" id="modeSection" hidden><select id="mode" aria-label="Playback control"><option value="host">Host controls</option><option value="everyone">Everyone controls</option></select></div>
        <div class="section"><div class="messages" id="messages" role="log" aria-label="Chat" aria-live="polite"></div>
        <div class="row"><input id="chat" maxlength="500" placeholder="Message" aria-label="Chat message"><button id="send">Send</button></div></div>
      </div>
      <div id="notice" class="notice" hidden role="status"></div>
    </section>`;
  shadow.append(root);
  (document.body || document.documentElement).append(host);

  const el = id => root.querySelector('#' + id);
  function notice(text) {
    el('notice').hidden = !text;
    el('notice').textContent = text || '';
  }
  function openPanel(value) {
    el('panel').hidden = !value;
    el('toggle').setAttribute('aria-expanded', String(value));
  }
  // Toggle on pointerup so the panel opens even if the page consumes the subsequent click.
  // Preserve native keyboard and assistive-technology click behavior.
  let ignorePointerClickUntil = 0;
  el('toggle').addEventListener('click', event => {
    event.stopPropagation();
    if (event.detail !== 0 && performance.now() < ignorePointerClickUntil) return;
    openPanel(el('panel').hidden);
  });
  el('close').addEventListener('click', () => openPanel(false));
  el('settings').addEventListener('click', () => {
    state.showSettings = !state.showSettings;
    render();
  });

  // Move *only* the small bubble. Never install an invisible full-screen overlay.
  let drag = null;
  el('toggle').addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag = { x: e.clientX, y: e.clientY, top: host.getBoundingClientRect().top, left: host.getBoundingClientRect().left, moved: false };
    el('toggle').setPointerCapture(e.pointerId);
  });
  el('toggle').addEventListener('pointermove', e => {
    if (!drag) return;
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.hypot(dx, dy) > 5) drag.moved = true;
    if (!drag.moved) return;
    const left = Math.max(0, Math.min(innerWidth - 42, drag.left + dx));
    const top = Math.max(0, Math.min(innerHeight - 42, drag.top + dy));
    host.style.left = `${left}px`; host.style.right = 'auto'; host.style.top = `${top}px`;
    // Position panel on the *inside* of the viewport after moving the bubble.
    el('panel').style.right = left < innerWidth / 2 ? 'auto' : '50px';
    el('panel').style.left = left < innerWidth / 2 ? '50px' : 'auto';
  });
  el('toggle').addEventListener('pointerup', event => {
    if (!drag) return;
    event.stopPropagation();
    // Avoid toggling twice when a pointerup is followed by a synthetic click.
    ignorePointerClickUntil = performance.now() + 350;
    if (drag.moved) {
      storage.set({ bubblePosition: { left: parseInt(host.style.left, 10), top: parseInt(host.style.top, 10) } });
    } else {
      const bounds = el('toggle').getBoundingClientRect();
      if (event.clientX >= bounds.left && event.clientX <= bounds.right &&
          event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
        openPanel(el('panel').hidden);
      }
    }
    drag = null;
  });
  el('toggle').addEventListener('pointercancel', () => { drag = null; });

  function saveRoom(code) {
    if (code && state.server) sessionStorage.setItem('openStremioPartyRoom', JSON.stringify({ code, server: state.server }));
    else sessionStorage.removeItem('openStremioPartyRoom');
  }
  function renderChat() {
    const list = el('messages'); list.replaceChildren();
    for (const msg of state.messages.slice(-40)) {
      const row = document.createElement('div'); row.className = 'message';
      const who = document.createElement('b'); who.textContent = msg.nickname + ': ';
      row.append(who, document.createTextNode(msg.text)); list.append(row);
    }
    list.scrollTop = list.scrollHeight;
  }
  function render() {
    const hasRoom = !!state.code;
    el('setup').hidden = hasRoom;
    el('inside').hidden = !hasRoom;
    el('modeSection').hidden = !state.host;
    el('serverSetup').hidden = !!state.server && !state.showSettings;
    el('create').disabled = !state.server;
    el('join').disabled = !state.server;
    el('mode').value = state.mode;
    el('code').textContent = state.code || '';
    el('members').textContent = state.peers.length ? `${state.peers.length} watching` : 'Connecting…';
    if (hasRoom && !state.connected) notice('Reconnecting…');
    el('toggle').classList.toggle('online', state.connected);
    el('playerState').hidden = !!state.video || !hasRoom;
  }
  function saveNick() {
    state.nickname = (el('nickname').value.trim().replace(/\s+/g, ' ') || 'Guest').slice(0, 24);
    storage.set({ nickname: state.nickname });
  }
  function send(message) {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(message));
  }
  function connect(create, code) {
    if (state.retry) clearTimeout(state.retry);
    state.retry = null;
    if (!state.server) { notice('Enter your party server address.'); return; }
    const previous = state.ws;
    state.ws = null;
    if (previous) previous.close(1000, 'Switching rooms');
    state.manualDisconnect = false;
    state.create = create;
    state.connected = false;
    state.retryCount = create ? 0 : state.retryCount;
    state.code = create ? null : code;
    render();
    notice('');
    const socket = new WebSocket(socketUrl(state.server));
    state.ws = socket;
    socket.addEventListener('open', () => {
      if (state.ws !== socket) return;
      send({ type: create ? 'create' : 'join', code,
        nickname: state.nickname, peerId: clientId, hostToken: state.hostKeys[state.server + '|' + code] || undefined });
    });
    socket.addEventListener('message', async event => {
      if (state.ws !== socket) return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.type === 'error') {
        notice(msg.message || 'Server error');
        if (/not found|expired/i.test(msg.message || '')) { state.code = null; saveRoom(null); }
        render(); return;
      }
      if (msg.type === 'joined') {
        state.code = msg.code;
        state.connected = true;
        state.host = !!msg.host;
        state.mode = msg.mode;
        state.retryCount = 0;
        state.peers = msg.roster.peers;
        state.hostOnline = msg.roster.hostOnline;
        state.messages = msg.messages || [];
        state.inviteUrl = msg.inviteUrl || new URL('/r/' + msg.code, state.server).href;
        notice('');
        state.pending = msg.snapshot ? { ...msg.snapshot, receivedAt: performance.now() } : null;
        state.lastSeq = msg.snapshot?.seq || 0;
        if (msg.hostToken) {
          state.hostKeys[state.server + '|' + msg.code] = msg.hostToken;
          await storage.set({ hostKeys: state.hostKeys });
        }
        saveRoom(msg.code); renderChat(); render();
        if (state.pending && !state.host) applySync(state.pending, true);
      } else if (msg.type === 'roster') {
        state.peers = msg.peers || [];
        state.hostOnline = !!msg.hostOnline;
        state.mode = msg.mode || 'host'; render();
      } else if (msg.type === 'chat') {
        state.messages.push(msg); renderChat();
      } else if (msg.type === 'sync') {
        const snapshot = msg.state;
        if (snapshot && snapshot.seq > state.lastSeq) {
          state.lastSeq = snapshot.seq;
          state.pending = { ...snapshot, receivedAt: performance.now() };
          applySync(state.pending);
        }
      }
    });
    socket.addEventListener('close', () => {
      if (state.ws !== socket) return;
      state.connected = false;
      state.peers = []; render();
      if (state.manualDisconnect) return;
      if (!state.code) {
        notice('Connection interrupted. Reopen the party panel and retry.'); return;
      }
      const delay = Math.min(30000, 700 * 2 ** Math.min(state.retryCount++, 6)) + Math.random() * 350;
      state.retry = setTimeout(() => connect(false, state.code), delay);
    });
    socket.addEventListener('error', () => { notice('Cannot reach the party server. Reconnecting automatically.'); });
  }
  function start(create, code) {
    saveNick();
    if (!state.server || state.showSettings) {
      const url = validServer(el('server').value.trim());
      if (!url) { notice('Enter an HTTPS server address.'); return; }
      state.server = url; storage.set({ partyServer: url }); state.showSettings = false; render();
    }
    if (!create && !ROOM_PATTERN.test(code)) { notice('Please enter a valid 10-character room code.'); return; }
    state.retryCount = 0;
    connect(create, code);
  }
  el('create').addEventListener('click', () => start(true));
  el('join').addEventListener('click', () => start(false, el('room').value.toUpperCase().trim()));
  el('room').addEventListener('keydown', e => { if (e.key === 'Enter') el('join').click(); });
  el('leave').addEventListener('click', () => {
    state.manualDisconnect = true;
    if (state.retry) clearTimeout(state.retry);
    send({ type: 'leave' });
    state.ws?.close(1000, 'Left room');
    state.ws = null; state.code = null; state.host = false; state.connected = false;
    state.peers = []; state.pending = null; state.lastSeq = 0; state.inviteUrl = null;
    saveRoom(null); notice(''); render();
  });
  el('mode').addEventListener('change', () => { if (state.host) send({ type: 'mode', value: el('mode').value }); });
  el('copy').addEventListener('click', async () => {
    const invite = state.inviteUrl || new URL('/r/' + state.code, state.server).href;
    try { await navigator.clipboard.writeText(invite); notice('Link copied'); }
    catch { notice(invite); }
  });
  function sendChat() {
    const message = el('chat').value.trim();
    if (!message || !state.connected) return;
    send({ type: 'chat', text: message }); el('chat').value = '';
  }
  el('send').addEventListener('click', sendChat);
  el('chat').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  function mediaId() {
    // Share only a public Stremio/IMDb content identifier, never source URL or credentials.
    const matches = (location.pathname + location.hash).match(/(?:tt\d{5,12}(?::\d+:\d+)?)/i);
    return matches ? matches[0] : null;
  }
  function detectVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    const best = videos.sort((a, b) => {
      const score = v => (Number.isFinite(v.duration) && v.duration > 0 ? 100 : 0) + v.clientWidth * v.clientHeight / 100000;
      return score(b) - score(a);
    })[0] || null;
    if (best === state.video) return;
    if (state.video) {
      for (const event of ['play', 'pause', 'seeked', 'ratechange']) state.video.removeEventListener(event, onLocalChange);
    }
    state.video = best;
    if (best) {
      for (const event of ['play', 'pause', 'seeked', 'ratechange']) best.addEventListener(event, onLocalChange);
      best.addEventListener('loadedmetadata', onVideoLoaded, { once: true });
      if (state.pending) applySync(state.pending, true);
    }
    render();
  }
  function onVideoLoaded() { if (state.pending) applySync(state.pending, true); }
  function getState() {
    const v = state.video;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return null;
    return { position: v.currentTime, duration: v.duration, paused: v.paused,
      speed: v.playbackRate, mediaId: mediaId() };
  }
  function broadcastState() {
    if (!state.connected || !(state.host || state.mode === 'everyone')) return;
    const snapshot = getState();
    if (snapshot) send({ type: 'sync', state: snapshot });
  }
  function onLocalChange() {
    if (Date.now() < state.suppressUntil) return;
    broadcastState();
  }
  function applySync(snapshot, force = false) {
    if (!state.connected || (state.mode === 'host' && !state.hostOnline)) return;
    if (state.host && state.mode === 'host' && !force) return; // Host-only mode does not let guests move the leader.
    const v = state.video;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    const currentMedia = mediaId();
    if (snapshot.mediaId && currentMedia && snapshot.mediaId !== currentMedia) {
      notice('Different title/episode detected. Open the same video as the host.'); return;
    }
    if (snapshot.duration > 60 && v.duration > 60 && Math.abs(v.duration - snapshot.duration) > 12) {
      notice('The video durations differ. Choose the same cut/source, then resync.'); return;
    }
    // Never compare a server clock to a client clock: users' devices may disagree by minutes.
    // Incoming snapshots are normalized at receipt; elapsed time uses a monotonic local clock.
    const elapsed = snapshot.paused ? 0 : Math.min(30, Math.max(0, (performance.now() - (snapshot.receivedAt ?? performance.now())) / 1000));
    const target = Math.min(Math.max(0, snapshot.position + elapsed * snapshot.speed), v.duration - 0.05);
    const delta = target - v.currentTime;
    state.suppressUntil = Date.now() + 1000;
    try {
      if (force || Math.abs(delta) > 1.4) v.currentTime = target;
      const rate = Math.abs(delta) > 0.25 && Math.abs(delta) <= 1.4
        ? snapshot.speed * (1 + Math.max(-0.04, Math.min(0.04, delta * 0.06)))
        : snapshot.speed;
      if (Math.abs(v.playbackRate - rate) > 0.005) v.playbackRate = rate;
      if (snapshot.paused && !v.paused) v.pause();
      else if (!snapshot.paused && v.paused) {
        Promise.resolve(v.play()).catch(() => notice('Click Play once to allow synchronized playback (browser autoplay policy).'));
      }
      if (state.connected) notice('');
    } catch { notice('Could not control this video player; try a browser-playable source.'); }
  }
  el('resync').addEventListener('click', () => {
    if (state.host) { broadcastState(); notice('Your playback position was broadcast.'); }
    else if (state.pending) { applySync(state.pending, true); }
    else notice('No synchronized playback state is available yet.');
  });

  setInterval(() => {
    detectVideo();
    if (state.connected && state.host) onLocalChange(); // host heartbeat maintains authority
    else if (state.connected && state.pending && state.mode === 'host' && state.hostOnline) {
      // Recover when the video element appeared after room join; otherwise follow incoming syncs.
      if (state.video && Date.now() < state.pending.serverTs + 8000 && state.lastSeq <= 1) applySync(state.pending);
    }
  }, 1800);

  async function init() {
    try {
      const saved = await storage.get(['nickname', 'hostKeys', 'bubblePosition', 'partyServer']);
      state.nickname = saved.nickname || `Guest-${Math.floor(Math.random() * 900 + 100)}`;
      state.hostKeys = saved.hostKeys || {};
      state.server = validServer(saved.partyServer);
      el('nickname').value = state.nickname;
      if (saved.bubblePosition) {
        host.style.left = `${Math.max(0, Math.min(innerWidth - 42, saved.bubblePosition.left))}px`;
        host.style.right = 'auto';
        host.style.top = `${Math.max(0, Math.min(innerHeight - 42, saved.bubblePosition.top))}px`;
        el('panel').style.right = saved.bubblePosition.left < innerWidth / 2 ? 'auto' : '50px';
        el('panel').style.left = saved.bubblePosition.left < innerWidth / 2 ? '50px' : 'auto';
      }
    } catch { el('nickname').value = state.nickname; }
    const params = new URLSearchParams(location.search);
    const inviteServer = validServer(params.get('partyServer'));
    if (inviteServer) {
      state.server = inviteServer;
      storage.set({ partyServer: inviteServer });
    }
    el('server').value = state.server || '';
    const invite = params.get('partyRoom')?.trim().toUpperCase();
    let savedRoom = null;
    try { savedRoom = JSON.parse(sessionStorage.getItem('openStremioPartyRoom') || 'null'); } catch { /* ignore */ }
    const code = ROOM_PATTERN.test(invite || '') ? invite : savedRoom?.server === state.server && ROOM_PATTERN.test(savedRoom?.code || '') ? savedRoom.code : null;
    if (code) { el('room').value = code; if (state.server) start(false, code); }
    detectVideo(); render();
  }
  init();
})();
