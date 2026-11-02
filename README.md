# Open Stremio Party

Self-hosted watch parties for Stremio Web. Chrome and Firefox browser extensions synchronize playback, room presence and text chat without carrying video or Stremio credentials through the party server.

**Status:** Preview. Browser-to-browser playback and extension-store signing still need end-to-end validation. Not affiliated with Stremio.

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
5. Install a Chrome/Firefox browser extension bundle, then create a room and share its invitation link. Invitees follow the link and press **Join party**. All viewers independently select the same playable title and episode in Stremio Web.

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
```

Development server: `PARTY_DB=/tmp/party-test.sqlite BASE_URL=http://localhost:8787 python -m server.app`.

## Design and privacy

- Room links discover the chosen party server at runtime; there is no hardcoded deployment URL or personal setting in the public source or extension manifests.
- The extension injects a tiny draggable, collapsible Shadow DOM panel. No full-page overlays, disabled player buttons, global keyboard hooks or Stremio client patches.
- Sync messages contain only position, play/pause state, speed, an optional public content identifier and a random peer ID. No stream URLs, cookies, account credentials, subtitles or audio/video are exchanged.
- A WebSocket room server uses origin checks, message size limits, room caps and basic throttling; review security and browser playback behavior before public production use.
- Use legitimate sources you are authorized to view. Each participant streams locally.

## Limitations

Browser autoplay and iframe restrictions may require a manual Play click. Stremio sources that do not expose a controllable browser video element cannot be synchronized by this extension. Stremio desktop/mobile add-ons cannot invoke play/pause/seek through the official add-on interface. A separately maintained Stremio Web integration is a potential future frontend.

Licensed under MIT; see `LICENSE`.
