# Open Stremio Party

Self-hosted watch parties for Stremio Web. Chrome and Firefox browser extensions synchronize playback, room presence and text chat without carrying video or Stremio credentials through the party server.

**Status:** Preview 0.2.0. Sync now opens the host's selected torrent and file before aligning playback. Both the server and extensions must be updated. Automated Chromium and Firefox tests cover source navigation and playback against the real party server. The earlier [live 0.1.3 verification](LIVE_VERIFICATION.md) covered timing sync with sources opened manually; it did not verify this new torrent-opening flow. Not affiliated with Stremio.

## Quick start

1. Install Docker and Docker Compose. Copy `.env.example` to `.env`; set `BASE_URL` to **your own HTTPS address**. Never commit `.env`.
2. Run `mkdir -p data && sudo chown 10001:10001 data && docker compose up -d --build`.
3. Optionally set `RELEASES_URL` to the public release page of the project; the homepage then shows a **Get extension** link. Reverse proxy your domain through Caddy (or another HTTPS reverse proxy):

   ```caddyfile
   party.example.com {
       reverse_proxy 127.0.0.1:8787
   }
   ```

4. Visit your HTTPS site and press **Open Stremio**. That link configures the extension with your server without manually entering an address.
5. Install a Chrome/Firefox browser extension bundle, then create a room and share its invitation link. Invitees follow the link and press **Join party**. The host selects a playable torrent in Stremio Web and presses **Sync** to open that exact torrent/file for guests. A guest can press **Sync** to request the host's current selection for their own tab.

**Sync in 0.2:** the host's Sync shares the torrent's public info hash and file index. Guests open a minimal Stremio player route and apply the current position, pause state and speed after the new video's metadata is ready. Repeating Sync on the same torrent does not reopen it. Source selection belongs to the host even in Everyone controls mode. Each viewer downloads/streams locally; the party server never carries video.

Upgrade both sides: rebuild/restart your party server with the new code, then reload/update the extension for all participants and reconnect. Old servers only align playback and the extension reports that a server upgrade is needed; an old host extension cannot answer a guest's torrent request. HTTP/debrid URLs, embedded/external players and private tracker credentials are not shared automatically. For those sources, viewers must open their own playable source before syncing timing. Browser autoplay may still require a Play click, and opening the same torrent cannot fix an unavailable source or an incompatible codec.

The container listens only on `127.0.0.1:8787` by default; do not open port 8787 publicly. Configure permitted Stremio Web origins using `ALLOWED_ORIGINS`. Rooms are pseudonymous and expire after 24 hours. Only room metadata persists in SQLite; chat and playback state are transient. Room host tokens are stored per-server in browser storage, never in invitation links.

## Extensions and releases

Pushes to `main` run tests and update a downloadable preview release. Tag pushes matching `v*` create versioned releases containing:

- `open-stremio-party-chrome.zip` — unpack into `chrome://extensions` via **Load unpacked** for development/testing; public one-click distribution requires Chrome Web Store publication.
- `open-stremio-party-firefox.zip` — unsigned source bundle for testing using `about:debugging`; regular Firefox installation needs a Mozilla-signed XPI, not an unsigned ZIP. Mozilla signing can be performed separately or automated using the optional CI credentials.

Build locally with `python scripts/build_extensions.py`. Generated archives and the `dist` directory are excluded from Git. Firefox's browser add-on ID is a generic stable identifier. Mozilla approval/signing is a separate publishing step.

## Development

```bash
python -m pip install -r requirements.txt pytest pytest-asyncio
pytest -q
python scripts/build_extensions.py
node --check extension/content.js
npm ci
npx playwright install chromium firefox
npm test
```

The browser suite uses a generated 90-second WebM, independent browser sessions, and the real WebSocket server. It covers torrent selection, guests without a video, delayed and reused video elements, targeted guest Sync requests, cancellation on Leave, old-server messaging, setup, invitations, play/pause/seek/speed, chat escaping, host/shared controls, reconnects, host replacement, episode mismatches, clock skew, fullscreen, panel positioning and native controls. Extension APIs and Stremio's route-to-player rendering are simulated in these tests; they verify routing plus playback recovery, not actual torrent downloading. A separate Chromium test loads the actual built extension and exercises its background worker. Set `PARTY_LIVE_SMOKE=1` when running `npx playwright test --project=chromium -g "built Chromium"` to use live Stremio Web for that smoke test. No Stremio account or stream is used by this check.

Chromium tests grant local-network access only to their isolated test context so an HTTPS test page can contact the loopback server. Production deployments should use the HTTPS server URL described above. The suite does not alter your browser profile or permissions.

Pull requests run the same checks in CI. Source ZIPs are reproducible and contain only the manifest and the three extension scripts. Chrome ZIPs must be extracted before loading the unpacked extension; the Firefox ZIP remains unsigned. The browser test server sets `MAX_ROOM_CREATIONS_PER_HOUR=100` for its many disposable rooms; the production default remains 12 per client IP.

Development server: `PARTY_DB=/tmp/party-test.sqlite BASE_URL=http://localhost:8787 python -m server.app`.

## Design and privacy

- Room links discover the chosen party server at runtime; there is no hardcoded deployment URL or personal setting in the public source or extension manifests.
- The extension injects a tiny draggable, collapsible Shadow DOM panel. No full-page overlays, disabled player buttons, global keyboard hooks or Stremio client patches.
- Timing messages contain position, play/pause state, speed, an optional public content identifier and a random peer ID. Explicit Sync additionally shares a public torrent info hash and optional file index. Torrent selection is transient, like chat/playback state. Encoded original routes, tracker URLs, HTTP stream URLs, proxy headers, cookies, account credentials, subtitles and audio/video are not forwarded.
- A WebSocket room server uses origin checks, message size limits, room caps and basic throttling; review security and browser playback behavior before public production use.
- Use legitimate sources you are authorized to view. Each participant streams locally.

## Limitations

Browser autoplay and iframe restrictions may require a manual Play click. Stremio sources that do not expose a controllable browser video element cannot be synchronized by this extension. Stremio desktop/mobile add-ons cannot invoke play/pause/seek through the official add-on interface. A separately maintained Stremio Web integration is a potential future frontend.

Licensed under MIT; see `LICENSE`.
