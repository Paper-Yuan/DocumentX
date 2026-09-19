# Changelog

All notable changes to SafeDrop will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### 🐛 Fixed — Pairing desync between the two ends

- **The on-screen PIN and QR code now track the hub.** The hub rotates the PIN and one-time
  token on every successful handshake, but the desktop UI fetched `/api/v1/info` only once at
  startup, so a displayed PIN went stale the moment any device paired — a second device was
  then rejected with `Pairing proof verification failed` even after reading the code off the
  screen correctly. The desktop page now refreshes the pairing payload on a timer, and only
  redraws the QR canvas when the encoded value actually changed.
- **Retired pairing credentials survive a bounded grace window.** Only the single most recent
  previous PIN/token were accepted, so a second pairing inside the 60-second window evicted
  the value still on screen. Up to three retired generations are now accepted, after which a
  credential is refused again — the window stays bounded rather than accepting anything.
- **Sessions expire on inactivity, not on a hard deadline.** The ten-minute limit was measured
  from session creation, so a session could be dropped mid-use and the peer would present an
  id the hub had already forgotten, failing with 401 and forcing a fresh pairing. Expiry is now
  driven by idle time, with an absolute twelve-hour cap, and is enforced on the request path
  as well as in the GC pass.

### 🔒 Fixed — LAN exposure, credential entropy and version drift

Each item below was checked against the code before being changed, and the hub-side changes are
covered by `test_encryption_e2e.js` and `test_qr_and_security.js`.

- **The hub's pairing PIN now comes from the CSPRNG.** It was drawn from `Math.random()` in three
  places in `server.js` — V8's predictable xorshift128+ stream — while the Android side had already
  moved to `SecureRandom`. Both ends now agree.
- **Chat is no longer readable by anyone on the LAN.** `/api/v1/message/send` and
  `/api/v1/messages/list` were the only data endpoints that skipped `ensureAuthorized`, so an
  unpaired host could read the whole history and inject messages. Recorded message text is also no
  longer echoed into the log, where a self-declared sender name could forge lines. Both clients now
  withdraw the optimistically drawn bubble and say why, instead of showing a delivery that failed.
  Re-auditing the endpoint list for this release found one more of the same class:
  `DELETE /api/v1/devices/names/:fingerprint` let an unpaired LAN host wipe custom device names, and
  it is now behind the same guard. The two `/api/v1/settings/*` endpoints were already loopback-only.
- **Cross-origin responses are no longer `*`.** Every page the user visited while the hub was
  running could call the API from the browser; the header is now echoed only for loopback and
  private-LAN origins, with `Vary: Origin`.
- **Credentials no longer ride in a plain-HTTP portal URL.** With TLS unavailable the hub handed out
  `http://…/portal?pin=…&token=…` — a cleartext credential for a page that refuses to pair outside
  a secure context anyway. Over HTTP the link now carries no credentials; over HTTPS unchanged.
- **The phone's QR is a pairing code again.** Android encoded an `http` portal URL with the PIN in
  its query string, which browsers can open but never pair with and which left the scanner with an
  empty fingerprint. It now encodes `safedrop://pair?…&fp=…&pin=…`, and the dialog states that the
  browser portal on a phone needs the HTTPS the phone does not currently serve.
- **`node scripts/version-check.js` keeps the version string honest.** `APP_VERSION` in the hub is
  the single source, and 20 assertions cover the Tauri config, npm manifest, `Cargo.toml` /
  `Cargo.lock`, the Android `versionName`, the three C# assemblies plus their registry display
  version, the changelog header and the README download names. It immediately caught `Cargo.toml`
  at 1.2.0 and `Cargo.lock` at 1.0.1; both are fixed, and CI now fails on future drift.
- **README security claims match the code in both directions.** It said the server does not enforce
  pairing (it does), that reordered chunks are rejected (arrival order is not authenticated), that
  the Android UI is Jetpack Compose (it is ViewBinding), and that resumable transfer had a
  persisted-progress foundation (`.part` is appended in arrival order and progress is never written
  during a transfer). The remaining boundaries — a 6-digit PIN is not a PAKE, chunk completeness,
  the phone's HTTP-only portal — are now listed under *not provided*.

### ⚠️ Breaking — Transfer completion is now authenticated (wire protocol `safedrop-e2e-v2`)

