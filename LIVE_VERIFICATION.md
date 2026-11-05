# Live verification of preview 0.1.3

Historical scope: this session tested timing sync after both viewers opened a source. It did **not** test automatic torrent opening. Preview 0.2.0 adds that behavior with a server/extension update and separate automated regression coverage; the new flow still needs live torrent-download verification.

The built Chrome extension was tested in two separate Chrome profiles against a deployed HTTPS party server, with real Stremio Web 6.0.7 and a local Stremio streaming server reporting 4.22.3. No extension APIs or page player were mocked during this live session.

The reproducible playback source was the [Sintel trailer used by W3C's media demonstration](https://www.w3.org/2010/05/video/mediaevents.html), opened through Stremio's **Search or paste link** input using a paste action. The clip is 52.208333 seconds long. Each viewer opened the source independently; the party server did not distribute a stream URL.

| Check | Observed result |
| --- | --- |
| Create and invite | Room created on the configured HTTPS server; Invite reported Link copied; the invitation opened and configured the second profile. |
| Guest identity | Separate profile joined without host controls. Incognito shared extension storage and exercised host replacement instead of providing an independent guest. |
| Playback | Both real Stremio players resumed together and paused at 44 seconds. |
| Seek and speed | Guest followed a host seek to 25 seconds and its playback-speed menu showed 1.25x. |
| Host-only control | A guest seek to 34 seconds left the host paused at 44.981463 seconds. |
| Shared control | A guest backward seek moved the host to 34.981 seconds. |
| Chat | Test messages sent in each direction appeared in the other profile; typing did not start playback. |
| Fullscreen | Native Stremio fullscreen entered successfully with the party panel visible and usable. It exited successfully. Background automation requests were initially denied by Chrome; native input in the visible window worked. |
| Leave, rejoin and resync | Guest left, rejoined the same room, recovered the 34-second snapshot, and used Sync successfully. Presence returned to two viewers after the unused setup tab was closed. |
| Host replacement | A new host tab displaced the previous host; the old tab displayed the takeover notice and did not reconnect repeatedly. The visible host subsequently recovered authority. |
| Real episode identity | After the fix, a real Stremio episode route emitted a complete `tt…:season:episode` ID through the deployed server. Automated tests additionally reject a different episode in the same series. |
| Cleanup | Restored host-only mode; left the temporary room from both profiles; playback remained paused. |

## Fixes found during verification

- URI-encoded episode IDs were being reduced to the series ID. The adapter now decodes route segments and retains the final complete identifier.
- A host heartbeat could overwrite a guest's in-flight seek in shared-control mode. Local seeking and its trailing sync now remain intact, while heartbeats are sent separately from local-event debouncing.

After these fixes, all 6 Python tests and 11 browser tests passed, and the shared-control playback test passed three consecutive runs in each of Chromium and Firefox. Linux CI also passed; its Chrome and Firefox ZIPs matched the Windows-built ZIPs byte for byte.

## Limits of this result

This is verification of the tested Chrome watch-party flow, not a claim that every source or deployment works. An HEVC source was not playable. An H.264 source played in the main profile, but the fresh profile reported a download error for that source despite its streaming server showing Online and device access being allowed. The public HTTPS clip played successfully in both profiles.

Firefox playback was tested by the automated adapter harness; loading and signing the actual Firefox extension was not tested. Store publication, deployment of this PR's backend changes, production load, packet-loss scenarios, and native video-only fullscreen remain unverified. A full page reload may require opening the HTTP source again through Stremio's own link input; room recovery and playback recovery after reopening the clip were verified.
