# Roadmap

## Reliability

- Test real Chrome and Firefox playback on Stremio Web, including buffering, seeking, stream changes, fullscreen and keyboard shortcuts.
- Add playback adapters when the browser player does not expose a controllable HTML5 video element.
- Improve reconnection, episode transitions and room lifecycle under poor network conditions.
- Regression-test all native controls; never place click-blocking layers over the player.
- Test service restarts, server load, room abuse limits and deployment rollback.

## Distribution

- Add icons and polished store screenshots.
- Publish Chrome Web Store listing for one-click installation.
- Produce Mozilla-signed Firefox XPI and test regular Firefox installation.
- Improve the install and invite flow for nontechnical viewers.

## Future integrations

- Explore an integrated Stremio Web frontend with the same party protocol. Native Stremio app integration needs a supported playback-control interface or client changes.
- Add optional voice chat, subtitles handling and host-led episode navigation when dependable.