Until now the receiver decided a file was complete because *a chunk claiming to be the last one
arrived*. `X-Chunk-Count` and `X-File-Size` were plain headers, and only the task id and the chunk
index sat inside the AES-GCM AAD, so nothing on the path was forced to honour them: a truncated
transfer, a reordered chunk or a rewritten header produced a silently short or scrambled file that
still carried a valid tag per chunk.

- **The AAD covers the whole chunk geometry.** It is now
  `{protocol}|chunk|{taskId}|{index}|{count}|{chunkSize}`, with the stride travelling in the new
  `X-Chunk-Size` header, so the two values the completion decision is made from cannot be edited
  without breaking the tag. The protocol marker moved to `safedrop-e2e-v2` and a v1 peer is refused
  outright — there is no dual-read, because accepting both formats is the exact window this closes.
  **Released 1.3.0 clients will not interoperate with this build; both ends must update together.**
- **Chunks are written at their position, not appended.** Each accepted plaintext goes to
  `index × chunkSize` in the `.part` file, so arrival order no longer affects the result and a
  replayed chunk overwrites itself instead of duplicating bytes.
- **A file is renamed only after the full authenticated set.** The receiver keeps the digest of
  every accepted chunk and requires indices `0..count-1` to all be present, with the last chunk
  sized consistently with the stride; the byte count is derived from that chunk stream and
  compared against the declared `X-File-Size`, and a mismatch is rejected rather than saved.
- **Retries are idempotent, conflicting retries are refused.** Re-sending the identical chunk after
  a dropped response is accepted and changes nothing; sending different bytes for an index already
  stored returns 409, and so does a second peer claiming the same task id. An index is claimed
  before its write starts rather than after it, so this holds when a retry and the original are in
  flight together rather than one after the other — otherwise the refused copy is the one whose
  bytes end up in the file.
- **A finished file is exactly as long as its chunks add up to.** Positional writing guarantees the
  bytes it wrote and nothing more, so a `.part` left behind by an earlier attempt at the same task
  id — which survives a hub restart, since only the bookkeeping lived in memory — would have had its
  stale tail renamed into the vault along with the new content. The `.part` is now cut to the
  derived size before the rename, and `test_encryption_e2e.js` fails if that ever regresses.
- **Two first chunks of the same task no longer fight over creating the file.** Both used to find
  no `.part`, both asked the filesystem to create it, and the loser's `EEXIST` was treated as a
  storage failure that deleted the winner's in-flight file. It now just reopens.
- **The phone fills each slice before sealing it.** `InputStream.read()` on a `ContentResolver`
  stream may legitimately return less than asked, and under v2 every non-final chunk must carry
  exactly the stride, so one short read aborted a whole transfer. The sender now loops until the
  slice is full or the stream has ended — which also means a 0-byte file transfers instead of
  reporting a success that never happened.
- **A paired peer can no longer upload in plaintext.** Both ends accepted an unsealed upload from
  any holder of a session key, which put the receiver back on the append-and-trust-the-headers path
  the rest of this section removes; the comment in the hub even said that branch was loopback-only.
  It now is, on both ends, and the phone got the same rule.
- **Per-chunk decompression is bounded by the authenticated stride.** The sealed body has always
  been capped, but a few hundred bytes of gzip inflate to as much as the decoder allows, and the
  length check ran only after the whole output was in memory. Over-compressed input is now refused
  mid-inflate, on both ends.
- **Abandoned transfers are cleaned up.** A `.part` whose sender disappeared is removed after an
  hour instead of sitting in the vault forever. The hub sweeps on a one-minute timer; the phone
  gained the same timer, because a sweep that only runs when a chunk arrives never fires for exactly
  the transfers it exists to clean up.
- **The same rules now apply on the receiving phone.** `MobileTransferServer` mirrors the hub's
  positional writes, digest dedupe, completion check, stride-bounded inflate and `.part` cleanup, so
  a transfer that survives one end is not silently corrupt at the other.
- **A version mismatch says so.** The marker is hashed into the key derivation, so two peers on
  different versions already failed each other's proof — but at `/handshake/verify`, which the UI
  reports as "pairing rejected, check the code". Every client now compares the marker the peer
  declares in its handshake response and names the version instead.
- **The transfer history list is bounded.** It had no cap and is serialised into every file-list
  response, so a hub left running for weeks grew one record and one payload byte per transfer,
  forever. Now the newest 200, matching the limit chat already had.

