# Verification

Release 0.5.0 public-source preparation, 17 October 2026.

## Automated checks

All 210 unit/integration tests pass in this sanitized source tree on Node 24.19.0, x64 Linux, with a 128 MiB Node heap limit. Locked offline dependency installation also passed. Tests use synthetic fixtures and mocked device/network calls.

Coverage includes selected-screen enforcement, no global reset, stop-generation races, stale request cancellation, persistent halt after uncertain errors, selective restore validation, bounded market/weather responses, cache freshness, native weather layout geometry, explicit setup opt-in, and credential redaction. Migration copies only local connection values, refuses overwrite, creates mode 0600, and leaves device writes disabled.

The public repository excludes real configuration, credentials, runtime state, caches, provider snapshots, layout exports, logs and installed dependencies. The only environment file is a blank-credential example. Private addresses and credential sentinels inside tests are synthetic. Weather geography is a fixed public Singapore example, not a user's detected location. No portfolio, brokerage account or trading data is included.

## Pomodoro 0.5.0

- The server-owned timer uses monotonic elapsed time, compare-and-apply revisions, manual phase starts and in-memory state. Browser refreshes do not restart it; a process restart resets to idle. It has no filesystem, network or device access.
- New timer controls are local POST-only actions with exact canonical Host/Origin, an in-memory CSRF nonce, duplicate-header rejection, a 512-byte body cap, a two-second body deadline, strict JSON fields, bounded fixed errors, no CORS and framing protection. GETs do not mutate timer state. This is not user authentication; trusted LAN access is required.
- Native setup is a separate explicit command to internal LCD3 only. Its five type 23 fields use IDs 25–29, a static 128×128 GIF and 10-second polling. No automatic device setup, phase-triggered upload, global reset, colour update or physical animated ring exists. Failed device writes clear all queued writes and retain the existing halt behavior.
- The screen4 software preview was visually inspected at 128×128 and 4×. It uses the actual artwork and an approximate font 400 face. Browser animation logic is covered separately from physical firmware rendering. A cloud-browser data-URL preview was rejected by the browser URL policy, and the supported browser could not reach this executor’s loopback test page, so no visual browser pass is claimed.

- Independent review added 19 native-device/config tests and 16 server/UI tests. They cover target/payload tampering, opt-in defaults, stop/arm races, Host/Origin/CSRF guards, disabled/native routes, button actions, double clicks, out-of-order responses, unknown POST outcomes with GET-only recovery, restart nonce invalidation and stale display freezing without a backwards countdown jump. All use mocks, loopback HTTP or an in-memory DOM.
- A whole-service/CLI test intercepts every provider/device fetch: startup discards queued setup without network writes; missing apply and expired requests are rejected; explicit setup sends one LCD3 item list; browser Start has no device calls; stock arm still writes only LCD0/1; a device error_code 7 produces a bounded status reason, persistent halt and no retry; restart returns the timer to idle and stocks to stopped. Logs/status omit synthetic credential sentinels.
- The actual GIF matches its embedded runtime bytes, is 128×128 and uses no palette index 0. The physical preview labels its illustrative timer state and font approximation. SGT update-time conversion includes a midnight regression.

## Verification limits

- No actual Docker build or arm64 container startup was performed in this build environment; Docker was unavailable. COPY-equivalent source staging and locked offline dependency installation were checked on the baseline.
- No physical-device execution was performed here. Native Pomodoro/weather rendering, firmware compatibility, Pi CPU/memory behavior and image transitions remain hardware-unverified. API acknowledgement alone does not prove correct rendering.
- No private Finnhub key was used. Its behavior is covered by mocked tests; provider entitlements, rate limits and availability can vary.
- No TypeScript static compiler pass or completed dependency-vulnerability audit is claimed.
- Clear/upload is non-atomic. Outages may freeze physical images; undocumented shared firmware effects cannot be ruled out.

Public data is informational and may be delayed, incomplete or stale. This package does not trade or access brokerage holdings. Existing third-party notices are retained; no new project licence is granted by this publication.
