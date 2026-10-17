# Verification

Release 0.4.3 public-source preparation, 17 October 2026.

## Automated checks

All 142 unit/integration tests pass in this sanitized source tree on Node 24.19.0, x64 Linux, with a 128 MiB Node heap limit. Locked offline npm ci using the local cache also passed. Tests use synthetic fixtures and mocked device/network calls. Public-source changes replace the configured ticker example and related test expectations; runtime control logic is unchanged.

Coverage includes selected-screen enforcement, no global reset, stop-generation races, stale request cancellation, persistent halt after uncertain errors, selective restore validation, bounded market/weather responses, cache freshness, native weather layout geometry, explicit setup opt-in, and credential redaction. Migration copies only local connection values, refuses overwrite, creates mode 0600, and leaves device writes disabled.

The public repository excludes real configuration, credentials, runtime state, caches, provider snapshots, layout exports, logs and installed dependencies. The only environment file is a blank-credential example. Private addresses and credential sentinels inside tests are synthetic. Weather geography is a fixed public Singapore example, not a user's detected location. No portfolio, brokerage account or trading data is included.

## Verification limits

- No actual Docker build or arm64 container startup was performed in this build environment; Docker was unavailable. COPY-equivalent source staging and locked offline dependency installation were checked on the baseline.
- No physical-device execution was performed here. Native weather rendering, firmware compatibility, Pi CPU/memory behavior and image transitions remain hardware-unverified. API acknowledgement alone does not prove correct rendering.
- No private Finnhub key was used. Its behavior is covered by mocked tests; provider entitlements, rate limits and availability can vary.
- No TypeScript static compiler pass or completed dependency-vulnerability audit is claimed.
- Clear/upload is non-atomic. Outages may freeze physical images; undocumented shared firmware effects cannot be ruled out.

Public data is informational and may be delayed, incomplete or stale. This package does not trade or access brokerage holdings. Existing third-party notices are retained; no new project licence is granted by this publication.