### 🔧 Added — One contract file, generated constants, and CI that can actually fail

The four implementations each carried their own copy of the protocol numbers, which is how the two
ends drifted apart in the first place.

- **`protocol.json` is the single source of truth** for the protocol marker, key/nonce/tag lengths,
  the five AAD and HKDF templates, the pairing and session limits, chunk ceilings, the port numbers
  and every transfer header name. `node scripts/protocol.js gen` writes
  `computer-design/desktop_hub/protocol.gen.js` and `core/crypto/ProtocolConst.kt`; `check` fails on
  drift. The browser portal has to stay a single self-contained file, so its literals are asserted
  against the contract rather than imported, and the check also verifies the Android copy of
  `portal.html` is byte-identical to the hub's, that no file spells a header the contract does not
  define, and that both READMEs name the protocol actually in force.
- **Cross-end golden vectors.** `node scripts/gen-vectors.js` writes `test/vectors/e2e-v2.json`
  from the Node implementation with deterministic nonces; the Node tests and the Kotlin unit tests
  both read that one file, so a passing Kotlin suite means the phone agrees with the hub byte for
  byte — including the ten negative cases (geometry rewrites, tag flip, ciphertext change, nonce
  swap).
- **A real test suite for the parts that had none.** `node --test "test/*.test.js"` runs 23 tests
  over the crypto protocol and the relay guard, and `test_encryption_e2e.js` grew from 37 to 60
  checks — including one that extracts the portal's `SafeDropCrypto` from `portal.html`, executes
  it verbatim in Node against the live hub, and uploads a 21-chunk file at a 64-byte stride; a
  section that races two chunks against each other; and one that proves an unpaired host can
  neither read, write nor wipe device names and chat history. The Kotlin suite runs 14 unit tests
  against the same vectors.
- **CI gates on all of it.** `test-desktop` was a syntax check; it now runs the protocol check, the
  vector reproducibility check, the `node:test` suite and three end-to-end suites on Node 22, next
  to the version-consistency job. `test-android` printed "✅ Android project structure validated"
  without building anything; it now installs Gradle at the pinned version, runs
  `testDebugUnitTest` for real and uploads the report, so the shared vectors are enforced on both
  implementations in CI rather than in theory. (That job is the one change here a local run cannot
  prove: this project commits only the Windows wrapper script, so Linux has to drive Gradle itself.)
- **`lan_guard.js` accepts only canonical dotted-quad IPv4.** `010.1.2.3`-style octets were parsed
  inconsistently between the guard and the socket, which is the kind of gap an SSRF check is
  supposed to close.
- **Android pairing and session limits now follow the contract too**: the one-time token is 12 hex
  characters from `SecureRandom` rather than a truncated UUID, the pairing-failure counter is a
  window plus a block that reports `retry_after_seconds`, sessions expire on idle time under a
  twelve-hour cap, CORS answers per origin instead of `*`, and the phone refuses to serve an
  unencrypted fallback portal page if the bundled one cannot be loaded.

### 🎨 Changed — The interface stops looking like a template

Both ends were rebuilt around one rule: **neutral surfaces carry the structure, colour means state
and nothing else**. It was not only taste — the old look had real defects behind it.

- **The UI no longer needs the internet to draw text.** `index.html` loaded Plus Jakarta Sans and
  `portal.html` loaded *Outfit*, both from `fonts.googleapis.com`. A zero-install page that is meant
  to work on a LAN with no uplink was blocking its own typography on a remote host, and the two
  browser surfaces of one product were using two different typefaces. Webfont links are gone; the
  system UI stack renders identically offline, on Windows and on the phone.
- **One colour system, actually shared.** The desktop was indigo→violet, Android was blue→cyan, and
  `colors.xml` claimed to be "Aligned with desktop" while nothing compared them. Both now resolve
  the same ink + four semantic hues, with the hues lifted for text on dark surfaces so they still
  clear 4.5:1. No brand gradient, no glow ring, no blurred panel survives.
- **The radar is an instrument now.** Thin rings, a crosshair, a restrained sweep, and a green dot
  per peer — the one characterful element on the screen, with everything around it kept quiet.
- **Machine values are monospace with tabular figures**: `ip:port`, sizes, speeds, `3/7` chunk
  counts, pairing codes, fingerprints. They stop re-flowing as digits change width.
- **Jargon moved out of the way, emoji out of the vocabulary.** "UDP 8890 探针与握手通道",
  "X25519 + AES-256-GCM 验签落盘" and the rest now sit behind a 技术细节 disclosure; labels say what
  the user controls ("已接收文件", not "保险箱 (已接收)").
- **Pairing no longer asks you to type into a browser prompt.** The desktop's `window.prompt` is
  replaced by a real dialog that names the device it is asking about, takes a pasted
  `safedrop://pair?…` link (what the phone's QR already encodes) and prefills address and code from
  it, and reports failures inline with the reason — including a version mismatch, which used to
  surface as "check the code". Handshake requests now carry a timeout, so a dead peer cannot hang
  the sheet forever.
- **A failed transfer is recoverable in place**: 重试 on the row, and copy that says what happens
  ("文件还在原来的位置，没有改动。点重试会从头再传一次。"). Previously a failed row had no controls
  at all and the only way out was to start over from the device list.
- **Android pairing sheet** does the same: one monospace field, auto-submit at six digits, paste a
  pairing URI, and it polls the peer so "对方已换新配对码" updates in place instead of telling the
  user to walk over to the other device and press a button.
- **Dead ends closed on Android**: no camera permission used to toast and `finish()`, dumping the
  user back at the main screen — it now offers the system setting or the pairing code instead; file
  selection is multi-select like the desktop; a finished download says where the file went.
- **Two controls that lied were removed.** `autoAcceptToggle` was never read by any code, and the
  theme swatches' `✓` prefix widened the selected button and shoved its neighbours sideways —
  selection is the border, plus a screen-reader suffix.

### 🐛 Fixed — Found while rebuilding the interface

- **Six Android strings existed only in `values-zh/`.** The default `values/strings.xml` is Chinese,
  so a Chinese phone never noticed — but on any other system locale, reaching a code path that read
  one of them (e.g. "找不到对方设备") threw `ResourceNotFoundException`. The duplicate
  `values-zh/` and `values-zh-rCN/` folders are gone and the app has one strings file; the two
  folders had 108 keys overlapping the default, one of which had already drifted, and `values-zh-rCN`
  was byte-for-byte the same list as `values-zh`.
- **Device cards clipped their own content.** A grid item defaults to `min-width: auto`, so a card
  whose address and fingerprint chips could not shrink forced its track wider and pushed the next
  card past the container; the meta row then sliced the fingerprint chip mid-glyph. Tracks can now
  shrink and the chips wrap onto a second line.
- The drop zone said "选择文件" twice — as the heading and as the button.

### Planned
- Resumable file transfer with breakpoint continuation — the authenticated chunk set and positional
  writes landed above, so only the persisted progress cursor is left
- Batch download (TAR.GZ) and QR share links with expiry
- macOS and Linux desktop validation on real hardware

---

## [1.3.0] - 2026-09-15

### 🔐 Added — Encrypted transport

- **Payload encryption is now on the transfer path.** Each chunk is sealed with
  AES-256-GCM (`crypto_protocol.js`) and is verified before anything reaches disk; a
  modified tag or a chunk presented under the wrong index is rejected.
- **Phone-to-phone transfers are encrypted end to end.** The sender negotiates a session
  directly with the destination phone and the hub only forwards the sealed bytes, so the
  hub never holds, unwraps, or can read the file content. The destination session id is
  carried separately (`X-Target-Session-Id`) so the hub's own session with the sender is
  never leaked to the receiving device.
- **Relay targets on the hub's own subnet are allowed by default** (`lan_guard.js`), so
  networks that do not use RFC1918 ranges (many home routers, VPN overlays, lab subnets)
  relay without configuration. Loopback, link-local (including cloud metadata
  `169.254.169.254`) and public addresses stay blocked; other subnets need
  `SAFEDROP_RELAY_TARGETS`. The effective scope is printed at startup.
- **Sessions are tracked per peer**, not per app: pairing with one device no longer
  invalidates the session with another, and trust is derived from the live session store
  instead of a set that could claim trust after the session was gone.
- **Pairing secrets never leave the device.** The 6-digit PIN / one-time token is used as
  HKDF input and proven with an HMAC over the derived session key, replacing the previous
  scheme that compared the PIN server-side. Both sides now verify each other's proof.
- **Session enforcement.** Upload, download, vault listing, and device-name endpoints
  require a verified session; only loopback callers are exempt. The Android receiver
  enforces the same rule.
- **Pairing rate limiting** on both the hub and the Android receiver (8 failures from one
  source IP block further attempts).
- **Self-signed HTTPS portal** (`tls_selfsigned.js`). Browsers only expose WebCrypto in a
  secure context, so the portal is served over HTTPS with a certificate generated in pure
  Node (with IP SANs). Without it the portal refuses to pair rather than silently sending
  plaintext.
- **Fixed a real nonce-reuse defect.** The previous nonce was derived deterministically from
  the chunk index, so two files sent in one session would reuse a GCM nonce and leak
  keystream. Nonces are now drawn from `SecureRandom` / `crypto.randomBytes`.
- **Fixed `/health` returning HTML.** It sat outside the `/api/v1` prefix, fell through to
  the static handler, and answered 200 with `index.html`, which also fooled the Tauri
  startup probe.
- **Fixed pairing-secret disclosure.** `/api/v1/info` on both the hub and the Android
  receiver previously returned the PIN and token to any LAN caller, which made the pairing
  step decorative.

### 🔧 Fixed — Packaging
- **The installer no longer ships an incomplete backend.** It copied a hardcoded file list
  (`server.js` plus `public/`), so `crypto_protocol.js`, `lan_guard.js` and
  `tls_selfsigned.js` were absent and an installed build died on first launch with
  `MODULE_NOT_FOUND`. Modules are now discovered from the directory, and the staged payload
  is dependency-checked before packaging, so a missing module fails the build instead of the
  user's install.
- **The installer no longer carries the maintainer's paths.** It shipped
  `desktop_hub/config.json`, which pointed the vault at the build machine's
  `C:\Users\...\Downloads\SafeDrop`. The payload now contains an empty config, and the server
  falls back to the current user's `Downloads/SafeDrop`.
- **A stale configured vault path can no longer abort startup.** `mkdirSync` on a
  missing/unavailable directory is now caught and falls back to the default location.
- **Android release builds support real signing.** `signingConfigs.release` loads a keystore
  from `keystore.properties` (gitignored) or `SAFEDROP_KEYSTORE_*` environment variables, and
  only falls back to the debug key when none is configured. Previously release APKs were
  always signed with the debug key, which is not distributable.
- **Version numbers are consistent.** The Tauri bundle was pinned at 1.1.0, Android at
  1.0.2, and `/api/v1/ping` reported 1.0.1; all now report 1.3.0 from a single
  `APP_VERSION` constant.
- **Tauri CSP allows the UI to reach its own backend.** `connect-src` only permitted
  `http://localhost:8899`, which conflicted with the port the frontend is served from, and
  Google Fonts were not allowed at all.

---

## [1.2.0] - 2026-09-14

### ✨ Features

- **Transfer queue with concurrency**: up to 3 files transfer simultaneously, remaining
  tasks queue automatically; queue position is surfaced in the UI and a failure in one
  task does not affect the others
- **Fingerprint-based persistent device naming**: device identity derives from a SHA-256
  fingerprint of the public key, so custom names survive IP changes and reconnections
- **Optional gzip compression**: automatically applied to common compressible file types
  of 1 MB or larger, compressed client-side and decompressed server-side; toggleable in settings
- **Corporate Trust visual system**: Indigo/Violet theme with revised hierarchy

### ⚡ Performance

- **Desktop chunk size raised from 1 MB to 4 MB**, reducing per-chunk protocol overhead
  for large files (the Android client continues to use 1 MB chunks)
- Improved chunk processing and buffering

### 📱 Android

- Material 3 touch-target compliance (all interactive elements ≥ 48dp)
- Layout and theme adaptation improvements, better handling of rotation and varied screen sizes

### 📚 Documentation

- v1.2.0 optimization report and mobile optimization documentation added

---

## [1.1.0] - 2026-09-14

### 🚀 Performance Improvements

#### Desktop
- **Startup Speed**: Reduced from 2-5 seconds to 0.5-1 second (80% improvement)
  - Parallel initialization: backend and window load concurrently
  - Non-blocking health check thread
  - HTTP-based health endpoint (`/health`) for faster verification
  
#### Android
- **Background Transfer Stability**: Success rate improved from 60% to 95%+
  - Triple keep-alive mechanism implementation
  - Optimized for major Chinese OEM devices (OPPO, VIVO, Xiaomi)
  - 30-second heartbeat prevents service termination

### ✨ New Features

#### System Tray (Desktop)
- Minimize to system tray instead of taskbar
- Left-click to toggle window visibility
- Right-click menu with Show/Hide/Quit options
- Native exit confirmation dialog (Windows/macOS/Linux)

#### Global Shortcuts (Desktop)
- `Ctrl+Shift+S` (Windows/Linux) / `Cmd+Shift+S` (macOS): Toggle window
- `Ctrl+Shift+Q` / `Cmd+Shift+Q`: Quick send file
- `Ctrl+Shift+R` / `Cmd+Shift+R`: Refresh device list
- Works when app is in background

#### Android Battery Optimization
- User-friendly battery optimization guidance dialog
- Manufacturer-specific instructions (OPPO/VIVO/Xiaomi)
- Remember user choice (Don't show again)
- One-tap jump to system settings

### 🔧 Technical Changes

#### Desktop
- Migrated from C# launcher to Tauri 2.0 framework
- Added dependencies: `tokio` (async runtime), `reqwest` (HTTP client)
- Implemented `WindowBuilder::build()` for immediate window display
- Cross-platform dialog support using native system APIs

#### Android
- Added permissions:
  - `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`
  - `WAKE_LOCK`
- Implemented `PowerManager.WakeLock` with 10-minute timeout
- Foreground service heartbeat system (30-second intervals)
- Version code bump: 1 → 2

#### Backend
- New endpoint: `GET /health` for lightweight health checks
- Transfer progress storage architecture (for future resumable uploads)
- Persistent progress file system

### 📚 Documentation
- Complete testing validation plan with checklists
- Test results report (92.9/100 comprehensive score)
- Optimization roadmap through v1.5.0
- Global shortcuts user guide
- Week 2 optimization status tracking

### 🐛 Bug Fixes
- Fixed Tauri 2.0 API compatibility issues
- Resolved startup blocking issue
- Fixed Android background transfer interruption
- Corrected system tray menu display on high-DPI screens

### 💔 Breaking Changes
None. This is a drop-in replacement for v1.0.x.

### 🔄 Migration Guide
No migration steps required. Simply install v1.1.0 over v1.0.x.

Android users will see a one-time battery optimization prompt on first transfer.

---

## [1.0.1] - 2026-09-05

### Fixed
- Minor security vulnerability fixes
- Improved error handling in transfer pipeline
- UI responsiveness improvements

---

## [1.0.0] - 2026-08-30

### Initial Release

#### Core Features
- **Zero-configuration LAN discovery** via mDNS and multicast
- **End-to-end encryption** with X25519 key exchange + AES-256-GCM
- **1MB chunked streaming** for large file transfers
- **60fps radar animation** with dynamic device visualization
- **Three-theme system**: Dark, Eye-care, Light
- **Out-of-band QR code pairing** with 6-digit PIN
- **Web portal** for browser-based access

#### Supported Platforms
- Desktop: Windows 10/11 (x64)
- Mobile: Android 7.0+ (API 24+)
- Web: Modern browsers (Chrome, Firefox, Safari, Edge)

#### Technical Stack
- Desktop Hub: Node.js 18+ with zero npm dependencies
- Desktop UI: Tauri 2.0 + HTML5 + CSS3 + Vanilla JS
- Android: Kotlin + Jetpack Compose
- Crypto: X25519 (libsodium), AES-256-GCM, HKDF-SHA256
- Network: Native HTTP, UDP multicast, mDNS

#### Documentation
- Complete architecture documentation
- Security audit matrix
- Quick start guide
- API reference

---

## Legend

- 🚀 **Performance**: Speed, memory, or efficiency improvements
- ✨ **New Features**: New user-facing functionality
- 🔧 **Technical**: Under-the-hood changes, refactoring, or infrastructure
- 📚 **Documentation**: Docs, comments, or guides
- 🐛 **Bug Fixes**: Resolved issues
- 💔 **Breaking Changes**: Changes requiring user action
- 🔄 **Migration**: Upgrade instructions
- 🔒 **Security**: Security-related changes
- ⚠️ **Deprecated**: Features being phased out

---

[Unreleased]: https://github.com/Paper-Yuan/DocumentX/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Paper-Yuan/DocumentX/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/Paper-Yuan/DocumentX/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/Paper-Yuan/DocumentX/releases/tag/v1.0.0
